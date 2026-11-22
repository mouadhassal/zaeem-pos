import { useCurrency } from "../../hooks/useCurrency";
import { bpText, classShares, moneyChange, moneySplit, pointsChange, previousPeriodRange } from "../../lib/dashboard";
import { costClassLabel } from "../../lib/profit";
import { getCostOfSales, getSummary, settle } from "./dashApi";
import { SplitBar } from "./Charts";
import StatCard from "./StatCard";
import TabState, { CardGrid } from "./TabState";
import { useDashLoad } from "./useDashLoad";
import type { TabProps } from "./tabTypes";

/** المالية: sales, what the goods and salaries took out of them, the expenses, and what is left. */
export default function FinanceTab({ period, range, show, open, refreshKey }: TabProps) {
  const { fmt } = useCurrency();
  const { data, loading } = useDashLoad(async () => {
    const prev = previousPeriodRange(period, range);
    const [now, before, cost, costBefore] = await Promise.all([
      settle(getSummary(range)),
      settle(getSummary(prev)),
      settle(getCostOfSales(range)),
      settle(getCostOfSales(prev)),
    ]);
    return { now, before, cost, costBefore };
  }, [period, range.startIso, range.endIso, refreshKey]);

  const p = data?.now?.profit;
  const q = data?.before?.profit;
  const c = data?.cost;
  const cb = data?.costBefore;
  const shares = c ? classShares(c.classes) : [];

  return (
    <TabState loading={loading} empty={!p}>
      {p && (
        <div className="space-y-4" data-testid="dash-tab-finance">
          <CardGrid>
            {show("f_sales") && (
              <StatCard id="f_sales" title="المبيعات بدون ضريبة" value={fmt(p.net_sales_cents)} hint="كل ما بعته بعد الخصم. الضريبة ليست دخلاً لك فلا تدخل هنا."
                change={q ? moneyChange(p.net_sales_cents, q.net_sales_cents) : undefined} onOpen={() => open("f_sales")} />
            )}
            {show("f_cost") && c && (
              <StatCard id="f_cost" title="ثمن الأكل والشرب" value={bpText(c.total_bp)} hint="من كل 100 من مبيعاتك، هذا ما دفعته ثمن المواد."
                change={cb ? pointsChange(c.total_bp, cb.total_bp) : undefined}
                lines={shares.length > 1 ? [shares.map((s) => `${costClassLabel(s.cls)} ${bpText(s.bp)}`).join(" · ")] : undefined}
                onOpen={() => open("f_cost")} />
            )}
            {show("f_labour") && c && (
              <StatCard id="f_labour" title="الرواتب من المبيعات" value={bpText(c.labour_bp)} hint="من كل 100 من مبيعاتك، هذا ما ذهب للرواتب."
                change={cb ? pointsChange(c.labour_bp, cb.labour_bp) : undefined} onOpen={() => open("f_labour")} />
            )}
            {show("f_expenses") && (
              <StatCard id="f_expenses" title="المصروفات" value={fmt(p.expenses_cents)} hint="كل ما سجّلته من مصروفات: مواد وإيجار وفواتير ورواتب."
                change={q ? moneyChange(p.expenses_cents, q.expenses_cents, false) : undefined} onOpen={() => open("f_expenses")} />
            )}
            {show("f_profit") && (
              <StatCard id="f_profit" title="الربح" value={fmt(p.net_profit_cents)} valueTone={p.net_profit_cents >= 0 ? "good" : "bad"}
                hint={p.items_without_cost > 0 ? `ما بقي لك بعد المصروفات. تنبيه: ${p.items_without_cost} صنف بلا تكلفة، فالربح الحقيقي أقل.` : "ما بقي لك بعد ثمن ما بعته والمصروفات."}
                change={q ? moneyChange(p.net_profit_cents, q.net_profit_cents) : undefined} onOpen={() => open("f_profit")} />
            )}
          </CardGrid>
          <SplitBar title="أين ذهبت مبيعاتك؟" parts={moneySplit(p)} fmt={fmt} />
        </div>
      )}
    </TabState>
  );
}
