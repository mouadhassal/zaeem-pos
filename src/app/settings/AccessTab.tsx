import { useEffect, useState } from "react";
import { realErrorText } from "../../lib/errors";
import { invoke } from "../../lib/invoke";
import { useAccessStore } from "../../stores/accessStore";
import { useAuthStore } from "../../stores/authStore";
import {
  ACCESS_FEATURES, ACCESS_ROLES, cellOf, getRoleAccess, getStaffAccess, saveRoleAccess, saveStaffAccess, withCell, withPersonCell,
  type AccessCell, type PersonCell,
} from "../../lib/roleAccess";

interface StaffLite { id: string; name: string; role: string; is_active: number; app_access: boolean; job_title: string | null }

const ROLE_LABEL: Record<string, string> = { MANAGER: "مدير", CASHIER: "كاشير", KITCHEN: "مطبخ", SERVER: "كاشير" };

function Switch({ on, onClick, label, testid }: { on: boolean; onClick: () => void; label: string; testid: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testid}
      onClick={onClick}
      dir="ltr"
      className={`inline-flex w-11 h-6 rounded-full items-center px-0.5 transition-colors ${on ? "bg-saffron-600 justify-end" : "bg-ink-200 justify-start"}`}
    >
      <span className="w-5 h-5 rounded-full bg-white shadow" />
    </button>
  );
}

/**
 * Settings > الصلاحيات (owner only): who may open which part of the system, and which till actions
 * they may do. Per role first, then exceptions for one person ("Ahmad is a cashier but may refund").
 * The server enforces all of it (role_access.rs); the sidebar follows. The owner is never restricted,
 * and selling and taking payment are never switched off.
 */
