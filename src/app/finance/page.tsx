import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import type { TaxMode } from "../../db/types";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";
import { IconEye, IconCreditCard, IconX } from "@tabler/icons-react";
import DatePicker from "../../components/ui/DatePicker";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import { toLocalDateStr, parseLocalDateStr, formatArabicDate } from "../../lib/dateLocal";

type Tab = "pnl" | "revenue" | "costs" | "invoices" | "taxes";
type DateRange = "today" | "week" | "month" | "custom";

// Mirrors dashboard/page.tsx's own shape for `get_dashboard_summary_v3` --
// this IS that same command (Repo::dashboard_summary), reused rather than
// reinvented, per-branch revenue/costs/profit already computed for a date
// range server-side. Only the fields the P&L tab actually renders are
// declared here.
interface PnlBranch {
  branch_id: string;
  branch_name: string;
  revenue_cents: number;
  costs_cents: number;
  profit_cents: number;
  order_count: number;
}

interface PnlSummary {
  branches: PnlBranch[];
  total_revenue_cents: number;
  total_costs_cents: number;
  total_profit_cents: number;
}

interface PnlTrendPoint {
  date: string;
  revenue: number;
  costs: number;
  profit: number;
}

interface RevenueRow {
  date: string;
  orderCount: number;
  cash: number;
  card: number;
  wallet: number;
  total: number;
}

interface CostRecord {
  id: string;
  category: string;
  amount_cents: number;
  notes: string | null;
  date: string;
}

interface Invoice {
  id: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  status: string;
  due_date: string;
  paid_at: string | null;
}

interface TaxInfo {
  tax_mode: TaxMode;
  tax_rate_cents: number;
}

