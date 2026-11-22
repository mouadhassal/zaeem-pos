import { useCurrency } from "../../hooks/useCurrency";
import { lowStockRows, moneyChange, previousPeriodRange } from "../../lib/dashboard";
import { getStockReport, getSummary, settle } from "./dashApi";
import StatCard from "./StatCard";
import TabState, { CardGrid } from "./TabState";
import { useDashLoad } from "./useDashLoad";
import type { TabProps } from "./tabTypes";

/** المخزون: what the stock is worth, what is running low, what was wasted, bought, and what is owed to suppliers. */
export default function StockTab({ period, range, show, open, refreshKey }: TabProps) {
  const { fmt } = useCurrency();
  const { data, loading } = useDashLoad(async () => {
    const prev = previousPeriodRange(period, range);
    const [now, before, summary] = await Promise.all([
      settle(getStockReport(range)),
      settle(getStockReport(prev)),
      show("k_suppliers") ? settle(getSummary(range)) : Promise.resolve(null),
    ]);
    return { now, before, summary };
  }, [period, range.startIso, range.endIso, refreshKey]);

  const r = data?.now;
  const b = data?.before;
  const low = r ? lowStockRows(r.rows) : [];
  const owed = data?.summary?.total_outstanding_supplier_balance_cents;

  return (
    <TabState loading={loading} empty={!r}>
      {r && (
        <div className="space-y-4" data-testid="dash-tab-stock">
          <CardGrid>
            {show("k_value") && (
              <StatCard id="k_value" title="قيمة المخزون" value={fmt(r.total_value_cents)} hint="ثمن ما في مخازنك الآن بسعر الشراء." onOpen={() => open("k_value")} />
            )}
            {show("k_low") && (
              <StatCard id="k_low" title="مواد قاربت على النفاد" value={String(low.length)} valueTone={low.length > 0 ? "bad" : "good"}
                hint={low.length > 0 ? "كميتها وصلت إلى حد التنبيه أو أقل. حان وقت الشراء." : "لا مادة تحت حد التنبيه."}
                lines={low.slice(0, 4).map((x) => x.name)} onOpen={() => open("k_low")} />
            )}
            {show("k_waste") && (
              <StatCard id="k_waste" title="الهدر" value={fmt(r.waste_value_cents)} hint="ثمن ما رُمي أو تلف في هذه الفترة."
                change={b ? moneyChange(r.waste_value_cents, b.waste_value_cents, false) : undefined} onOpen={() => open("k_waste")} />
            )}
            {show("k_purchases") && (
              <StatCard id="k_purchases" title="المشتريات" value={fmt(r.received_value_cents)} hint="ثمن المواد التي استلمتها في هذه الفترة."
                change={b ? moneyChange(r.received_value_cents, b.received_value_cents) : undefined} onOpen={() => open("k_purchases")} />
            )}
            {show("k_suppliers") && owed !== undefined && (
              <StatCard id="k_suppliers" title="ما عليك للموردين" value={fmt(owed)} valueTone={owed > 0 ? "bad" : "good"}
                hint="ما اشتريته ولم تدفع ثمنه بعد." onOpen={() => open("k_suppliers")} />
            )}
          </CardGrid>
        </div>
      )}
    </TabState>
  );
}
