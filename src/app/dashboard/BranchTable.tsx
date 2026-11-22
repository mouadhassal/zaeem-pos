import { useTerms } from "../../lib/terms";
import { useCurrency } from "../../hooks/useCurrency";
import type { DashBranch } from "./dashApi";

/** مقارنة الفروع: only worth showing when the owner has more than one branch. */
export default function BranchTable({ branches }: { branches: DashBranch[] }) {
  const tm = useTerms();
  const { fmt } = useCurrency();
  if (branches.length < 2) return null;
  return (
    <div className="bg-white rounded-lg border border-ink-200 overflow-x-auto" data-testid="dash-branches">
      <div className="p-4 pb-0">
        <h2 className="font-bold text-ink-900 font-arabic">مقارنة الفروع</h2>
      </div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="border-b border-ink-200 text-ink-400 font-arabic bg-surface-alt">
            <th className="text-right p-3 font-medium">الفرع</th>
            <th className="text-center p-3 font-medium">صافي المبيعات</th>
            <th className="text-center p-3 font-medium">المصروفات</th>
            <th className="text-center p-3 font-medium">الربح بالمصروفات</th>
            <th className="text-center p-3 font-medium">ربح الهامش</th>
            <th className="text-center p-3 font-medium">صافي الربح الفعلي</th>
            <th className="text-center p-3 font-medium">{tm.theOrders}</th>
            <th className="text-center p-3 font-medium">متوسط الفاتورة</th>
          </tr>
        </thead>
        <tbody>
          {[...branches].sort((a, b) => b.profit_cents - a.profit_cents).map((b) => (
            <tr key={b.branch_id} className="border-b border-ink-100 hover:bg-saffron-50">
              <td className="p-3 font-arabic text-ink-900 font-medium">{b.branch_name}</td>
              <td className="p-3 text-center font-mono text-saffron-600">{fmt(b.revenue_cents)}</td>
              <td className="p-3 text-center font-mono text-danger">{fmt(b.costs_cents)}</td>
              <td className={`p-3 text-center font-mono font-bold ${b.profit_cents >= 0 ? "text-ok" : "text-danger"}`}>{fmt(b.profit_cents)}</td>
              <td className={`p-3 text-center font-mono ${b.profit.margin_profit_cents >= 0 ? "text-ok" : "text-danger"}`}>{fmt(b.profit.margin_profit_cents)}</td>
              <td className={`p-3 text-center font-mono ${b.profit.net_profit_cents >= 0 ? "text-ok" : "text-danger"}`}>{fmt(b.profit.net_profit_cents)}</td>
              <td className="p-3 text-center font-mono text-ink-900">{b.order_count}</td>
              <td className="p-3 text-center font-mono text-ink-900">{fmt(b.avg_ticket_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
