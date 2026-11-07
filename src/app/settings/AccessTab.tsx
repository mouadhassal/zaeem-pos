import { useEffect, useState } from "react";
import { realErrorText } from "../../lib/errors";
import { useAccessStore } from "../../stores/accessStore";
import { ACCESS_FEATURES, ACCESS_ROLES, cellOf, getRoleAccess, saveRoleAccess, withCell, type AccessCell } from "../../lib/roleAccess";

/**
 * Settings > الصلاحيات (owner only): who may open which part of the system. Every shop works differently,
 * so the owner ticks, per role, the areas that role may use. The server enforces it (role_access.rs);
 * the sidebar follows. The owner is never restricted, and selling and taking payment are never switched off.
 */
export default function AccessTab() {
  const [cells, setCells] = useState<AccessCell[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getRoleAccess().then(setCells).catch((e) => setError(realErrorText(e)));
  }, []);

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

  return (
    <div className="space-y-5 max-w-3xl" data-testid="access-tab">
      <div>
        <h2 className="text-lg font-bold text-ink-900 font-arabic">الصلاحيات: من يفتح ماذا</h2>
        <p className="text-xs text-ink-500 font-arabic mt-1 leading-6">
          لكل مطعم أو متجر طريقته. اختر لكل دور ما يستطيع فتحه. أنت (المالك) تفتح كل شيء دائماً، والبيع والدفع لا يُغلقان عن أي دور.
          التغيير يسري فوراً على هذا الجهاز وخلال نصف دقيقة على بقية الأجهزة.
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
                <th className="text-right px-4 py-3 font-bold">المجال</th>
                {ACCESS_ROLES.map((r) => (
                  <th key={r.key} className="px-3 py-3 font-bold text-center w-24">{r.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ACCESS_FEATURES.map((f) => (
                <tr key={f.key} className="border-t border-ink-100">
                  <td className="px-4 py-3">
                    <span className="block text-ink-900">{f.label}</span>
                    <span className="block text-xs text-ink-400">{f.hint}</span>
                  </td>
                  {ACCESS_ROLES.map((r) => {
                    const on = cellOf(cells, r.key, f.key);
                    return (
                      <td key={r.key} className="px-3 py-3 text-center">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${f.label} — ${r.label}`}
                          data-testid={`access-${r.key}-${f.key}`}
                          onClick={() => void toggle(r.key, f.key, !on)}
                          dir="ltr"
                          className={`inline-flex w-11 h-6 rounded-full items-center px-0.5 transition-colors ${on ? "bg-saffron-600 justify-end" : "bg-ink-200 justify-start"}`}
                        >
                          <span className="w-5 h-5 rounded-full bg-white shadow" />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
