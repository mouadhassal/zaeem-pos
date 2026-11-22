import { useState } from "react";
import { useCurrency } from "../../hooks/useCurrency";
import ProfitCards from "../../components/ProfitCards";
import { lowStockRows, moneyChange, periodRange, previousPeriodRange } from "../../lib/dashboard";
import { getDrawerCash, getLateOrders, getStockReport, getSummary, settle } from "./dashApi";
import AttentionRow from "./AttentionRow";
import BranchTable from "./BranchTable";
import StatCard from "./StatCard";
import TabState, { CardGrid } from "./TabState";
import { useDashLoad } from "./useDashLoad";
import type { TabProps } from "./tabTypes";

/**
 * الخلاصة: today against yesterday, this month's profit, the cash in the drawer, and the three things that
 * need attention. It is always "today" and "this month" (the period picker does not apply here).
 */
export default function SummaryTab({ show, open, refreshKey }: Omit<TabProps, "period" | "range">) {
  const { fmt } = useCurrency();
  const [details, setDetails] = useState(false);
  const { data, loading } = useDashLoad(async () => {
    const today = periodRange("today");
    const month = periodRange("month");
    const [now, yesterday, monthNow, monthBefore, drawer, stock, late] = await Promise.all([
      show("sales_today") || show("attn_debts") ? settle(getSummary(today)) : Promise.resolve(null),
      show("sales_today") ? settle(getSummary(previousPeriodRange("today", today))) : Promise.resolve(null),
      show("profit_month") ? settle(getSummary(month)) : Promise.resolve(null),
      show("profit_month") ? settle(getSummary(previousPeriodRange("month", month))) : Promise.resolve(null),
      show("cash_drawer") ? settle(getDrawerCash()) : Promise.resolve(null),
      show("attn_stock") ? settle(getStockReport(today)) : Promise.resolve(null),
      show("attn_late") ? settle(getLateOrders(today)) : Promise.resolve(null),
    ]);
    return { now, yesterday, monthNow, monthBefore, drawer, stock, late };
  }, [refreshKey]);

  const sales = data?.now?.profit;
  const salesBefore = data?.yesterday?.profit;
  const profit = data?.monthNow?.profit;
  const profitBefore = data?.monthBefore?.profit;
  const low = data?.stock ? lowStockRows(data.stock.rows).length : null;
  const debts = data?.now?.total_outstanding_debt_cents ?? null;
  const late = data?.late?.late_count ?? null;
  const empty = !data || (!sales && !profit && data.drawer == null && low === null && late === null && debts === null);

  return (
    <TabState loading={loading} empty={empty}>
      <div className="space-y-6" data-testid="dash-tab-summary">
        <CardGrid>
          {show("sales_today") && sales && (
            <StatCard id="sales_today" title="مبيعات اليوم" value={fmt(sales.net_sales_cents)} hint="ما بعته اليوم بعد الخصم وبدون الضريبة، مقارنة بالأمس في نفس الساعات."
              change={salesBefore ? moneyChange(sales.net_sales_cents, salesBefore.net_sales_cents) : undefined} onOpen={() => open("sales_today")} />
          )}
          {show("profit_month") && profit && (
            <StatCard id="profit_month" title="ربح هذا الشهر" value={fmt(profit.net_profit_cents)} valueTone={profit.net_profit_cents >= 0 ? "good" : "bad"}
              hint={profit.items_without_cost > 0 ? `ما بقي لك بعد المصروفات. تنبيه: ${profit.items_without_cost} صنف بلا تكلفة، فالربح الحقيقي أقل.` : "ما بقي لك بعد ثمن ما بعته والمصروفات، مقارنة بالشهر الماضي."}
              change={profitBefore ? moneyChange(profit.net_profit_cents, profitBefore.net_profit_cents) : undefined} onOpen={() => open("profit_month")} />
          )}
          {show("cash_drawer") && data?.drawer != null && (
            <StatCard id="cash_drawer" title="النقد في الدرج" value={fmt(data.drawer)} hint="ما يجب أن يكون في الدرج الآن حسب ورديتك المفتوحة." onOpen={() => open("cash_drawer")} />
          )}
        </CardGrid>

        <div className="space-y-3">
          <h2 className="text-lg font-bold text-ink-900 font-arabic">تحتاج انتباهك</h2>
          {show("attn_stock") && low !== null && (
            <AttentionRow id="attn_stock" title="مواد قاربت على النفاد" problem={low > 0 ? `${low}` : null}
              hint={low > 0 ? "كميتها وصلت إلى حد التنبيه أو أقل." : "كل المواد فوق حد التنبيه."} onOpen={() => open("attn_stock")} />
          )}
          {show("attn_debts") && debts !== null && (
            <AttentionRow id="attn_debts" title="ديون لم تُسدَّد" problem={debts > 0 ? fmt(debts) : null}
              hint={debts > 0 ? "ما أخذه الزبائن بالدين وما زال عليهم." : "لا ديون على الزبائن."} onOpen={() => open("attn_debts")} />
          )}
          {show("attn_late") && late !== null && (
            <AttentionRow id="attn_late" title="طلبات تأخرت في المطبخ" problem={late > 0 ? `${late}` : null}
              hint={late > 0 ? `طلبات اليوم التي أخذت أكثر من ${data?.late?.late_minutes ?? 20} دقيقة.` : "لا طلب تأخر اليوم."} onOpen={() => open("attn_late")} />
          )}
        </div>

        {profit && (
          <div className="space-y-3">
            <button type="button" onClick={() => setDetails((v) => !v)} className="text-sm text-saffron-600 hover:text-saffron-700 font-arabic font-bold" data-testid="dash-details-toggle">
              {details ? "إخفاء تفاصيل الأرباح" : "تفاصيل الأرباح هذا الشهر (للمحاسب)"}
            </button>
            {details && (
              <div className="space-y-4">
                <ProfitCards profit={profit} fmt={fmt} />
                <BranchTable branches={data?.monthNow?.branches ?? []} />
              </div>
            )}
          </div>
        )}
      </div>
    </TabState>
  );
}
