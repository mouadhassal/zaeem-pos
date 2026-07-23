import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useCurrency } from "../../hooks/useCurrency";
import { IconTrendingUp, IconTrendingDown, IconCash, IconUsers, IconTruck } from "@tabler/icons-react";

interface DashboardBranch {
  branch_id: string;
  branch_name: string;
  revenue_cents: number;
  order_count: number;
  costs_cents: number;
  profit_cents: number;
  avg_ticket_cents: number;
  outstanding_debt_cents: number;
  outstanding_supplier_balance_cents: number;
}

interface DashboardSummary {
  branches: DashboardBranch[];
  total_revenue_cents: number;
  total_costs_cents: number;
  total_profit_cents: number;
  total_outstanding_debt_cents: number;
  total_outstanding_supplier_balance_cents: number;
}

type Range = "today" | "week" | "month";

function rangeStart(range: Range): Date {
  const now = new Date();
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function DashboardPage() {
  const token = useAuthStore((s) => s.token);
  const { fmt } = useCurrency();
  const [range, setRange] = useState<Range>("today");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const startIso = rangeStart(range).toISOString();
      const endIso = new Date().toISOString();
      const result = await invoke<DashboardSummary>("get_dashboard_summary_v3", { sessionToken: token, startIso, endIso });
      setSummary(result);
    } catch (err) {
      setLoadError(`تعذر تحميل لوحة التحكم: ${realErrorText(err)}`);
    } finally {
      setLoading(false);
    }
  }, [token, range]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  if (loadError || !summary) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-red-500 font-arabic">{loadError || "حدث خطأ في تحميل لوحة التحكم"}</p>
        <button onClick={fetchSummary} className="text-sm text-saffron-600 hover:text-saffron-700 font-bold font-arabic">إعادة المحاولة</button>
      </div>
    );
  }

  const isProfitable = summary.total_profit_cents >= 0;
  const multiBranch = summary.branches.length > 1;

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">لوحة التحكم</h1>
        <div className="flex gap-2">
          {(["today", "week", "month"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-4 py-2 rounded-lg font-arabic text-sm transition-colors ${
                range === r ? "bg-saffron-600 text-white shadow-sh-1" : "bg-white text-ink-500 hover:bg-ink-200"
              }`}
            >
              {r === "today" ? "اليوم" : r === "week" ? "هذا الأسبوع" : "هذا الشهر"}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic flex items-center gap-1"><IconTrendingUp className="w-4 h-4" /> الإيرادات</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">{fmt(summary.total_revenue_cents)}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic flex items-center gap-1"><IconTrendingDown className="w-4 h-4" /> المصروفات</p>
          <p className="text-2xl font-bold text-red-500 font-mono">{fmt(summary.total_costs_cents)}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic flex items-center gap-1"><IconCash className="w-4 h-4" /> صافي الربح</p>
          <p className={`text-2xl font-bold font-mono ${isProfitable ? "text-green-600" : "text-red-600"}`}>{fmt(summary.total_profit_cents)}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
          <p className="text-2xl font-bold text-ink-900 font-mono">{summary.branches.reduce((a, b) => a + b.order_count, 0)}</p>
        </div>
      </div>

      {/* Debt / supplier widgets */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl p-4 shadow-sh-1 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
              <IconUsers className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <p className="text-ink-400 text-sm font-arabic">ديون العملاء المستحقة</p>
              <p className="text-lg font-bold text-red-600 font-mono">{fmt(summary.total_outstanding_debt_cents)}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sh-1 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <IconTruck className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-ink-400 text-sm font-arabic">مستحقات الموردين</p>
              <p className="text-lg font-bold text-amber-600 font-mono">{fmt(summary.total_outstanding_supplier_balance_cents)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Branch comparison -- only shown when there's more than one branch to compare */}
      {multiBranch && (
        <div className="bg-white rounded-2xl shadow-sh-1 overflow-x-auto">
          <div className="p-4 pb-0">
            <h2 className="font-bold text-ink-900 font-arabic">مقارنة الفروع</h2>
          </div>
          <table className="w-full text-sm mt-2">
            <thead>
              <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                <th className="text-right p-3 font-medium">الفرع</th>
                <th className="text-center p-3 font-medium">الإيرادات</th>
                <th className="text-center p-3 font-medium">المصروفات</th>
                <th className="text-center p-3 font-medium">الربح</th>
                <th className="text-center p-3 font-medium">الطلبات</th>
                <th className="text-center p-3 font-medium">متوسط الفاتورة</th>
              </tr>
            </thead>
            <tbody>
              {[...summary.branches].sort((a, b) => b.profit_cents - a.profit_cents).map((b) => (
                <tr key={b.branch_id} className="border-b border-ink-200 hover:bg-white">
                  <td className="p-3 font-arabic text-ink-900 font-medium">{b.branch_name}</td>
                  <td className="p-3 text-center font-mono text-saffron-600">{fmt(b.revenue_cents)}</td>
                  <td className="p-3 text-center font-mono text-red-500">{fmt(b.costs_cents)}</td>
                  <td className={`p-3 text-center font-mono font-bold ${b.profit_cents >= 0 ? "text-green-600" : "text-red-600"}`}>{fmt(b.profit_cents)}</td>
                  <td className="p-3 text-center font-mono text-ink-900">{b.order_count}</td>
                  <td className="p-3 text-center font-mono text-ink-900">{fmt(b.avg_ticket_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!multiBranch && summary.branches.length === 0 && (
        <div className="text-center py-12 text-ink-500 font-arabic bg-white rounded-2xl shadow-sh-1">
          لا توجد بيانات لهذا الفرع بعد
        </div>
      )}
    </div>
  );
}
