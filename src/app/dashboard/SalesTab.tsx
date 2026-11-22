import { useTerms } from "../../lib/terms";
import { useCurrency } from "../../hooks/useCurrency";
import { busiestHour, dayBars, hourBars, isOneDay, moneyChange, previousPeriodRange } from "../../lib/dashboard";
import { getHours, getSummary, getTopItems, getTrend, settle } from "./dashApi";
import { BarChart } from "./Charts";
import StatCard from "./StatCard";
import TabState, { CardGrid } from "./TabState";
import { useDashLoad } from "./useDashLoad";
import type { TabProps } from "./tabTypes";

/** المبيعات: what was sold, how many orders, the average bill, the best item and hour, and a bar per day (or hour). */
export default function SalesTab({ period, range, show, open, refreshKey }: TabProps) {
  const tm = useTerms();
  const { fmt } = useCurrency();
  const oneDay = isOneDay(range);
  const { data, loading } = useDashLoad(async () => {
    const prev = previousPeriodRange(period, range);
    const [now, before, top, hours, trend] = await Promise.all([
      settle(getSummary(range)),
      settle(getSummary(prev)),
      show("s_top") ? settle(getTopItems(range)) : Promise.resolve(null),
      show("s_hour") || oneDay ? settle(getHours(range)) : Promise.resolve(null),
      oneDay ? Promise.resolve(null) : settle(getTrend(range)),
    ]);
    return { now, before, top, hours, trend };
  }, [period, range.startIso, range.endIso, refreshKey]);

  const p = data?.now?.profit;
  const q = data?.before?.profit;
  const avg = p && p.order_count > 0 ? Math.round(p.net_sales_cents / p.order_count) : 0;
  const avgBefore = q && q.order_count > 0 ? Math.round(q.net_sales_cents / q.order_count) : 0;
  const topItem = data?.top?.[0];
  const hour = data?.hours ? busiestHour(data.hours) : null;
  const points = oneDay ? hourBars(data?.hours ?? []) : dayBars(data?.trend ?? []);
  const gave = p ? p.discounts_cents + p.refunds_cents : 0;
  const gaveBefore = q ? q.discounts_cents + q.refunds_cents : 0;

  return (
    <TabState loading={loading} empty={!p}>
      {p && (
        <div className="space-y-4" data-testid="dash-tab-sales">
          <CardGrid>
            {show("s_sales") && (
              <StatCard id="s_sales" title="المبيعات" value={fmt(p.net_sales_cents)} hint="كل ما بعته بعد الخصم، بدون الضريبة."
                change={q ? moneyChange(p.net_sales_cents, q.net_sales_cents) : undefined} onOpen={() => open("s_sales")} />
            )}
            {show("s_orders") && (
              <StatCard id="s_orders" title={`عدد ${tm.theOrders}`} value={String(p.order_count)} hint="كم فاتورة دُفعت في هذه الفترة."
                change={q ? moneyChange(p.order_count, q.order_count) : undefined} onOpen={() => open("s_orders")} />
            )}
            {show("s_avg") && (
              <StatCard id="s_avg" title="متوسط الفاتورة" value={fmt(avg)} hint="كم يدفع الزبون في الفاتورة الواحدة تقريباً."
                change={q ? moneyChange(avg, avgBefore) : undefined} onOpen={() => open("s_avg")} />
            )}
            {show("s_top") && topItem && (
              <StatCard id="s_top" title={`أكثر ${tm.item} مبيعاً`} value={topItem.name} hint={`بِيع منه ${topItem.quantity} قطعة.`} onOpen={() => open("s_top")} />
            )}
            {show("s_hour") && hour && (
              <StatCard id="s_hour" title="أنشط ساعة" value={hour.label} hint="الساعة التي بعت فيها أكثر من غيرها." onOpen={() => open("s_hour")} />
            )}
            {show("s_discounts") && (
              <StatCard id="s_discounts" title="خصومات ومرتجعات" value={fmt(gave)} hint="ما نزل من مبيعاتك: خصم أعطيته أو مبلغ أرجعته لزبون."
                change={q ? moneyChange(gave, gaveBefore, false) : undefined} onOpen={() => open("s_discounts")} />
            )}
          </CardGrid>
          <BarChart title={oneDay ? "المبيعات في كل ساعة" : "المبيعات في كل يوم"} points={points} fmt={fmt} />
        </div>
      )}
    </TabState>
  );
}