export default function AccessTab() {
  const [cells, setCells] = useState<AccessCell[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [people, setPeople] = useState<StaffLite[]>([]);
  const [personId, setPersonId] = useState("");
  const [personCells, setPersonCells] = useState<PersonCell[] | null>(null);

  useEffect(() => {
    getRoleAccess().then(setCells).catch((e) => setError(realErrorText(e)));
    invoke<StaffLite[]>("list_staff_v3", { sessionToken: useAuthStore.getState().token })
      .then((rows) => setPeople(rows.filter((p) => p.app_access && p.is_active === 1 && p.role !== "OWNER" && p.role !== "PLATFORM")))
      .catch(() => setPeople([]));
  }, []);

  useEffect(() => {
    setPersonCells(null);
    if (!personId) return;
    getStaffAccess(personId).then(setPersonCells).catch((e) => setError(realErrorText(e)));
  }, [personId]);

  const toggle = async (role: string, feature: string, allowed: boolean) => {
    if (!cells) return;
    const before = cells;
    const next = withCell(cells, role, feature, allowed);
    setCells(next);
    setError(null);
    setSaved(false);
    try {
      await saveRoleAccess(next);
      setSaved(true);
      // This till's own sidebar follows at once; other tills pick it up within half a minute.
      void useAccessStore.getState().load();
    } catch (e) {
      setCells(before);
      setError(realErrorText(e));
    }
  };

  const setPerson = async (feature: string, allowed: boolean | null) => {
    if (!personCells || !personId) return;
    const before = personCells;
    const next = withPersonCell(personCells, feature, allowed);
    setPersonCells(next);
    setError(null);
    setSaved(false);
    try {
      await saveStaffAccess(personId, next);
      setSaved(true);
    } catch (e) {
      setPersonCells(before);
      setError(realErrorText(e));
    }
  };

  const person = people.find((p) => p.id === personId);
  const roleKey = person ? (person.role === "SERVER" ? "CASHIER" : person.role) : "";
  const groups: { title: string; till: boolean }[] = [
    { title: "الصفحات", till: false },
    { title: "أعمال الصندوق", till: true },
  ];

  return (
    <div className="space-y-5 max-w-3xl" data-testid="access-tab">
      <div>
        <h2 className="text-lg font-bold text-ink-900 font-arabic">الصلاحيات: من يفتح ماذا</h2>
        <p className="text-xs text-ink-500 font-arabic mt-1 leading-6">
          لكل مطعم أو متجر طريقته. اختر لكل دور ما يستطيع فتحه وما يستطيع فعله على الصندوق، ثم استثناءات لموظف بعينه إن أردت.
          أنت (المالك) تفتح كل شيء دائماً، والبيع والدفع لا يُغلقان عن أي دور. التغيير يسري فوراً على هذا الجهاز وخلال نصف دقيقة على بقية الأجهزة.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 font-arabic" data-testid="access-error">{error}</p>}
      {saved && !error && <p className="text-sm text-green-700 font-arabic" data-testid="access-saved">تم الحفظ</p>}

      {!cells ? (
        !error && <p className="text-sm text-ink-400 font-arabic">جاري التحميل...</p>
      ) : (
        <div className="bg-white rounded-md border border-ink-200 overflow-hidden">
          <table className="w-full text-sm font-arabic">
            <thead>
              <tr className="bg-surface-alt text-ink-500 text-xs">
                <th className="text-right px-4 py-3 font-bold">حسب الدور</th>
                {ACCESS_ROLES.map((r) => (
                  <th key={r.key} className="px-3 py-3 font-bold text-center w-24">{r.label}</th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.title}>
                <tr className="border-t border-ink-200 bg-ink-50"><td colSpan={ACCESS_ROLES.length + 1} className="px-4 py-2 text-xs font-bold text-ink-500">{g.title}</td></tr>
                {ACCESS_FEATURES.filter((f) => (f.group === "till") === g.till).map((f) => (
                  <tr key={f.key} className="border-t border-ink-100">
                    <td className="px-4 py-3">
                      <span className="block text-ink-900">{f.label}</span>
                      <span className="block text-xs text-ink-400">{f.hint}</span>
                    </td>
                    {ACCESS_ROLES.map((r) => {
                      if (f.onlyRoles && !f.onlyRoles.includes(r.key)) return <td key={r.key} className="px-3 py-3 text-center text-ink-300">—</td>;
                      const on = cellOf(cells, r.key, f.key);
                      return (
                        <td key={r.key} className="px-3 py-3 text-center">
                          <Switch on={on} onClick={() => void toggle(r.key, f.key, !on)} label={`${f.label} — ${r.label}`} testid={`access-${r.key}-${f.key}`} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3" data-testid="access-person">
        <div>
          <h3 className="font-arabic font-bold text-ink-900">حسب الموظف (استثناءات)</h3>
          <p className="text-xs text-ink-500 font-arabic mt-1">مثال: أحمد كاشير لكن تسمح له بالاسترداد، أو مدير لا تريده أن يعطي خصماً. «كدوره» يعني ما حددته لدوره في الجدول أعلاه.</p>
        </div>
        <select
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          className="h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600 w-full max-w-xs"
          data-testid="access-person-select"
        >
          <option value="">اختر موظفاً...</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name} — {ROLE_LABEL[p.role] ?? p.role}{p.job_title ? ` (${p.job_title})` : ""}</option>)}
        </select>
        {person && personCells && cells && (
          <div className="divide-y divide-ink-100">
            {ACCESS_FEATURES.filter((f) => !f.onlyRoles || f.onlyRoles.includes(roleKey)).map((f) => {
              const mine = personCells.find((c) => c.feature === f.key)?.allowed ?? null;
              const asRole = cellOf(cells, roleKey, f.key);
              const choices: { v: boolean | null; label: string }[] = [
                { v: null, label: `كدوره (${asRole ? "مسموح" : "ممنوع"})` },
                { v: true, label: "مسموح" },
                { v: false, label: "ممنوع" },
              ];
              return (
                <div key={f.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="font-arabic text-sm text-ink-900">{f.label}</span>
                  <div className="flex gap-1" role="radiogroup" aria-label={f.label}>
                    {choices.map((c) => (
                      <button
                        key={String(c.v)}
                        type="button"
                        role="radio"
                        aria-checked={mine === c.v}
                        onClick={() => void setPerson(f.key, c.v)}
                        data-testid={`access-person-${f.key}-${c.v === null ? "role" : c.v ? "on" : "off"}`}
                        className={`h-8 px-3 rounded-sm border-2 text-xs font-arabic ${mine === c.v ? "border-saffron-600 bg-saffron-50 text-saffron-700 font-bold" : "border-ink-200 text-ink-600 hover:border-saffron-400"}`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
