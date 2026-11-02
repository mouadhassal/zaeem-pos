import { useState } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { PAY_TYPE_LABEL, PAY_TYPE_RATE_LABEL, type EmployeePay, type EmployeeRow, type PayType } from "../../lib/payroll";
import { ChoiceCards, Field, Hint, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

const ROLE_LABEL: Record<string, string> = { OWNER: "المالك", MANAGER: "مشرف", CASHIER: "كاشير", KITCHEN: "مطبخ", SERVER: "خدمة" };

/** Who is on the payroll and what each person is paid. */
export default function PeopleTab({ employees, onChanged }: { employees: EmployeeRow[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  return (
    <div className="space-y-4" data-testid="people-tab">
      <Hint summary="حدّد لكل شخص كيف يُدفع له. من لم يُحدَّد راتبه لا يظهر في كشف الشهر.">
        <p><b>راتب شهري:</b> مبلغ ثابت في الشهر، تُخصم منه الغيابات والتأخير حسب قواعدك.</p>
        <p><b>أجر يومي:</b> يُدفع عن كل يوم عمل فعلي، فلا يُدفع له عن يوم لم يحضره.</p>
        <p><b>أجر بالساعة:</b> يُدفع عن الساعات التي عملها فعلاً (من بصمة الدخول إلى الخروج).</p>
      </Hint>
      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الاسم</th>
              <th className="text-right p-3 font-medium">الوظيفة</th>
              <th className="text-right p-3 font-medium">نوع الأجر</th>
              <th className="text-right p-3 font-medium">المبلغ</th>
              <th className="text-right p-3 font-medium">الحضور</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.user_id} className="border-b border-ink-100" data-testid={`person-${e.user_id}`}>
                <td className="p-3 font-arabic font-medium text-ink-900">{e.name}</td>
                <td className="p-3 font-arabic text-ink-500">{ROLE_LABEL[e.role] ?? e.role}</td>
                <td className="p-3 font-arabic">{e.pay ? PAY_TYPE_LABEL[e.pay.pay_type] : <span className="text-warn">لم يُحدَّد</span>}</td>
                <td className="p-3 font-mono">{e.pay ? formatMoney(e.pay.rate_cents) : "—"}</td>
                <td className="p-3 font-arabic text-ink-500">{e.pay ? (e.pay.track_attendance ? "من البصمات" : "بدون احتساب") : "—"}</td>
                <td className="p-3 text-left">
                  <button onClick={() => setEditing(e)} className="text-saffron-600 font-bold font-arabic hover:text-saffron-700" data-testid={`edit-pay-${e.user_id}`}>
                    {e.pay ? "تعديل" : "تحديد الراتب"}
                  </button>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-ink-500 font-arabic">لا يوجد موظفون. أضفهم من صفحة «الموظفين».</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && <PayEditor person={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
    </div>
  );
}

function PayEditor({ person, onClose, onSaved }: { person: EmployeeRow; onClose: () => void; onSaved: () => void }) {
  const token = useAuthStore((s) => s.token);
  const toast = useToast();
  const p = person.pay;
  const [payType, setPayType] = useState<PayType>(p?.pay_type ?? "MONTHLY");
  const [rate, setRate] = useState(p ? String(p.rate_cents) : "");
  const [shiftStart, setShiftStart] = useState(p?.shift_start ?? "");
  const [shiftHours, setShiftHours] = useState(p?.shift_minutes ? String(p.shift_minutes / 60) : "");
  const [startDate, setStartDate] = useState(p?.start_date ?? "");
  const [endDate, setEndDate] = useState(p?.end_date ?? "");
  const [track, setTrack] = useState(p?.track_attendance ?? true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const amount = parseMoneyInput(rate);
    if (amount <= 0) {
      toast.error("اكتب مبلغ الراتب");
      return;
    }
    setSaving(true);
    try {
      const pay: EmployeePay = {
        user_id: person.user_id,
        pay_type: payType,
        rate_cents: amount,
        shift_start: shiftStart || null,
        shift_minutes: shiftHours ? Math.round(Number(shiftHours) * 60) : null,
        start_date: startDate || null,
        end_date: endDate || null,
        track_attendance: track,
      };
      await invoke("save_payroll_employee_v3", { sessionToken: token, pay });
      toast.success("تم حفظ الراتب");
      onSaved();
    } catch (err) {
      toast.error(`تعذر الحفظ: ${realErrorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`راتب ${person.name}`} onClose={onClose}>
      <ChoiceCards<PayType>
        testId="pay-type"
        value={payType}
        onChange={setPayType}
        options={[
          { value: "MONTHLY", title: "راتب شهري", text: "مبلغ ثابت كل شهر." },
          { value: "DAILY", title: "أجر يومي", text: "مبلغ عن كل يوم عمل فعلي." },
          { value: "HOURLY", title: "أجر بالساعة", text: "مبلغ عن كل ساعة عمل فعلية." },
        ]}
      />
      <Field label={PAY_TYPE_RATE_LABEL[payType]}>
        <input value={rate} onChange={(e) => setRate(e.target.value)} className={inputCls} dir="ltr" inputMode="numeric" data-testid="pay-rate" />
      </Field>
      <label className="flex items-start gap-2 font-arabic text-sm text-ink-900">
        <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} className="mt-1" data-testid="pay-track" />
        <span>
          احتساب الحضور من البصمات
          <span className="block text-xs text-ink-400">أوقفه لمن لا تسجّل بصمته: يُدفع له الراتب الأساسي بلا خصم غياب أو تأخير ولا وقت إضافي.</span>
        </span>
      </label>
      <details className="text-sm font-arabic">
        <summary className="cursor-pointer text-saffron-600 font-bold">خيارات إضافية (دوام مختلف، موظف جديد أو مغادر)</summary>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="بداية دوامه" hint="اتركها فارغة لاستخدام بداية الدوام العامة.">
            <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className={inputCls} dir="ltr" />
          </Field>
          <Field label="طول دوامه بالساعات" hint="فارغ = الطول العام.">
            <input type="number" min={1} max={18} step={0.5} value={shiftHours} onChange={(e) => setShiftHours(e.target.value)} className={inputCls} dir="ltr" />
          </Field>
          <Field label="تاريخ بدء العمل" hint="لمن بدأ في منتصف الشهر: يُحسب راتبه عن أيامه فقط.">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} dir="ltr" />
          </Field>
          <Field label="تاريخ ترك العمل">
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} dir="ltr" />
          </Field>
        </div>
      </details>
      <div className="flex justify-end gap-3 pt-2">
        <button onClick={onClose} className={btnGhost}>إلغاء</button>
        <button onClick={save} disabled={saving} className={btnPrimary} data-testid="pay-save">{saving ? "جاري الحفظ..." : "حفظ"}</button>
      </div>
    </Modal>
  );
}
