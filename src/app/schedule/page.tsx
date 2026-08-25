import { useEffect, useState, useCallback, useMemo } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { z } from "zod";
import { useAuthStore } from "../../stores/authStore";
import { IconChevronRight, IconChevronLeft, IconPlus, IconX, IconTrash } from "@tabler/icons-react";
import DatePicker from "../../components/ui/DatePicker";
import { toLocalDateStr, formatArabicDate } from "../../lib/dateLocal";

// HR_AND_GENERALIZATION_PLAN.md Part A -- a manager's calendar of who's
// scheduled to work when. Deliberately named "roster" everywhere (matches
// Rust's roster_entry/ManageRoster), never "shift" -- /shift already means
// the cash-drawer open/close session, a completely different concept.

interface StaffOption {
  id: string;
  name: string;
  role: string;
  role_rank: number;
  branch_id: string | null;
  is_active: number;
  created_at: string;
}

interface RosterEntry {
  id: string;
  staff_id: string;
  staff_name: string;
  work_date: string; // 'YYYY-MM-DD'
  start_time: string; // 'HH:MM'
  end_time: string;
  notes: string | null;
}

const DAY_NAMES = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];

const entrySchema = z.object({
  staffId: z.string().min(1, "اختر الموظف"),
  workDate: z.string().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "وقت غير صالح"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "وقت غير صالح"),
  notes: z.string(),
});
type EntryForm = z.infer<typeof entrySchema>;

// 2026-08-22 QA re-audit: this used to be a local `d.toISOString().slice(0,
// 10)` -- see lib/dateLocal.ts's doc comment for the full root cause
// (confirmed live: a shift saved for the picked date 25/08 rendered under
// the column visually labeled 26/08). Now shares the one fixed
// implementation with finance/reports/staff instead of a second local copy
// that could drift back out of sync.
const toDateStr = toLocalDateStr;

