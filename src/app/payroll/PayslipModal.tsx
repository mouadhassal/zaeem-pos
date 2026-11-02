import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";
import { tzOffsetMinutes } from "../../lib/assistant";
import { DAY_STATUS_LABEL, monthLabel, PAY_TYPE_LABEL, type DayLine, type Payslip } from "../../lib/payroll";
import { Field, Hint, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

const STATUS_CLS: Record<string, string> = {
  PRESENT: "text-ok", LATE: "text-warn", ABSENT: "text-danger", OFF: "text-ink-400", OFF_WORKED: "text-saffron-600",
  PAID_LEAVE: "text-ok", MISSING_OUT: "text-warn", PENDING: "text-ink-400", NO_RECORD: "text-ink-400",
};

function toLocalInput(day: string, time: string): string {
  return `${day}T${time}`;
}

/** One person's month: where every pound comes from or goes, the days behind it, and what the owner can do about each. */
export default function PayslipModal({ userId, month, onClose, onChanged }: { userId: string; month: string; onClose: () => void; onChanged: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const [p, setP] = useState<Payslip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adjKind, setAdjKind] = useState<"BONUS" | "FINE">("BONUS");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [advAmount, setAdvAmount] = useState("");
  const [advInstalment, setAdvInstalment] = useState("");
  const [advReason, setAdvReason] = useState("");
  const [punchDay, setPunchDay] = useState<string | null>(null);
  const [punchTime, setPunchTime] = useState("17:00");
  const [punchDir, setPunchDir] = useState<"IN" | "OUT">("OUT");
  const [punchReason, setPunchReason] = useState("");

  const tz = tzOffsetMinutes();
  const load = useCallback(async () => {
    try {
      setError(null);
      setP(await invoke<Payslip>("get_payslip_v3", { sessionToken: token, userId, month, tzOffsetMinutes: tz }));
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
      <Modal title="كشف الراتب" onClose={onClose}>
        <p className="text-danger font-arabic text-sm" data-testid="payslip-error">{error}</p>
        <div className="flex justify-end"><button onClick={onClose} className={btnGhost}>إغلاق</button></div>
      </Modal>
    );
  }
  if (!p) {
    return <Modal title="كشف الراتب" onClose={onClose}><p className="text-ink-500 font-arabic">جاري التحميل...</p></Modal>;
  }

  const editable = p.status === "DRAFT";
  const dayCls = (d: DayLine) => STATUS_CLS[d.status] ?? "text-ink-700";

  const row = (label: string, detail: string | null, amount: number, sign: "+" | "-" | "=") => (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-ink-100 font-arabic text-sm">
      <div>
        <p className="text-ink-900">{label}</p>
        {detail && <p className="text-[11px] text-ink-400">{detail}</p>}
      </div>
      <p className={`font-mono shrink-0 ${sign === "-" ? "text-danger" : sign === "+" ? "text-ok" : "text-ink-900 font-bold"}`} dir="ltr">{sign === "=" ? "" : sign}{formatMoney(amount)}</p>
    </div>
  );

  const exportPdf = async () => {
    const body = `
      <h1 style="font-size:22px;font-weight:700;text-align:center;margin:0 0 4px">كشف راتب ${p.user_name}</h1>
      <p style="font-size:11px;color:#667085;text-align:center;margin:0 0 16px">${monthLabel(p.month)}</p>
      ${pdfTableHtml("الراتب", ["البند", "المبلغ"], [
        ["الراتب الأساسي", formatMoney(p.base_cents)],
        ["خصم التأخير", formatMoney(p.late_deduction_cents)],
        ["خصم الغياب", formatMoney(p.absence_deduction_cents)],
        ["خصم الخروج المبكر", formatMoney(p.early_deduction_cents)],
        ["الوقت الإضافي", formatMoney(p.overtime_pay_cents)],
        ["مكافآت", formatMoney(p.bonus_cents)],
        ["غرامات", formatMoney(p.fine_cents)],
        ["المستحق", formatMoney(p.earned_cents)],
        ["قسط السلفة", formatMoney(p.advance_repaid_cents)],
        ["الصافي المدفوع", formatMoney(p.net_cents)],
      ])}`;
    await exportHtmlToPdf(`راتب-${p.user_name}-${p.month}.pdf`, body, token ?? "");
  };

  return (
    <Modal title={`كشف راتب ${p.user_name} · ${monthLabel(p.month)}`} onClose={onClose} wide>
      <div className="flex items-center gap-3 text-xs font-arabic text-ink-500">
        <span>{PAY_TYPE_LABEL[p.pay_type]}</span>
        <span>·</span>
        <span>أجر اليوم {formatMoney(p.day_pay_cents)}</span>
        <span className={`px-2 py-0.5 rounded-full ${p.status === "PAID" ? "bg-ok-100 text-ok-700" : p.status === "APPROVED" ? "bg-saffron-50 text-saffron-700" : "bg-warn-100 text-warn-700"}`} data-testid="payslip-status">
          {p.status === "PAID" ? "مصروف" : p.status === "APPROVED" ? "معتمد" : "مسودة (تتغير مع الحضور)"}
        </span>
      </div>

      {p.warnings.length > 0 && (
        <ul className="rounded-md border border-warn bg-warn-soft p-3 space-y-1 text-sm font-arabic text-ink-900" data-testid="payslip-warnings">
          {p.warnings.map((w) => <li key={w}>• {w}</li>)}
        </ul>
      )}

      <div data-testid="payslip-lines">
        {row("الراتب الأساسي", p.pay_type === "MONTHLY" ? "الراتب الشهري المتفق عليه" : p.pay_type === "DAILY" ? "أجر اليوم × أيام العمل الفعلية" : "أجر الساعة × ساعات العمل الفعلية", p.base_cents, "+")}
        {p.late_deduction_cents > 0 && row("خصم التأخير", `${p.late_days} يوم · ${p.late_minutes} دقيقة`, p.late_deduction_cents, "-")}
        {p.absence_deduction_cents > 0 && row("خصم الغياب", `${p.absent_days} يوم`, p.absence_deduction_cents, "-")}
        {p.early_deduction_cents > 0 && row("خصم الخروج المبكر", `${p.early_minutes} دقيقة`, p.early_deduction_cents, "-")}
        {p.overtime_pay_cents > 0 && row("الوقت الإضافي", `${Math.round(p.overtime_minutes / 6) / 10} ساعة`, p.overtime_pay_cents, "+")}
        {p.bonus_cents > 0 && row("مكافآت", null, p.bonus_cents, "+")}
        {p.fine_cents > 0 && row("غرامات", null, p.fine_cents, "-")}
        {row("المستحق عن الشهر", "هذا ما يُسجَّل مصروفاً (رواتب) عند الصرف", p.earned_cents, "=")}
        {p.advance_repaid_cents > 0 && row("قسط السلفة", "يُخصم من المبلغ المسلَّم لا من المستحق", p.advance_repaid_cents, "-")}
        <div className="flex justify-between items-center pt-3 font-arabic">
          <span className="font-bold text-ink-900">الصافي الذي يُسلَّم للموظف</span>
          <span className="text-2xl font-bold font-mono text-saffron-600" data-testid="payslip-net">{formatMoney(p.net_cents)}</span>
        </div>
      </div>
      {p.absent_days > 0 && p.absence_deduction_cents === 0 && (
        <p className="text-xs font-arabic text-ink-500">سُجّل {p.absent_days} غياب لكن لا يوجد خصم، لأن قاعدة الغياب في «القواعد» لا تخصم (أو لأن راتبه يومي/بالساعة).</p>
      )}

      <section className="space-y-2">
        <h3 className="font-bold font-arabic text-ink-900">أيام الشهر</h3>
        <Hint summary={editable ? "اضغط «عذر مقبول» على يوم تأخر أو غاب فيه بعذر ليُعفى من الخصم. وإن نسي بصمة خروج أضفها." : "الكشف معتمد، وللتعديل أعد فتحه."} />
        <div className="rounded-md border border-ink-200 max-h-72 overflow-y-auto">
          <table className="w-full text-xs font-arabic">
            <thead className="bg-surface-alt text-ink-400 sticky top-0">
              <tr><th className="text-right p-2">اليوم</th><th className="text-right p-2">الحالة</th><th className="p-2">دخول</th><th className="p-2">خروج</th><th className="p-2">تأخير</th><th className="p-2">إضافي</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {p.days.map((d) => (
                <tr key={d.date} className="border-t border-ink-100" data-testid={`day-${d.date}`}>
                  <td className="p-2 font-mono" dir="ltr">{d.date.slice(5)}</td>
                  <td className={`p-2 font-bold ${dayCls(d)}`}>{DAY_STATUS_LABEL[d.status]}{d.note ? ` · ${d.note}` : ""}</td>
                  <td className="p-2 text-center font-mono">{d.first_in ?? ""}</td>
                  <td className="p-2 text-center font-mono">{d.last_out ?? ""}</td>
                  <td className="p-2 text-center font-mono">{d.late_minutes || ""}</td>
                  <td className="p-2 text-center font-mono">{d.overtime_minutes || ""}</td>
                  <td className="p-2 text-left whitespace-nowrap">
                    {editable && ["LATE", "ABSENT", "MISSING_OUT", "NO_RECORD"].includes(d.status) && (
                      <button className="text-saffron-600 font-bold ml-3" disabled={busy} data-testid={`excuse-${d.date}`}
                        onClick={() => run(() => invoke("set_paid_leave_v3", { sessionToken: token, userId, day: d.date, note: null, on: true }), "سُجّل عذر مقبول لهذا اليوم")}>عذر مقبول</button>
                    )}
                    {editable && d.status === "PAID_LEAVE" && (
                      <button className="text-ink-500 ml-3" disabled={busy} onClick={() => run(() => invoke("set_paid_leave_v3", { sessionToken: token, userId, day: d.date, note: null, on: false }), "أُلغي العذر")}>إلغاء العذر</button>
                    )}
                    {editable && !["OFF", "PENDING"].includes(d.status) && (
                      <button className="text-ink-500" onClick={() => { setPunchDay(d.date); setPunchDir(d.status === "MISSING_OUT" ? "OUT" : "IN"); setPunchTime(d.status === "MISSING_OUT" ? "17:00" : "09:00"); }} data-testid={`punch-${d.date}`}>إضافة بصمة</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-bold font-arabic text-ink-900">مكافآت وغرامات هذا الشهر</h3>
        {p.adjustments.map((a) => (
          <div key={a.id} className="flex items-center justify-between text-sm font-arabic border-b border-ink-100 py-1.5">
            <span>{a.kind === "BONUS" ? "مكافأة" : "غرامة"} · {a.reason}</span>
            <span className="flex items-center gap-3">
              <span className={`font-mono ${a.kind === "BONUS" ? "text-ok" : "text-danger"}`}>{formatMoney(a.amount_cents)}</span>
              {editable && <button className="text-danger text-xs" disabled={busy} onClick={() => run(() => invoke("delete_payroll_adjustment_v3", { sessionToken: token, adjustmentId: a.id }), "تم الحذف")}>حذف</button>}
            </span>
          </div>
        ))}
        {editable && (
          <div className="flex flex-wrap items-end gap-2" data-testid="adjustment-form">
            <select value={adjKind} onChange={(e) => setAdjKind(e.target.value as "BONUS" | "FINE")} className={`${inputCls} max-w-[110px]`} data-testid="adj-kind">
              <option value="BONUS">مكافأة</option>
              <option value="FINE">غرامة</option>
            </select>
            <input value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} placeholder="المبلغ" className={`${inputCls} max-w-[140px]`} dir="ltr" inputMode="numeric" data-testid="adj-amount" />
            <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} placeholder="السبب (إجباري)" className={`${inputCls} flex-1 min-w-[160px]`} data-testid="adj-reason" />
            <button className={btnGhost} disabled={busy} data-testid="adj-add"
              onClick={() => run(async () => {
                await invoke("add_payroll_adjustment_v3", { sessionToken: token, userId, month, kind: adjKind, amountCents: parseMoneyInput(adjAmount), reason: adjReason });
                setAdjAmount(""); setAdjReason("");
              }, "تمت الإضافة")}>إضافة</button>
          </div>
        )}
      </section>

      {editable && (
        <section className="space-y-2">
          <h3 className="font-bold font-arabic text-ink-900">سلفة جديدة لهذا الموظف</h3>
          <Hint summary="السلفة مبلغ يأخذه الموظف الآن ويُخصم من رواتبه القادمة على أقساط.">
            <p>مثال: سلفة 300,000 بقسط 100,000: يُخصم 100,000 من كل راتب حتى تنتهي. القسط يُؤخذ من المبلغ المسلَّم للموظف، ولا يُعدّ مصروفاً مرة ثانية.</p>
          </Hint>
          <div className="flex flex-wrap items-end gap-2" data-testid="advance-form">
            <input value={advAmount} onChange={(e) => setAdvAmount(e.target.value)} placeholder="مبلغ السلفة" className={`${inputCls} max-w-[150px]`} dir="ltr" inputMode="numeric" data-testid="adv-amount" />
            <input value={advInstalment} onChange={(e) => setAdvInstalment(e.target.value)} placeholder="القسط الشهري" className={`${inputCls} max-w-[150px]`} dir="ltr" inputMode="numeric" data-testid="adv-instalment" />
            <input value={advReason} onChange={(e) => setAdvReason(e.target.value)} placeholder="السبب (اختياري)" className={`${inputCls} flex-1 min-w-[140px]`} />
            <button className={btnGhost} disabled={busy} data-testid="adv-add"
              onClick={() => run(async () => {
                await invoke("add_payroll_advance_v3", { sessionToken: token, userId, amountCents: parseMoneyInput(advAmount), instalmentCents: parseMoneyInput(advInstalment), givenOn: new Date().toISOString().slice(0, 10), reason: advReason || null });
                setAdvAmount(""); setAdvInstalment(""); setAdvReason("");
              }, "سُجّلت السلفة")}>تسجيل السلفة</button>
          </div>
        </section>
      )}

      <div className="flex flex-wrap justify-between gap-3 pt-2 border-t border-ink-100">
        <button onClick={exportPdf} className={btnGhost}>تصدير PDF</button>
        <div className="flex gap-3">
          {p.status === "APPROVED" && p.id && (
            <button className={btnGhost} disabled={busy} data-testid="payslip-reopen"
              onClick={() => run(() => invoke("reopen_payslip_v3", { sessionToken: token, payslipId: p.id }), "أُعيد فتح الكشف")}>إعادة فتح</button>
          )}
          {p.status === "DRAFT" && (
            <button className={btnPrimary} disabled={busy} data-testid="payslip-approve"
              onClick={() => run(() => invoke("approve_payslip_v3", { sessionToken: token, userId, month, tzOffsetMinutes: tz }), "اعتُمد الكشف")}>اعتماد الكشف</button>
          )}
          {p.status === "APPROVED" && p.id && (
            <button className={btnPrimary} disabled={busy} data-testid="payslip-pay"
              onClick={() => run(() => invoke("pay_payslip_v3", { sessionToken: token, payslipId: p.id, tzOffsetMinutes: tz }), "تم الصرف وسُجّل مصروفاً")}>تأكيد الصرف</button>
          )}
        </div>
      </div>

      {punchDay && (
        <Modal title={`إضافة بصمة · ${punchDay}`} onClose={() => setPunchDay(null)}>
          <Hint summary="لإضافة بصمة نسيها الموظف. تُسجَّل باسمك ويظهر مصدرها «يدوي»، ولا يمكن تعديل سجل البصمات القديم." />
          <div className="grid grid-cols-2 gap-3">
            <Field label="النوع">
              <select value={punchDir} onChange={(e) => setPunchDir(e.target.value as "IN" | "OUT")} className={inputCls} data-testid="punch-dir">
                <option value="IN">دخول</option>
                <option value="OUT">خروج</option>
              </select>
            </Field>
            <Field label="الوقت">
              <input type="time" value={punchTime} onChange={(e) => setPunchTime(e.target.value)} className={inputCls} dir="ltr" data-testid="punch-time" />
            </Field>
          </div>
          <Field label="السبب (إجباري)">
            <input value={punchReason} onChange={(e) => setPunchReason(e.target.value)} className={inputCls} data-testid="punch-reason" />
          </Field>
          <div className="flex justify-end gap-3">
            <button className={btnGhost} onClick={() => setPunchDay(null)}>إلغاء</button>
            <button className={btnPrimary} disabled={busy} data-testid="punch-save"
              onClick={() => run(async () => {
                const at = new Date(toLocalInput(punchDay, punchTime)).toISOString();
                await invoke("add_manual_punch_v3", { sessionToken: token, userId, punchedAtIso: at, direction: punchDir, reason: punchReason });
                setPunchDay(null); setPunchReason("");
              }, "أُضيفت البصمة")}>إضافة</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
