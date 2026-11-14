import { useState } from "react";
import { IconPencil, IconPlus, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useAccessStore } from "../../stores/accessStore";
import { JOB_TITLE_SUGGESTIONS } from "../../lib/workforce";

export interface WorkerRow {
  id: string;
  name: string;
  branch_id: string | null;
  is_active: number;
  job_title: string | null;
}

interface Props {
  workers: WorkerRow[];
  branches: [string, string][];
  onChanged: () => void;
}

/**
 * Staff > العمال بدون تطبيق: cleaners, guards, dishwashers... people who never touch the app but are
 * paid, given advances, and clock in (fingerprint or by hand). No PIN, no role, they can never sign
 * in. Only the owner adds them, unless the owner opened it to managers (Settings > الصلاحيات).
 */
export default function WorkersPanel({ workers, branches, onChanged }: Props) {
  const role = useAuthStore((s) => s.user?.role);
  const workersOpen = useAccessStore((s) => s.features?.workers === true);
  const canManage = role === "OWNER" || (role === "MANAGER" && workersOpen);
  const [form, setForm] = useState<{ id: string | null; name: string; title: string; branch: string; active: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (w?: WorkerRow) =>
    setForm(w
      ? { id: w.id, name: w.name, title: w.job_title ?? "", branch: w.branch_id ?? "", active: w.is_active === 1 }
      : { id: null, name: "", title: "", branch: branches[0]?.[0] ?? "", active: true });

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) { setError("اكتب اسم العامل"); return; }
    setBusy(true);
    setError(null);
    const token = useAuthStore.getState().token;
    try {
      if (form.id) {
        await invoke("update_worker_v3", { sessionToken: token, staffId: form.id, name: form.name, jobTitle: form.title || null, isActive: form.active });
      } else {
        await invoke("create_worker_v3", { sessionToken: token, name: form.name, jobTitle: form.title || null, targetBranchId: form.branch || null });
      }
      setForm(null);
      onChanged();
    } catch (e) {
      setError(realErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const input = "h-10 px-3 rounded-sm bg-white border-2 border-ink-200 font-arabic text-sm outline-none focus:border-saffron-600";

  return (
    <div className="zc-card p-4 space-y-3" data-testid="workers-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-arabic font-bold text-ink-900">العمال بدون تطبيق</h2>
          <p className="text-xs text-ink-500 font-arabic mt-0.5">عمال النظافة والحراس والجلي وغيرهم: لا يدخلون التطبيق، لكن لهم راتب وسلف وحضور (بالبصمة أو يدوياً) ويظهرون في الرواتب وجدول الدوام.</p>
        </div>
        {canManage && (
          <button onClick={() => open()} className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 shrink-0 inline-flex items-center gap-1" data-testid="worker-add">
            <IconPlus className="w-4 h-4" /> عامل بدون تطبيق
          </button>
        )}
      </div>
      {!canManage && role === "MANAGER" && (
        <p className="text-xs text-ink-400 font-arabic">إضافة العمال للمالك فقط. يمكنه السماح لك من الإعدادات ← الصلاحيات ← «العمال بدون تطبيق».</p>
      )}

      {form && (
        <div className="rounded-md border-2 border-saffron-600 p-4 space-y-3" data-testid="worker-form">
          <div className="flex items-center justify-between">
            <h3 className="font-arabic font-bold text-ink-900">{form.id ? "تعديل عامل" : "عامل جديد"}</h3>
            <button onClick={() => setForm(null)} className="p-1 text-ink-500" aria-label="إغلاق"><IconX className="w-5 h-5" /></button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-ink-500 font-arabic">الاسم</span>
              <input className={`${input} w-full`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="worker-name" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-ink-500 font-arabic">المسمى الوظيفي</span>
              <input className={`${input} w-full`} list="job-title-suggestions" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="عامل نظافة، حارس..." data-testid="worker-title" />
            </label>
            {!form.id && role === "OWNER" && branches.length > 1 && (
              <label className="space-y-1">
                <span className="text-xs text-ink-500 font-arabic">الفرع</span>
                <select className={`${input} w-full`} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                  {branches.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
            )}
            {form.id && (
              <label className="flex items-center gap-2 text-sm font-arabic text-ink-700 self-end h-10">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> ما زال يعمل
              </label>
            )}
          </div>
          {error && <p className="text-sm text-danger font-arabic" data-testid="worker-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setForm(null)} className="h-10 px-5 rounded-sm bg-ink-100 text-ink-700 text-sm font-bold">إلغاء</button>
            <button onClick={() => void save()} disabled={busy} className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold disabled:opacity-50" data-testid="worker-save">{busy ? "..." : "حفظ"}</button>
          </div>
        </div>
      )}

      <datalist id="job-title-suggestions">
        {JOB_TITLE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
      </datalist>

      {workers.length === 0 ? (
        <p className="text-sm text-ink-400 font-arabic">لا يوجد عمال بدون تطبيق بعد.</p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {workers.map((w) => (
            <li key={w.id} className={`flex items-center justify-between gap-2 py-2 ${w.is_active ? "" : "opacity-50"}`} data-testid="worker-row">
              <span className="font-arabic text-sm text-ink-900">
                <b>{w.name}</b>
                {w.job_title && <span className="text-ink-500"> — {w.job_title}</span>}
                {!w.is_active && <span className="text-danger text-xs"> (ترك العمل)</span>}
              </span>
              {canManage && (
                <button onClick={() => open(w)} className="p-1.5 rounded-sm text-ink-500 hover:text-saffron-600 hover:bg-saffron-50" title="تعديل" data-testid="worker-edit">
                  <IconPencil className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
