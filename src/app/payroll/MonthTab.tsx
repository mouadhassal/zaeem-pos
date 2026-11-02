import { useCallback, useEffect, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { formatMoney } from "../../lib/money";
import { tzOffsetMinutes } from "../../lib/assistant";
import { monthLabel, monthOf, shiftMonth, STATUS_LABEL, type MonthRow, type PayType } from "../../lib/payroll";
import { Hint } from "./ui";
import PayslipModal from "./PayslipModal";

const TYPE_SHORT: Record<PayType, string> = { MONTHLY: "شهري", DAILY: "يومي", HOURLY: "بالساعة" };

const BADGE: Record<MonthRow["status"], string> = {
  NO_PAY: "bg-white text-ink-400 border border-ink-200",
  DRAFT: "bg-warn-100 text-warn-700",
  APPROVED: "bg-saffron-50 text-saffron-700",
  PAID: "bg-ok-100 text-ok-700",
};

/** Everyone's month on one table; open a person to see where each pound comes from. */
export default function MonthTab({ configured, onGoRules, refreshKey, onChanged }: { configured: boolean; onGoRules: () => void; refreshKey: number; onChanged: () => void }) {
  const token = useAuthStore((s) => s.token);
  const [month, setMonth] = useState(() => monthOf(new Date()));
  const [rows, setRows] = useState<MonthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRows(await invoke<MonthRow[]>("payroll_month_v3", { sessionToken: token, month, tzOffsetMinutes: tzOffsetMinutes() }));
    } catch (err) {
      setError(realErrorText(err));
    }
  }, [token, month]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const withPay = (rows ?? []).filter((r) => r.pay_set);
  const total = (f: (r: MonthRow) => number) => withPay.reduce((a, r) => a + f(r), 0);
  const noPay = (rows ?? []).filter((r) => !r.pay_set).length;

  return (
    <div className="space-y-4" data-testid="month-tab">
      {!configured && (
        <div className="rounded-md border border-warn bg-warn-soft p-3 text-sm font-arabic text-ink-900 flex items-center justify-between gap-3" data-testid="rules-banner">
          <span>لم تحدد قواعد الخصم بعد، لذلك لا يُخصم شيء من أي راتب. حدّدها لتعمل الخصومات والوقت الإضافي كما تريد.</span>
          <button onClick={onGoRules} className="shrink-0 text-saffron-600 font-bold">تحديد القواعد</button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="الشهر السابق" className="w-9 h-9 rounded-sm border border-ink-200 flex items-center justify-center hover:bg-white"><IconChevronRight className="w-4 h-4" /></button>
        <span className="font-bold font-arabic text-ink-900 min-w-[150px] text-center" data-testid="month-label">{monthLabel(month)}</span>
        <button onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="الشهر التالي" className="w-9 h-9 rounded-sm border border-ink-200 flex items-center justify-center hover:bg-white"><IconChevronLeft className="w-4 h-4" /></button>
      </div>
      <Hint summary="الأرقام هنا مسودة تتغير مع الحضور حتى تعتمد الكشف. بعد انتهاء الشهر: افتح كل موظف ← اعتماد ← تأكيد الصرف، فيُسجَّل راتبه مصروفاً تلقائياً في المالية.">
        <p><b>المستحق</b> = الأساسي − الخصومات + الإضافي والمكافآت. <b>الصافي</b> = المستحق − قسط السلفة، وهو ما يُسلَّم للموظف.</p>
        <p>يُسجَّل في المصروفات «المستحق» (لا الصافي)، لأن السلفة سُلّمت سابقاً.</p>
      </Hint>
      {error && <p className="text-danger font-arabic text-sm">{error}</p>}
      {noPay > 0 && <p className="text-xs font-arabic text-warn">{noPay} من الموظفين بلا راتب محدد. حدّده من تبويب «الموظفون».</p>}
      <div className="zc-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
              <th className="text-right p-3 font-medium">الموظف</th>
              <th className="text-center p-3 font-medium">النوع</th>
              <th className="text-center p-3 font-medium">الأساسي</th>
              <th className="text-center p-3 font-medium">الخصومات</th>
              <th className="text-center p-3 font-medium">الإضافات</th>
              <th className="text-center p-3 font-medium">المستحق</th>
              <th className="text-center p-3 font-medium">قسط سلفة</th>
              <th className="text-center p-3 font-medium">الصافي</th>
              <th className="text-center p-3 font-medium">الحالة</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {withPay.map((r) => (
              <tr key={r.user_id} className="border-b border-ink-100 hover:bg-saffron-50" data-testid={`month-row-${r.user_id}`}>
                <td className="p-3 font-arabic font-medium text-ink-900">{r.name}{r.warnings > 0 && <span className="text-warn mr-1" title="يحتاج مراجعة">⚠</span>}</td>
                <td className="p-3 text-center font-arabic text-ink-500">{r.pay_type ? TYPE_SHORT[r.pay_type] : ""}</td>
                <td className="p-3 text-center font-mono">{formatMoney(r.base_cents)}</td>
                <td className="p-3 text-center font-mono text-danger">{r.deductions_cents ? formatMoney(r.deductions_cents) : "—"}</td>
                <td className="p-3 text-center font-mono text-ok">{r.additions_cents ? formatMoney(r.additions_cents) : "—"}</td>
                <td className="p-3 text-center font-mono">{formatMoney(r.earned_cents)}</td>
                <td className="p-3 text-center font-mono text-ink-500">{r.advance_repaid_cents ? formatMoney(r.advance_repaid_cents) : "—"}</td>
                <td className="p-3 text-center font-mono font-bold text-saffron-600">{formatMoney(r.net_cents)}</td>
                <td className="p-3 text-center"><span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-arabic ${BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                <td className="p-3 text-left"><button onClick={() => setOpen(r.user_id)} className="text-saffron-600 font-bold font-arabic" data-testid={`open-${r.user_id}`}>فتح الكشف</button></td>
              </tr>
            ))}
            {withPay.length === 0 && rows && (
              <tr><td colSpan={10} className="p-6 text-center text-ink-500 font-arabic">لم تُحدَّد رواتب بعد. افتح تبويب «الموظفون» وحدّد راتب كل شخص.</td></tr>
            )}
          </tbody>
          {withPay.length > 0 && (
            <tfoot>
              <tr className="bg-surface-alt font-bold font-arabic" data-testid="month-totals">
                <td className="p-3" colSpan={2}>المجموع</td>
                <td className="p-3 text-center font-mono">{formatMoney(total((r) => r.base_cents))}</td>
                <td className="p-3 text-center font-mono text-danger">{formatMoney(total((r) => r.deductions_cents))}</td>
                <td className="p-3 text-center font-mono text-ok">{formatMoney(total((r) => r.additions_cents))}</td>
                <td className="p-3 text-center font-mono">{formatMoney(total((r) => r.earned_cents))}</td>
                <td className="p-3 text-center font-mono">{formatMoney(total((r) => r.advance_repaid_cents))}</td>
                <td className="p-3 text-center font-mono text-saffron-600">{formatMoney(total((r) => r.net_cents))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {open && <PayslipModal userId={open} month={month} onClose={() => setOpen(null)} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}
