import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { tzOffsetMinutes } from "../../lib/assistant";
import { DAY_STATUS_LABEL, WEEKDAYS, monthLabel, type AttendanceReview, type DayLine } from "../../lib/payroll";
import { Field, Hint, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

const STATUS_CLS: Record<string, string> = {
  PRESENT: "text-ok", LATE: "text-warn", ABSENT: "text-danger", OFF: "text-ink-400", OFF_WORKED: "text-saffron-600",
  PAID_LEAVE: "text-ok", MISSING_OUT: "text-warn", PENDING: "text-ink-400", NO_RECORD: "text-ink-400",
};

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00`).getDay()] ?? "";
}

/**
 * One person's month of attendance, day by day: when they came and left, late, early, overtime, absent. The owner or
 * a manager corrects a day that is wrong (the fingerprint failed, a forgotten punch) and presses «اعتماد الحضور».
 * When the owner requires it, the payslip waits for this approval; an approved month no longer changes.
 */
export default function AttendanceReviewModal({ userId, month, onClose, onChanged }: { userId: string; month: string; onClose: () => void; onChanged: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [r, setR] = useState<AttendanceReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixDay, setFixDay] = useState<DayLine | null>(null);
  const [fixAbsent, setFixAbsent] = useState(false);
  const [fixIn, setFixIn] = useState("09:00");
  const [fixOut, setFixOut] = useState("17:00");
  const [fixReason, setFixReason] = useState("");

  const tz = tzOffsetMinutes();
  const load = useCallback(async () => {
    try {
      setError(null);
      setR(await invoke<AttendanceReview>("get_attendance_review_v3", { sessionToken: token, userId, month, tzOffsetMinutes: tz }));
    } catch (err) {
      setError(realErrorText(err));
    }
  }, [token, userId, month, tz]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await load();
      onChanged();
    } catch (err) {
      toast.error(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Modal title="مراجعة الحضور" onClose={onClose}>
        <p className="text-danger font-arabic text-sm" data-testid="review-error">{error}</p>
        <div className="flex justify-end"><button onClick={onClose} className={btnGhost}>إغلاق</button></div>
      </Modal>
    );
  }
  if (!r) return <Modal title="مراجعة الحضور" onClose={onClose}><p className="text-ink-500 font-arabic">جاري التحميل...</p></Modal>;

  const locked = r.approved || r.payslip_locked;
  const overrideOf = (date: string) => r.overrides.find((o) => o.day === date);
  const hours = (min: number) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}` : "");

  const openFix = (d: DayLine) => {
    const o = overrideOf(d.date);
    setFixDay(d);
    setFixAbsent(o?.absent ?? false);
    setFixIn(o?.in_time ?? d.first_in ?? "09:00");
    setFixOut(o?.out_time ?? d.last_out ?? "17:00");
    setFixReason(o?.reason ?? "");
  };

  const stat = (label: string, value: string | number) => (
    <div className="rounded-md border border-ink-200 bg-white p-2.5 text-center">
      <p className="text-[11px] font-arabic text-ink-400">{label}</p>
      <p className="font-mono font-bold text-ink-900">{value}</p>
    </div>
  );

  return (
    <Modal title={`مراجعة حضور ${r.user_name} · ${monthLabel(month)}`} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2 text-xs font-arabic">
        <span className={`px-2 py-0.5 rounded-full ${r.approved ? "bg-ok-100 text-ok-700" : r.required ? "bg-warn-100 text-warn-700" : "bg-white border border-ink-200 text-ink-500"}`} data-testid="review-state">
          {r.approved ? "الحضور معتمد" : r.required ? "بانتظار اعتماد الحضور" : "الاعتماد غير مطلوب"}
        </span>
        {r.payslip_locked && <span className="text-ink-500">راتب هذا الشهر معتمد، لا يمكن تعديل الحضور.</span>}
      </div>
      <Hint summary={locked ? "الحضور مقفل. لتصحيح يوم ألغِ اعتماد الحضور أولاً." : "راجع كل يوم. إن كان خطأ (بصمة معطلة، نسي الخروج) اضغط «تصحيح» وسجّل الوقت الصحيح مع السبب، ثم اضغط «اعتماد الحضور»."}>
        <p>التصحيح لا يمحو سجل البصمات: يبقى كما هو، ويُسجَّل تصحيحك فوقه باسمك وسببه.</p>
        <p>إن فعّل المالك «اعتماد الحضور قبل الراتب» فلا يُعتمد راتب الشهر قبل اعتماد حضوره.</p>
      </Hint>
      {r.warnings.length > 0 && (
        <ul className="rounded-md border border-warn bg-warn-soft p-3 space-y-1 text-sm font-arabic text-ink-900">
          {r.warnings.map((w) => <li key={w}>• {w}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2" data-testid="review-totals">
        {stat("أيام حضور", r.present_days)}
        {stat("أيام غياب", r.absent_days)}
        {stat("أيام تأخير", `${r.late_days} (${r.late_minutes}د)`)}
        {stat("خروج مبكر", `${r.early_minutes}د`)}
        {stat("إضافي", hours(r.overtime_minutes) || "0")}
        {stat("عمل في عطلة", r.extra_days)}
      </div>

      <div className="rounded-md border border-ink-200 max-h-80 overflow-y-auto">
        <table className="w-full text-xs font-arabic">
          <thead className="bg-surface-alt text-ink-400 sticky top-0">
            <tr><th className="text-right p-2">اليوم</th><th className="text-right p-2">الحالة</th><th className="p-2">دخول</th><th className="p-2">خروج</th><th className="p-2">تأخير</th><th className="p-2">مبكر</th><th className="p-2">إضافي</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {r.days.map((d) => (
              <tr key={d.date} className={`border-t border-ink-100 ${d.corrected ? "bg-saffron-50" : ""}`} data-testid={`review-day-${d.date}`}>
                <td className="p-2 whitespace-nowrap"><span className="font-mono" dir="ltr">{d.date.slice(5)}</span> <span className="text-ink-400">{weekday(d.date)}</span></td>
                <td className={`p-2 font-bold ${STATUS_CLS[d.status] ?? "text-ink-700"}`}>
                  {DAY_STATUS_LABEL[d.status]}{d.holiday ? " · عطلة رسمية" : ""}{d.note ? ` · ${d.note}` : ""}
                  {d.corrected && <span className="mr-1 text-saffron-700 font-normal">(مصحَّح: {overrideOf(d.date)?.reason})</span>}
                </td>
                <td className="p-2 text-center font-mono">{d.first_in ?? ""}</td>
                <td className="p-2 text-center font-mono">{d.last_out ?? ""}</td>
                <td className="p-2 text-center font-mono">{d.late_minutes || ""}</td>
                <td className="p-2 text-center font-mono">{d.early_minutes || ""}</td>
                <td className="p-2 text-center font-mono">{d.overtime_minutes || ""}</td>
                <td className="p-2 text-left whitespace-nowrap">
                  {!locked && d.status !== "PENDING" && (
                    <button className="text-saffron-600 font-bold ml-3" disabled={busy} onClick={() => openFix(d)} data-testid={`fix-${d.date}`}>تصحيح</button>
                  )}
                  {!locked && d.corrected && (
                    <button className="text-ink-500" disabled={busy} onClick={() => run(() => invoke("clear_attendance_day_v3", { sessionToken: token, userId, day: d.date }), "أُلغي التصحيح")}>إلغاء التصحيح</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap justify-between gap-3 pt-2 border-t border-ink-100">
        <button onClick={onClose} className={btnGhost}>إغلاق</button>
        <div className="flex gap-3">
          {r.approved && !r.payslip_locked && (
            <button className={btnGhost} disabled={busy} data-testid="review-unapprove"
              onClick={() => run(() => invoke("set_attendance_approval_v3", { sessionToken: token, userId, month, approve: false, tzOffsetMinutes: tz }), "أُلغي اعتماد الحضور")}>إلغاء اعتماد الحضور</button>
          )}
          {!r.approved && (
            <button className={btnPrimary} disabled={busy || r.payslip_locked} data-testid="review-approve"
              onClick={() => run(() => invoke("set_attendance_approval_v3", { sessionToken: token, userId, month, approve: true, tzOffsetMinutes: tz }), "اعتُمد الحضور")}>اعتماد الحضور</button>
          )}
        </div>
      </div>

      {fixDay && (
        <Modal title={`تصحيح يوم ${fixDay.date}`} onClose={() => setFixDay(null)}>
          <label className="flex items-center gap-2 text-sm font-arabic text-ink-900">
            <input type="checkbox" checked={fixAbsent} onChange={(e) => setFixAbsent(e.target.checked)} data-testid="fix-absent" />
            لم يحضر هذا اليوم (غائب)
          </label>
          {!fixAbsent && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="وقت الدخول"><input type="time" value={fixIn} onChange={(e) => setFixIn(e.target.value)} className={inputCls} dir="ltr" data-testid="fix-in" /></Field>
              <Field label="وقت الخروج" hint="اتركه فارغاً إن لم يخرج بعد."><input type="time" value={fixOut} onChange={(e) => setFixOut(e.target.value)} className={inputCls} dir="ltr" data-testid="fix-out" /></Field>
            </div>
          )}
          <Field label="السبب (إجباري)"><input value={fixReason} onChange={(e) => setFixReason(e.target.value)} className={inputCls} data-testid="fix-reason" /></Field>
          <div className="flex justify-end gap-3">
            <button className={btnGhost} onClick={() => setFixDay(null)}>إلغاء</button>
            <button className={btnPrimary} disabled={busy} data-testid="fix-save"
              onClick={() => run(async () => {
                await invoke("set_attendance_day_v3", { sessionToken: token, userId, day: fixDay.date, absent: fixAbsent, inTime: fixAbsent ? null : fixIn || null, outTime: fixAbsent ? null : fixOut || null, reason: fixReason });
                setFixDay(null);
              }, "صُحّح اليوم")}>حفظ التصحيح</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