function rangeStart(range: DateRange, customStart?: string): Date {
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
  if (range === "month") {
    const d = new Date(now);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (customStart) return parseLocalDateStr(customStart);
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function rangeEnd(range: DateRange, customEnd?: string): Date {
  const now = new Date();
  if (range === "today") return now;
  if (range === "week") return now;
  if (range === "month") return now;
  if (customEnd) {
    const d = parseLocalDateStr(customEnd);
    d.setHours(23, 59, 59, 999);
    return d;
  }
  return now;
}

const CATEGORY_OPTIONS = ["إيجار", "رواتب", "كهرباء", "مياه", "إنترنت", "صيانة", "مستلزمات", "تسويق", "أخرى"];

export default function FinancePage() {
  const token = useAuthStore((s) => s.token);
  const [tab, setTab] = useState<Tab>("pnl");
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null);
  const [pnlTrend, setPnlTrend] = useState<PnlTrendPoint[]>([]);
  const [pnlLoading, setPnlLoading] = useState(false);
  const [pnlError, setPnlError] = useState<string | null>(null);

  const [revenueData, setRevenueData] = useState<RevenueRow[]>([]);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [avgOrder, setAvgOrder] = useState(0);

  const [costs, setCosts] = useState<CostRecord[]>([]);
  const [totalCosts, setTotalCosts] = useState(0);
  const [showAddCost, setShowAddCost] = useState(false);
  const [costCategory, setCostCategory] = useState(CATEGORY_OPTIONS[0]);
  const [costAmount, setCostAmount] = useState("");
  const [costDate, setCostDate] = useState(toLocalDateStr(new Date()));
  const [costNotes, setCostNotes] = useState("");

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [showAddInvoice, setShowAddInvoice] = useState(false);
  const [showInvoiceDetail, setShowInvoiceDetail] = useState<Invoice | null>(null);
  const [invoicePeriodStart, setInvoicePeriodStart] = useState(() => {
    const d = new Date(); d.setDate(1); return toLocalDateStr(d);
  });
  const [invoicePeriodEnd, setInvoicePeriodEnd] = useState(() => toLocalDateStr(new Date()));
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDueDate, setInvoiceDueDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1); return toLocalDateStr(d);
  });
  const [savingCost, setSavingCost] = useState(false);
  const [savingInvoice, setSavingInvoice] = useState(false);

  const [taxInfo, setTaxInfo] = useState<TaxInfo | null>(null);
  const [taxCollectedToday, setTaxCollectedToday] = useState(0);

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const config = await invoke<{ currency: string; tax_mode: TaxMode; tax_rate_cents: number }>(
        "get_chain_config_v3", { sessionToken: token }
      );
      if (config) {
        setTaxInfo({ tax_mode: config.tax_mode, tax_rate_cents: config.tax_rate_cents });
      }

      const startDate = rangeStart(dateRange, customStart);
      const endDate = rangeEnd(dateRange, customEnd);
      const s = startDate.toISOString();
      const e = endDate.toISOString();

      const revenue = await invoke<{ order_count: number; total: number; cash: number; card: number; wallet: number }>(
        "get_finance_revenue_v3", { sessionToken: token, startIso: s, endIso: e }
      );

      setTotalRevenue(revenue.total);
      setTotalOrders(revenue.order_count);
      setAvgOrder(revenue.order_count > 0 ? revenue.total / revenue.order_count : 0);
      setRevenueData([{
        date: toLocalDateStr(startDate),
        orderCount: revenue.order_count,
        cash: revenue.cash,
        card: revenue.card,
        wallet: revenue.wallet,
        total: revenue.total,
      }]);

      const costRows = await invoke<CostRecord[]>("list_operational_costs_v3", { sessionToken: token });
      setCosts(costRows);
      setTotalCosts(costRows.reduce((acc, c) => acc + c.amount_cents, 0));

      const invoiceRows = await invoke<Invoice[]>("list_invoices_v3", { sessionToken: token });
      setInvoices(invoiceRows);

      const todayS = new Date();
      todayS.setHours(0, 0, 0, 0);
      const totalTax = await invoke<number>("get_tax_collected_v3", { sessionToken: token, sinceIso: todayS.toISOString() });
      setTaxCollectedToday(totalTax);
    } catch (err) {
      setMessage(`حدث خطأ في تحميل البيانات: ${realErrorText(err)}`);
    } finally {
      setLoading(false);
    }
  }, [dateRange, customStart, customEnd, token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // P&L (net profit) view: revenue - operational costs for the selected
  // range, reusing `get_dashboard_summary_v3` -- the same command
  // dashboard/page.tsx already uses for its own net-profit KPI -- instead
  // of inventing a new backend aggregate. The day-by-day trend below is
  // built client-side from the SAME existing endpoints the revenue/costs
  // tabs already call (`get_finance_revenue_v3` per day, `costs` already
  // loaded by fetchAll), capped at 31 days so a long custom range can't
  // fire an unbounded number of queries.
  const fetchPnl = useCallback(async () => {
    setPnlLoading(true);
    setPnlError(null);
    try {
      const startDate = rangeStart(dateRange, customStart);
      const endDate = rangeEnd(dateRange, customEnd);

      const summary = await invoke<PnlSummary>("get_dashboard_summary_v3", {
        sessionToken: token, startIso: startDate.toISOString(), endIso: endDate.toISOString(),
      });
      setPnlSummary(summary);

      const msPerDay = 24 * 60 * 60 * 1000;
      const spanDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / msPerDay) + 1);
      const dayCount = Math.min(31, spanDays);
      const days: Date[] = [];
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        if (d > endDate) break;
        days.push(d);
      }

      const trend = await Promise.all(days.map(async (day) => {
        const dayStart = new Date(day);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 59, 59, 999);
        const cappedEnd = dayEnd > endDate ? endDate : dayEnd;
        const rev = await invoke<{ total: number }>("get_finance_revenue_v3", {
          sessionToken: token, startIso: dayStart.toISOString(), endIso: cappedEnd.toISOString(),
        });
        const dayStr = toLocalDateStr(day);
        const dayCosts = costs
          .filter((c) => c.date.slice(0, 10) === dayStr)
          .reduce((acc, c) => acc + c.amount_cents, 0);
        return { date: dayStr, revenue: rev.total, costs: dayCosts, profit: rev.total - dayCosts };
      }));
      setPnlTrend(trend);
    } catch (err) {
      setPnlError(`تعذر تحميل بيانات الأرباح والخسائر: ${realErrorText(err)}`);
    } finally {
      setPnlLoading(false);
    }
  }, [dateRange, customStart, customEnd, token, costs]);

  useEffect(() => {
    if (tab === "pnl") fetchPnl();
    // Deliberately NOT depending on fetchPnl's own dateRange/customStart/
    // customEnd triggering this effect a second, redundant time -- it's
    // already in fetchPnl's own deps, so switching TO the tab or changing
    // the range while already on it both refresh correctly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, fetchPnl]);

  const [exportingPdf, setExportingPdf] = useState(false);

  const tabTitle = (t: Tab) =>
    t === "pnl" ? "الأرباح والخسائر" : t === "revenue" ? "الإيرادات" : t === "costs" ? "التكاليف" : t === "invoices" ? "الفواتير" : "الضرائب";

  const exportPdf = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    try {
      let tableHtml = "";
      if (tab === "pnl") {
        tableHtml =
          pdfTableHtml(
            "ملخص الأرباح والخسائر",
            ["البيان", "القيمة"],
            [
              ["إجمالي الإيرادات", formatMoney(pnlSummary?.total_revenue_cents ?? 0)],
              ["إجمالي التكاليف", formatMoney(pnlSummary?.total_costs_cents ?? 0)],
              ["صافي الربح", formatMoney(pnlSummary?.total_profit_cents ?? 0)],
            ]
          ) +
          pdfTableHtml(
            "الاتجاه اليومي",
            ["التاريخ", "الإيرادات", "التكاليف", "الربح"],
            pnlTrend.map((p) => [p.date, formatMoney(p.revenue), formatMoney(p.costs), formatMoney(p.profit)])
          );
      } else if (tab === "revenue") {
        tableHtml = pdfTableHtml(
          "الإيرادات",
          ["التاريخ", "عدد الطلبات", "نقدي", "بطاقة", "محفظة", "إجمالي"],
          revenueData.map((r) => [r.date, String(r.orderCount), formatMoney(r.cash), formatMoney(r.card), formatMoney(r.wallet), formatMoney(r.total)])
        );
      } else if (tab === "costs") {
        tableHtml = pdfTableHtml(
          "التكاليف",
          ["التاريخ", "البند", "التكلفة", "الملاحظات"],
          costs.map((c) => [c.date, c.category, formatMoney(c.amount_cents), c.notes ?? ""])
        );
      } else if (tab === "invoices") {
        tableHtml = pdfTableHtml(
          "الفواتير",
          ["رقم الفاتورة", "الفترة", "المبلغ", "الحالة", "تاريخ الاستحقاق"],
          invoices.map((inv) => [inv.id.slice(0, 8), `${inv.period_start.slice(0, 10)} - ${inv.period_end.slice(0, 10)}`, formatMoney(inv.amount_cents), inv.status, inv.due_date.slice(0, 10)])
        );
      } else if (tab === "taxes") {
        tableHtml = pdfTableHtml(
          "الضرائب",
          ["البيان", "القيمة"],
          [
            ["نظام الضريبة", taxInfo?.tax_mode === "inclusive" ? "شامل" : "غير شامل"],
            ["نسبة الضريبة", `${((taxInfo?.tax_rate_cents ?? 0) / 100).toFixed(2)}%`],
            ["إجمالي الضريبة المحصلة اليوم", formatMoney(taxCollectedToday)],
          ]
        );
      }
      const bodyHtml = `
        <h1 style="font-size:22px;font-weight:700;text-align:center;margin:0 0 4px">تقرير ${tabTitle(tab)}</h1>
        <p style="font-size:11px;color:#667085;text-align:center;margin:0 0 16px">${formatArabicDate(new Date())}</p>
        ${tableHtml}
      `;
      await exportHtmlToPdf(`تقرير-${tab}-${toLocalDateStr(new Date())}.pdf`, bodyHtml, token ?? "");
    } finally {
      setExportingPdf(false);
    }
  };

  const handleAddCost = async () => {
    if (savingCost) return;
    const amount = parseMoneyInput(costAmount);
    if (amount <= 0) {
      setMessage("يرجى إدخال مبلغ صحيح");
      return;
    }
    setSavingCost(true);
    try {
      await invoke("create_operational_cost_v3", { sessionToken: token, category: costCategory, amountCents: amount, date: costDate, notes: costNotes || null });
      setShowAddCost(false);
      setCostAmount("");
      setCostNotes("");
      setMessage("تم إضافة التكلفة بنجاح");
      fetchAll();
    } catch (err) {
      setMessage(`حدث خطأ في إضافة التكلفة: ${realErrorText(err)}`);
    } finally {
      setSavingCost(false);
    }
  };

  const handleAddInvoice = async () => {
    if (savingInvoice) return;
    const amount = parseMoneyInput(invoiceAmount);
    if (amount <= 0) { setMessage("يرجى إدخال مبلغ صحيح"); return; }
    setSavingInvoice(true);
    try {
      await invoke("create_invoice_v3", { sessionToken: token, periodStart: invoicePeriodStart, periodEnd: invoicePeriodEnd, amountCents: amount, dueDate: invoiceDueDate });
      setShowAddInvoice(false);
      setInvoiceAmount("");
      setMessage("تم إنشاء الفاتورة بنجاح");
      fetchAll();
    } catch (err) {
      setMessage(`حدث خطأ في إنشاء الفاتورة: ${realErrorText(err)}`);
    } finally {
      setSavingInvoice(false);
    }
  };

  const handlePayInvoice = async (inv: Invoice) => {
    try {
      await invoke("mark_invoice_paid_v3", { sessionToken: token, invoiceId: inv.id });
      setMessage("تم دفع الفاتورة بنجاح");
      fetchAll();
    } catch (err) {
      setMessage(`حدث خطأ في دفع الفاتورة: ${realErrorText(err)}`);
    }
  };

  const statusBadge = (status: string) => {
    if (status === "PAID") return "bg-ok-100 text-ok-700";
    if (status === "PENDING") return "bg-warn-100 text-warn-700";
    if (status === "OVERDUE") return "bg-danger-100 text-danger-600";
    return "bg-white text-ink-500";
  };

  const statusLabel = (status: string) => {
    if (status === "PAID") return "مدفوعة";
    if (status === "PENDING") return "قيد الانتظار";
    if (status === "OVERDUE") return "متأخرة";
    return status;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">المالية والمحاسبة</h1>
        <button
          onClick={exportPdf}
          disabled={exportingPdf}
          className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
        >
          {exportingPdf ? "جاري التصدير..." : "تصدير PDF"}
        </button>
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["pnl", "revenue", "costs", "invoices", "taxes"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
              tab === t
                ? "bg-saffron-600 text-white"
                : "text-ink-500 hover:text-saffron-600 hover:bg-white"
            }`}
          >
            {t === "pnl" ? "الأرباح والخسائر" : t === "revenue" ? "الإيرادات" : t === "costs" ? "التكاليف" : t === "invoices" ? "الفواتير" : "الضرائب"}
          </button>
        ))}
      </div>

      {tab === "pnl" && (
        <div className="space-y-4">
          {pnlLoading && (
            <div className="text-center py-6 text-ink-500 font-arabic">جاري التحميل...</div>
          )}
          {pnlError && (
            <div className="text-center py-3 text-danger font-arabic">{pnlError}</div>
          )}
          {!pnlLoading && pnlSummary && (
            <>
              <div className="flex gap-2">
                {(["today", "week", "month", "custom"] as DateRange[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setDateRange(r)}
                    className={`px-4 py-2 rounded-lg font-arabic text-sm transition-colors ${
                      dateRange === r
                        ? "bg-saffron-600 text-white"
                        : "bg-white text-ink-500 hover:bg-ink-200"
                    }`}
                  >
                    {r === "today" ? "اليوم" : r === "week" ? "هذا الأسبوع" : r === "month" ? "هذا الشهر" : "مخصص"}
                  </button>
                ))}
              </div>
              {dateRange === "custom" && (
                <div className="flex gap-3">
                  <DatePicker value={customStart} onChange={(v) => setCustomStart(v)} className="h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
                  <DatePicker value={customEnd} onChange={(v) => setCustomEnd(v)} className="h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
                </div>
              )}

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-md p-4 space-y-1 border border-ink-200">
                  <p className="text-ink-400 text-sm font-arabic">إجمالي الإيرادات</p>
                  <p className="text-2xl font-bold text-saffron-600 font-mono">{formatMoney(pnlSummary.total_revenue_cents)}</p>
                </div>
                <div className="bg-white rounded-md p-4 space-y-1 border border-ink-200">
                  <p className="text-ink-400 text-sm font-arabic">إجمالي التكاليف</p>
                  <p className="text-2xl font-bold text-danger-600 font-mono">{formatMoney(pnlSummary.total_costs_cents)}</p>
                </div>
                <div className="bg-white rounded-md p-4 space-y-1 border border-ink-200">
                  <p className="text-ink-400 text-sm font-arabic">صافي الربح</p>
                  <p className={`text-2xl font-bold font-mono ${pnlSummary.total_profit_cents >= 0 ? "text-ok" : "text-danger"}`}>
                    {formatMoney(pnlSummary.total_profit_cents)}
                  </p>
                </div>
              </div>

              {pnlSummary.branches.length > 1 && (
                <div className="zc-card overflow-x-auto">
                  <div className="p-4 pb-0">
                    <h2 className="font-bold text-ink-900 font-arabic">حسب الفرع</h2>
                  </div>
                  <table className="w-full text-sm mt-2">
                    <thead>
                      <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
                        <th className="text-right p-3 font-medium">الفرع</th>
                        <th className="text-center p-3 font-medium">الإيرادات</th>
                        <th className="text-center p-3 font-medium">التكاليف</th>
                        <th className="text-center p-3 font-medium">الربح</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...pnlSummary.branches].sort((a, b) => b.profit_cents - a.profit_cents).map((b) => (
                        <tr key={b.branch_id} className="border-b border-ink-100 hover:bg-saffron-50">
                          <td className="p-3 font-arabic text-ink-900 font-medium">{b.branch_name}</td>
                          <td className="p-3 text-center font-mono text-saffron-600">{formatMoney(b.revenue_cents)}</td>
                          <td className="p-3 text-center font-mono text-danger">{formatMoney(b.costs_cents)}</td>
                          <td className={`p-3 text-center font-mono font-bold ${b.profit_cents >= 0 ? "text-ok" : "text-danger"}`}>{formatMoney(b.profit_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="zc-card overflow-x-auto">
                <div className="p-4 pb-0">
                  <h2 className="font-bold text-ink-900 font-arabic">الاتجاه اليومي</h2>
                  {pnlTrend.length >= 31 && (
                    <p className="text-[10px] text-ink-400 font-arabic mt-1">يُعرض حتى 31 يوماً كحد أقصى ضمن الفترة المحددة</p>
                  )}
                </div>
                <table className="w-full text-sm mt-2">
                  <thead>
                    <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
                      <th className="text-right p-3 font-medium">التاريخ</th>
                      <th className="text-center p-3 font-medium">الإيرادات</th>
                      <th className="text-center p-3 font-medium">التكاليف</th>
                      <th className="text-center p-3 font-medium">الربح</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pnlTrend.map((p) => (
                      <tr key={p.date} className="border-b border-ink-100 hover:bg-saffron-50">
                        <td className="p-3 font-arabic text-ink-900">{p.date}</td>
                        <td className="p-3 text-center font-mono text-saffron-600">{formatMoney(p.revenue)}</td>
                        <td className="p-3 text-center font-mono text-danger">{formatMoney(p.costs)}</td>
                        <td className={`p-3 text-center font-mono font-bold ${p.profit >= 0 ? "text-ok" : "text-danger"}`}>{formatMoney(p.profit)}</td>
                      </tr>
                    ))}
                    {pnlTrend.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-6 text-center text-ink-500 font-arabic">لا توجد بيانات</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "revenue" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            {(["today", "week", "month", "custom"] as DateRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                className={`px-4 py-2 rounded-lg font-arabic text-sm transition-colors ${
                  dateRange === r
                    ? "bg-saffron-600 text-white"
                    : "bg-white text-ink-500 hover:bg-ink-200"
                }`}
              >
                {r === "today" ? "اليوم" : r === "week" ? "هذا الأسبوع" : r === "month" ? "هذا الشهر" : "مخصص"}
              </button>
            ))}
          </div>
          {dateRange === "custom" && (
            <div className="flex gap-3">
              <DatePicker
                value={customStart}
                onChange={(v) => setCustomStart(v)}
                className="h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
              />
              <DatePicker
                value={customEnd}
                onChange={(v) => setCustomEnd(v)}
                className="h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-md p-4 space-y-1 border border-ink-200">
              <p className="text-ink-400 text-sm font-arabic">إجمالي الإيرادات</p>
              <p className="text-2xl font-bold text-saffron-600 font-mono">
                {formatMoney(totalRevenue)}
              </p>
            </div>
            <div className="bg-white rounded-md p-4 space-y-1 border border-ink-200">
              <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
              <p className="text-2xl font-bold text-ink-900">{totalOrders}</p>
            </div>
            <div className="bg-white rounded-md p-4 space-y-1 border border-ink-200">
              <p className="text-ink-400 text-sm font-arabic">متوسط قيمة الطلب</p>
              <p className="text-2xl font-bold text-ink-900 font-mono">
                {formatMoney(avgOrder)}
              </p>
            </div>
          </div>

          <div className="zc-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">التاريخ</th>
                  <th className="text-right p-3 font-medium">عدد الطلبات</th>
                  <th className="text-right p-3 font-medium">نقدي</th>
                  <th className="text-right p-3 font-medium">بطاقة</th>
                  <th className="text-right p-3 font-medium">محفظة</th>
                  <th className="text-right p-3 font-medium">إجمالي</th>
                </tr>
              </thead>
              <tbody>
                {revenueData.map((r, i) => (
                  <tr key={i} className="border-b border-ink-200 hover:bg-saffron-50">
                    <td className="p-3 font-arabic text-ink-900">{r.date}</td>
                    <td className="p-3 font-mono text-ink-900">{r.orderCount}</td>
                    <td className="p-3 font-mono text-saffron-600">{formatMoney(r.cash)}</td>
                    <td className="p-3 font-mono text-ink-700">{formatMoney(r.card)}</td>
                    <td className="p-3 font-mono text-ink-700">{formatMoney(r.wallet)}</td>
                    <td className="p-3 font-mono text-saffron-600 font-bold">{formatMoney(r.total)}</td>
                  </tr>
                ))}
                {revenueData.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-ink-500 font-arabic">
                      لا توجد بيانات
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "costs" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="bg-white rounded-md p-4 border border-ink-200 flex-1 max-w-xs">
              <p className="text-ink-400 text-sm font-arabic">إجمالي التكاليف</p>
              <p className="text-2xl font-bold text-danger-600 font-mono">
                {formatMoney(totalCosts)}
              </p>
            </div>
            <button
              onClick={() => setShowAddCost(true)}
              className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
            >
              + إضافة تكلفة
            </button>
          </div>

          <div className="zc-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">التاريخ</th>
                  <th className="text-right p-3 font-medium">البند</th>
                  <th className="text-right p-3 font-medium">التكلفة</th>
                  <th className="text-right p-3 font-medium">الملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="border-b border-ink-200 hover:bg-saffron-50">
                    <td className="p-3 font-arabic text-ink-900">{c.date.slice(0, 10)}</td>
                    <td className="p-3">
                      <span className="inline-block px-3 py-1 rounded-full text-xs font-arabic bg-white text-ink-900">
                        {c.category}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-danger-600 font-bold">{formatMoney(c.amount_cents)}</td>
                    <td className="p-3 text-ink-400 text-sm">{c.notes || "-"}</td>
                  </tr>
                ))}
                {costs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-ink-500 font-arabic">
                      لا توجد تكاليف مسجلة
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "invoices" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="bg-white rounded-md p-4 border border-ink-200 flex-1 max-w-xs">
              <p className="text-ink-400 text-sm font-arabic">إجمالي الفواتير المستحقة</p>
              <p className="text-2xl font-bold text-warn-600 font-mono">
                {formatMoney(invoices.filter((i) => i.status === "PENDING" || i.status === "OVERDUE").reduce((a, i) => a + i.amount_cents, 0))}
              </p>
            </div>
            <button
              onClick={() => setShowAddInvoice(true)}
              className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
            >
              + إنشاء فاتورة
            </button>
          </div>
          <div className="zc-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-surface-alt text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">رقم الفاتورة</th>
                  <th className="text-right p-3 font-medium">الفترة</th>
                  <th className="text-right p-3 font-medium">المبلغ</th>
                  <th className="text-right p-3 font-medium">الحالة</th>
                  <th className="text-right p-3 font-medium">تاريخ الاستحقاق</th>
                  <th className="text-center p-3 font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-ink-200 hover:bg-saffron-50">
                    <td className="p-3 font-mono text-ink-900">{inv.id.slice(0, 8)}</td>
                    <td className="p-3 text-ink-900 text-sm">
                      {inv.period_start.slice(0, 10)} - {inv.period_end.slice(0, 10)}
                    </td>
                    <td className="p-3 font-mono text-saffron-600 font-bold">{formatMoney(inv.amount_cents)}</td>
                    <td className="p-3">
                      <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${statusBadge(inv.status)}`}>
                        {statusLabel(inv.status)}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-ink-500">{inv.due_date.slice(0, 10)}</td>
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button onClick={() => setShowInvoiceDetail(inv)} className="px-3 py-1 rounded-lg text-xs text-ink-400 hover:bg-white transition-colors" title="عرض التفاصيل"><IconEye className="w-4 h-4" /></button>
                        {inv.status === "PENDING" && (
                          <button onClick={() => handlePayInvoice(inv)} className="px-3 py-1 rounded-lg text-xs font-arabic text-saffron-600 hover:bg-saffron-50 transition-colors inline-flex items-center gap-1"><IconCreditCard className="w-4 h-4" /> دفع</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {invoices.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-ink-500 font-arabic">لا توجد فواتير</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "taxes" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-md p-4 border border-ink-200 space-y-2">
              <h2 className="font-bold text-ink-900 font-arabic">إعدادات الضريبة</h2>
              <div className="flex justify-between text-sm">
                <span className="text-ink-400 font-arabic">النظام</span>
                <span className="font-arabic font-medium text-ink-900">
                  {taxInfo?.tax_mode === "inclusive" ? "شامل" : "غير شامل"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-ink-400 font-arabic">النسبة</span>
                <span className="font-mono font-bold text-ink-900">
                  {((taxInfo?.tax_rate_cents ?? 0) / 100).toFixed(2)}%
                </span>
              </div>
            </div>
            <div className="bg-white rounded-md p-4 border border-ink-200 space-y-2">
              <h2 className="font-bold text-ink-900 font-arabic">الضريبة المحصلة اليوم</h2>
              <p className="text-2xl font-bold text-saffron-600 font-mono">
                {formatMoney(taxCollectedToday)}
              </p>
              <button
                onClick={exportPdf}
                disabled={exportingPdf}
                className="h-10 px-4 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
              >
                {exportingPdf ? "جاري التصدير..." : "تصدير PDF للإقرار"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">إنشاء فاتورة جديدة</h2>
              <button onClick={() => setShowAddInvoice(false)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0"><IconX className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">بداية الفترة</label>
                <DatePicker value={invoicePeriodStart} onChange={(v) => setInvoicePeriodStart(v)} className="w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">نهاية الفترة</label>
                <DatePicker value={invoicePeriodEnd} onChange={(v) => setInvoicePeriodEnd(v)} className="w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ (ريال)</label>
                <input type="number" min="0" step="0.01" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} className="w-full h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500" dir="ltr" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ الاستحقاق</label>
                <DatePicker value={invoiceDueDate} onChange={(v) => setInvoiceDueDate(v)} className="w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowAddInvoice(false)} className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={handleAddInvoice} disabled={savingInvoice} className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-40">{savingInvoice ? "جاري..." : "إنشاء الفاتورة"}</button>
            </div>
          </div>
        </div>
      )}

      {showInvoiceDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">تفاصيل الفاتورة</h2>
              <button onClick={() => setShowInvoiceDetail(null)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0"><IconX className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><span className="text-ink-400 font-arabic">رقم الفاتورة: </span><span className="font-mono text-ink-900">{showInvoiceDetail.id.slice(0, 8)}</span></div>
              <div><span className="text-ink-400 font-arabic">الحالة: </span><span className={`font-arabic font-medium ${showInvoiceDetail.status === "PAID" ? "text-ok-600" : showInvoiceDetail.status === "OVERDUE" ? "text-danger-600" : "text-warn-600"}`}>{statusLabel(showInvoiceDetail.status)}</span></div>
              <div><span className="text-ink-400 font-arabic">الفترة: </span><span className="text-ink-900">{showInvoiceDetail.period_start.slice(0, 10)} - {showInvoiceDetail.period_end.slice(0, 10)}</span></div>
              <div><span className="text-ink-400 font-arabic">تاريخ الاستحقاق: </span><span className="text-ink-900">{showInvoiceDetail.due_date.slice(0, 10)}</span></div>
              {showInvoiceDetail.paid_at && <div><span className="text-ink-400 font-arabic">تاريخ الدفع: </span><span className="text-ink-900">{showInvoiceDetail.paid_at.slice(0, 10)}</span></div>}
            </div>
            <div className="text-center py-4">
              <p className="text-sm text-ink-400 font-arabic">المبلغ</p>
              <p className="text-3xl font-bold text-saffron-600 font-mono">{formatMoney(showInvoiceDetail.amount_cents)}</p>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowInvoiceDetail(null)} className="px-6 h-10 rounded-sm border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إغلاق</button>
              {showInvoiceDetail.status === "PENDING" && (
                <button onClick={() => { handlePayInvoice(showInvoiceDetail); setShowInvoiceDetail(null); }} className="flex-1 h-10 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors inline-flex items-center justify-center gap-1.5"><IconCreditCard className="w-4 h-4" /> دفع الفاتورة</button>
              )}
            </div>
          </div>
        </div>
      )}

      {showAddCost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-md shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">إضافة تكلفة</h2>
              <button onClick={() => setShowAddCost(false)} className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center text-ink-500 shrink-0"><IconX className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">البند</label>
                <select
                  value={costCategory}
                  onChange={(e) => setCostCategory(e.target.value)}
                  className="w-full h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
                >
                  {CATEGORY_OPTIONS.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={costAmount}
                  onChange={(e) => setCostAmount(e.target.value)}
                  className="w-full h-10 px-4 rounded-sm bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">التاريخ</label>
                <DatePicker
                  value={costDate}
                  onChange={(v) => setCostDate(v)}
                  className="w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">ملاحظات</label>
                <textarea
                  value={costNotes}
                  onChange={(e) => setCostNotes(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2 rounded-sm bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowAddCost(false)}
                className="h-10 px-6 rounded-sm bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={handleAddCost}
                disabled={savingCost}
                className="h-10 px-6 rounded-sm bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors disabled:opacity-40"
              >
                {savingCost ? "جاري..." : "إضافة"}
              </button>
            </div>
          </div>
        </div>
      )}

      {message && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-saffron-600 text-white px-6 py-3 rounded-sm border border-ink-200 z-50 font-arabic">
          {message}
        </div>
      )}
    </div>
  );
}
