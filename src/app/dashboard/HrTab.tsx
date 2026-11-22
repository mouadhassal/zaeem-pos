import { useCurrency } from "../../hooks/useCurrency";
import { daysText, hoursText, hrTotals, monthOfRange, moneyChange, previousMonth } from "../../lib/dashboard";
import { getAdvancesOutstanding, getPayrollMonth, getPayslip, settle, type PayslipLite } from "./dashApi";
import StatCard from "./StatCard";
import TabState, { CardGrid } from "./TabState";
import { useDashLoad } from "./useDashLoad";
import type { TabProps } from "./tabTypes";

/** الموظفين: the month's salaries, extra time, absences, advances and who is not paid yet. Payroll works by the month. */
export default function HrTab({ range, show, open, refreshKey }: TabProps) {
  const { fmt } = useCurrency();
  const month = monthOfRange(range);
  const { data, loading } = useDashLoad(async () => {
    const [rows, before, advances] = await Promise.all([
      settle(getPayrollMonth(month)),
      settle(getPayrollMonth(previousMonth(month))),
      show("h_advances") ? settle(getAdvancesOutstanding()) : Promise.resolve(null),
    ]);
    const slips = rows
      ? (await Promise.all(rows.filter((r) => r.pay_set).map((r) => settle(getPayslip(r.user_id, month))))).filter((s): s is PayslipLite => s !== null)
      : [];
    return { rows, before, advances, slips };
  }, [month, refreshKey]);

  const t = data?.rows ? hrTotals(data.rows, data.slips) : null;
  const tBefore = data?.before ? hrTotals(data.before, []) : null;

  return (
    <TabState loading={loading} empty={!t}>
      {t && (
        <div className="space-y-4" data-testid="dash-tab-hr">
          <p className="text-sm text-ink-500 font-arabic">الرواتب تُحسب بالشهر، فهذه أرقام شهر {month} مهما كانت الفترة المختارة.</p>
          <CardGrid>
            {show("h_salaries") && (
              <StatCard id="h_salaries" title="رواتب الشهر" value={fmt(t.salaries_cents)} hint="ما استحقّه الموظفون عن هذا الشهر، قبل خصم السلف."
                change={tBefore && tBefore.salaries_cents > 0 ? moneyChange(t.salaries_cents, tBefore.salaries_cents, false) : undefined} onOpen={() => open("h_salaries")} />
            )}
            {show("h_overtime") && (
              <StatCard id="h_overtime" title="الوقت الإضافي" value={hoursText(t.overtime_minutes)} hint={`ساعات عمل زائدة عن الدوام، قيمتها ${fmt(t.overtime_pay_cents)}.`} onOpen={() => open("h_overtime")} />
            )}
            {show("h_absence") && (
              <StatCard id="h_absence" title="الغياب" value={daysText(t.absent_days)} valueTone={t.absent_days > 0 ? "bad" : "good"}
                hint="مجموع أيام غياب كل الموظفين هذا الشهر." onOpen={() => open("h_absence")} />
            )}
            {show("h_advances") && data?.advances !== null && data?.advances !== undefined && (
              <StatCard id="h_advances" title="سلف لم تُسدَّد" value={fmt(data.advances)} hint="ما أخذه الموظفون مقدماً وما زال عليهم." onOpen={() => open("h_advances")} />
            )}
            {show("h_unpaid") && (
              <StatCard id="h_unpaid" title="رواتب لم تُصرف" value={`${t.unpaid} من ${t.people}`} valueTone={t.unpaid > 0 ? "bad" : "good"}
                hint="موظفون لم يُصرف لهم راتب هذا الشهر بعد." onOpen={() => open("h_unpaid")} />
            )}
          </CardGrid>
        </div>
      )}
    </TabState>
  );
}