// Gulf/Saudi convention -- week starts Saturday. Finds the most recent
// Saturday at or before `from`.
function startOfWeek(from: Date): Date {
  const d = new Date(from);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day + 1) % 7; // days since last Saturday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function SchedulePage() {
  const token = useAuthStore((s) => s.token);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [branches, setBranches] = useState<[string, string][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<EntryForm>({ staffId: "", workDate: "", startTime: "09:00", endTime: "17:00", notes: "" });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  }), [weekStart]);

  const weekEnd = days[6];

  const fetchStaff = useCallback(async () => {
    try {
      const rows = await invoke<StaffOption[]>("list_staff_v3", { sessionToken: token });
      setStaff(rows.filter((s) => s.is_active));
    } catch (err) {
      setError(`حدث خطأ في تحميل الموظفين: ${realErrorText(err)}`);
    }
  }, [token]);

  // 2026-08-13: a multi-branch Owner sees every branch's staff mixed into
  // one table with no indication of who works where -- and the backend
  // now correctly rejects scheduling a staff member under a branch they
  // don't belong to (create_roster_entry_v3's new StaffBranchMismatch
  // check). Showing the branch name here is what lets an Owner avoid
  // hitting that rejection in the first place, not just see it after the
  // fact. Degrades to nothing (no branches state fetched into UI) on a
  // single-branch install, same "no picker needed" convention staff/
  // page.tsx already established.
  const fetchBranches = useCallback(async () => {
    try {
      const rows = await invoke<[string, string][]>("list_branches_v3", { sessionToken: token });
      setBranches(rows);
    } catch {
      // Single-branch/pre-activation installs: no picker, no labels.
    }
  }, [token]);
  const branchName = useCallback(
    (branchId: string | null) => (branchId ? branches.find(([id]) => id === branchId)?.[1] ?? null : null),
    [branches]
  );

  const fetchEntries = useCallback(async () => {
    try {
      const rows = await invoke<RosterEntry[]>("list_roster_entries_v3", {
        sessionToken: token,
        dateFrom: toDateStr(weekStart),
        dateTo: toDateStr(weekEnd),
      });
      setEntries(rows);
    } catch (err) {
      setError(`حدث خطأ في تحميل الجدول: ${realErrorText(err)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, weekStart]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchStaff(), fetchEntries(), fetchBranches()]).finally(() => setLoading(false));
  }, [fetchStaff, fetchEntries, fetchBranches]);

  function openAdd(staffId: string, workDate: string) {
    setEditId(null);
    setForm({ staffId, workDate, startTime: "09:00", endTime: "17:00", notes: "" });
    setFormErrors({});
    setModalOpen(true);
  }

  function openEdit(entry: RosterEntry) {
    setEditId(entry.id);
    setForm({ staffId: entry.staff_id, workDate: entry.work_date, startTime: entry.start_time, endTime: entry.end_time, notes: entry.notes ?? "" });
    setFormErrors({});
    setModalOpen(true);
  }

  async function saveEntry() {
    const parsed = entrySchema.safeParse(form);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[issue.path[0] as string] = issue.message;
      setFormErrors(errs);
      return;
    }
    if (parsed.data.endTime <= parsed.data.startTime) {
      setFormErrors({ endTime: "وقت النهاية يجب أن يكون بعد وقت البداية" });
      return;
    }
    setSaving(true);
    try {
      if (editId) {
        await invoke("update_roster_entry_v3", {
          sessionToken: token, id: editId, workDate: parsed.data.workDate,
          startTime: parsed.data.startTime, endTime: parsed.data.endTime, notes: parsed.data.notes || null,
        });
      } else {
        await invoke("create_roster_entry_v3", {
          sessionToken: token, staffId: parsed.data.staffId, workDate: parsed.data.workDate,
          startTime: parsed.data.startTime, endTime: parsed.data.endTime, notes: parsed.data.notes || null,
        });
      }
      setModalOpen(false);
      await fetchEntries();
    } catch (err) {
      setFormErrors({ _form: realErrorText(err) });
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry() {
    if (!editId) return;
    setSaving(true);
    try {
      await invoke("delete_roster_entry_v3", { sessionToken: token, id: editId });
      setModalOpen(false);
      await fetchEntries();
    } catch (err) {
      setFormErrors({ _form: realErrorText(err) });
    } finally {
      setSaving(false);
    }
  }

  function entriesFor(staffId: string, dateStr: string): RosterEntry[] {
    return entries.filter((e) => e.staff_id === staffId && e.work_date === dateStr);
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  if (error && staff.length === 0) {
    return <div className="flex items-center justify-center h-full text-red-500 font-arabic">{error}</div>;
  }

  return (
    <div className="bg-canvas p-6 space-y-4 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-ink-900">جدول الدوام</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() - 7); return d; })}
            className="w-9 h-9 flex items-center justify-center rounded-sm border border-ink-200 hover:bg-saffron-50 text-ink-500"
            aria-label="الأسبوع السابق"
          >
            <IconChevronRight className="w-4 h-4" />
          </button>
          <span className="text-sm font-arabic text-ink-900 font-medium px-2 whitespace-nowrap">
            {formatArabicDate(weekStart, { day: "numeric", month: "short" })} — {formatArabicDate(weekEnd, { day: "numeric", month: "short" })}
          </span>
          <button
            onClick={() => setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() + 7); return d; })}
            className="w-9 h-9 flex items-center justify-center rounded-sm border border-ink-200 hover:bg-saffron-50 text-ink-500"
            aria-label="الأسبوع التالي"
          >
            <IconChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setWeekStart(startOfWeek(new Date()))}
            className="h-9 px-3 rounded-sm border border-ink-200 hover:bg-saffron-50 text-ink-500 text-xs font-arabic"
          >
            هذا الأسبوع
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-500 font-arabic">{error}</div>}

      {staff.length === 0 ? (
        <div className="zc-card p-8 text-center text-ink-500 font-arabic">لا يوجد موظفون نشطون لعرض جدولهم</div>
      ) : (
        <div className="zc-card overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-alt border-b border-ink-200 text-ink-400 font-arabic">
                <th className="text-right p-3 font-medium sticky right-0 bg-surface-alt min-w-[140px]">الموظف</th>
                {days.map((d, i) => (
                  <th key={i} className="text-center p-2 font-medium min-w-[120px]">
                    <div>{DAY_NAMES[i]}</div>
                    <div className="text-[11px] text-ink-400 font-normal">{formatArabicDate(d, { day: "numeric", month: "numeric" })}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className="border-b border-ink-200 hover:bg-saffron-50/40">
                  <td className="p-3 font-arabic text-ink-900 font-medium sticky right-0 bg-white">
                    {s.name}
                    {branches.length > 1 && branchName(s.branch_id) && (
                      <div className="text-[10px] text-ink-400 font-normal">{branchName(s.branch_id)}</div>
                    )}
                  </td>
                  {days.map((d, i) => {
                    const dateStr = toDateStr(d);
                    const dayEntries = entriesFor(s.id, dateStr);
                    return (
                      <td key={i} className="p-1.5 align-top">
                        <div className="space-y-1">
                          {dayEntries.map((e) => (
                            <button
                              key={e.id}
                              onClick={() => openEdit(e)}
                              className="w-full text-right px-2 py-1 rounded-sm bg-saffron-100 text-saffron-700 text-[11px] font-arabic hover:bg-saffron-200 transition-colors"
                              dir="ltr"
                            >
                              {e.start_time}–{e.end_time}
                            </button>
                          ))}
                          <button
                            onClick={() => openAdd(s.id, dateStr)}
                            className="w-full flex items-center justify-center py-1 rounded-sm border border-dashed border-ink-200 text-ink-400 hover:border-saffron-400 hover:text-saffron-600 transition-colors"
                            aria-label="إضافة دوام"
                          >
                            <IconPlus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">{editId ? "تعديل دوام" : "إضافة دوام"}</h2>
              <button onClick={() => setModalOpen(false)} className="text-ink-400 hover:text-ink-900">
                <IconX className="w-5 h-5" />
              </button>
            </div>

            {formErrors._form && <p className="text-xs text-red-500 font-arabic">{formErrors._form}</p>}

            <div className="space-y-3">
              {!editId && (
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">الموظف *</label>
                  <select
                    value={form.staffId}
                    onChange={(e) => setForm((p) => ({ ...p, staffId: e.target.value }))}
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                  >
                    <option value="">اختر...</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}{branches.length > 1 && branchName(s.branch_id) ? ` -- ${branchName(s.branch_id)}` : ""}
                      </option>
                    ))}
                  </select>
                  {formErrors.staffId && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.staffId}</p>}
                </div>
              )}

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">التاريخ *</label>
                <DatePicker
                  value={form.workDate}
                  onChange={(v) => setForm((p) => ({ ...p, workDate: v }))}
                  className="w-full h-10 px-4 pl-10 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                  dir="ltr"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">من *</label>
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setForm((p) => ({ ...p, startTime: e.target.value }))}
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                    dir="ltr"
                  />
                  {formErrors.startTime && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.startTime}</p>}
                </div>
                <div>
                  <label className="block text-sm font-arabic text-ink-900 mb-1">إلى *</label>
                  <input
                    type="time"
                    value={form.endTime}
                    onChange={(e) => setForm((p) => ({ ...p, endTime: e.target.value }))}
                    className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                    dir="ltr"
                  />
                  {formErrors.endTime && <p className="text-xs text-red-500 mt-1 font-arabic">{formErrors.endTime}</p>}
                </div>
              </div>

              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">ملاحظات</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  className="w-full h-10 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                  placeholder="اختياري"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setModalOpen(false)}
                className="h-10 px-4 rounded-sm border border-ink-200 text-ink-500 text-sm font-arabic hover:bg-surface-alt transition-colors"
              >
                إلغاء
              </button>
              {editId && (
                <button
                  onClick={deleteEntry}
                  disabled={saving}
                  aria-label="حذف"
                  className="h-10 w-10 flex items-center justify-center rounded-sm border border-red-200 text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  <IconTrash className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={saveEntry}
                disabled={saving}
                className="flex-1 h-10 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                {saving ? "جارٍ الحفظ..." : "حفظ"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
