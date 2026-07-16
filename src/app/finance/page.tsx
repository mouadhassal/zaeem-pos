import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../../db";
import { useAuthStore } from "../../stores/authStore";
import type { TaxMode } from "../../db/types";

type Tab = "revenue" | "costs" | "invoices" | "taxes";
type DateRange = "today" | "week" | "month" | "custom";

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
  return new Date(customStart || now.toISOString().slice(0, 10));
}

function rangeEnd(range: DateRange, customEnd?: string): Date {
  const now = new Date();
  if (range === "today") return now;
  if (range === "week") return now;
  if (range === "month") return now;
  return new Date(customEnd || now.toISOString().slice(0, 10) + "T23:59:59");
}

function fmtCents(c: number): string {
  return (c / 100).toFixed(2);
}

function fmtCurrency(cents: number, curr: string = "SAR"): string {
  return new Intl.NumberFormat("ar-SA", {
    style: "currency",
    currency: curr,
  }).format(cents / 100);
}

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

const CATEGORY_OPTIONS = ["إيجار", "رواتب", "كهرباء", "مياه", "إنترنت", "صيانة", "مستلزمات", "تسويق", "أخرى"];

export default function FinancePage() {
  const token = useAuthStore((s) => s.token);
  const [tab, setTab] = useState<Tab>("revenue");
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [currency, setCurrency] = useState("SAR");

  const [revenueData, setRevenueData] = useState<RevenueRow[]>([]);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [avgOrder, setAvgOrder] = useState(0);

  const [costs, setCosts] = useState<CostRecord[]>([]);
  const [totalCosts, setTotalCosts] = useState(0);
  const [showAddCost, setShowAddCost] = useState(false);
  const [costCategory, setCostCategory] = useState(CATEGORY_OPTIONS[0]);
  const [costAmount, setCostAmount] = useState("");
  const [costDate, setCostDate] = useState(new Date().toISOString().slice(0, 10));
  const [costNotes, setCostNotes] = useState("");

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [showAddInvoice, setShowAddInvoice] = useState(false);
  const [showInvoiceDetail, setShowInvoiceDetail] = useState<Invoice | null>(null);
  const [invoicePeriodStart, setInvoicePeriodStart] = useState(() => {
    const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10);
  });
  const [invoicePeriodEnd, setInvoicePeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDueDate, setInvoiceDueDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10);
  });

  const [taxInfo, setTaxInfo] = useState<TaxInfo | null>(null);
  const [taxCollectedToday, setTaxCollectedToday] = useState(0);

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();

      const config = await db
        .selectFrom("chain_config")
        .select(["currency", "tax_mode", "tax_rate_cents"])
        .where("id", "=", "default")
        .executeTakeFirst();
      if (config) {
        setCurrency(config.currency);
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
        date: startDate.toISOString().slice(0, 10),
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
    } catch {
      setMessage("حدث خطأ في تحميل البيانات");
    } finally {
      setLoading(false);
    }
  }, [dateRange, customStart, customEnd, token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const exportCsv = () => {
    const rows: string[][] = [];
    if (tab === "revenue") {
      rows.push(["التاريخ", "عدد الطلبات", "نقدي", "بطاقة", "محفظة", "إجمالي"]);
      for (const r of revenueData) {
        rows.push([r.date, String(r.orderCount), fmtCents(r.cash), fmtCents(r.card), fmtCents(r.wallet), fmtCents(r.total)]);
      }
    } else if (tab === "costs") {
      rows.push(["التاريخ", "البند", "التكلفة", "الملاحظات"]);
      for (const c of costs) {
        rows.push([c.date, c.category, fmtCents(c.amount_cents), c.notes ?? ""]);
      }
    } else if (tab === "invoices") {
      rows.push(["رقم الفاتورة", "الفترة", "المبلغ", "الحالة", "تاريخ الاستحقاق"]);
      for (const inv of invoices) {
        rows.push([inv.id.slice(0, 8), `${inv.period_start.slice(0, 10)} - ${inv.period_end.slice(0, 10)}`, fmtCents(inv.amount_cents), inv.status, inv.due_date.slice(0, 10)]);
      }
    } else if (tab === "taxes") {
      rows.push(["البيان", "القيمة"]);
      rows.push(["نظام الضريبة", taxInfo?.tax_mode === "inclusive" ? "شامل" : "غير شامل"]);
      rows.push(["نسبة الضريبة", `${((taxInfo?.tax_rate_cents ?? 0) / 100).toFixed(2)}%`]);
      rows.push(["إجمالي الضريبة المحصلة اليوم", fmtCents(taxCollectedToday)]);
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `تقرير-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAddCost = async () => {
    const amount = Math.round(parseFloat(costAmount || "0") * 100);
    if (amount <= 0) {
      setMessage("يرجى إدخال مبلغ صحيح");
      return;
    }
    try {
      await invoke("create_operational_cost_v3", { sessionToken: token, category: costCategory, amountCents: amount, date: costDate, notes: costNotes || null });
      setShowAddCost(false);
      setCostAmount("");
      setCostNotes("");
      setMessage("تم إضافة التكلفة بنجاح");
      fetchAll();
    } catch {
      setMessage("حدث خطأ في إضافة التكلفة");
    }
  };

  const handleAddInvoice = async () => {
    const amount = Math.round(parseFloat(invoiceAmount || "0") * 100);
    if (amount <= 0) { setMessage("يرجى إدخال مبلغ صحيح"); return; }
    try {
      await invoke("create_invoice_v3", { sessionToken: token, periodStart: invoicePeriodStart, periodEnd: invoicePeriodEnd, amountCents: amount, dueDate: invoiceDueDate });
      setShowAddInvoice(false);
      setInvoiceAmount("");
      setMessage("تم إنشاء الفاتورة بنجاح");
      fetchAll();
    } catch {
      setMessage("حدث خطأ في إنشاء الفاتورة");
    }
  };

  const handlePayInvoice = async (inv: Invoice) => {
    try {
      await invoke("mark_invoice_paid_v3", { sessionToken: token, invoiceId: inv.id });
      setMessage("تم دفع الفاتورة بنجاح");
      fetchAll();
    } catch {
      setMessage("حدث خطأ في دفع الفاتورة");
    }
  };

  const statusBadge = (status: string) => {
    if (status === "PAID") return "bg-saffron-100 text-saffron-600";
    if (status === "PENDING") return "bg-amber-100 text-amber-700";
    if (status === "OVERDUE") return "bg-red-100 text-red-700";
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
          onClick={exportCsv}
          className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors flex items-center gap-2"
        >
          📤 تصدير التقرير
        </button>
      </div>

      <div className="flex gap-2 border-b border-ink-200 pb-2">
        {(["revenue", "costs", "invoices", "taxes"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-t-lg font-arabic font-medium text-sm transition-colors ${
              tab === t
                ? "bg-saffron-600 text-white shadow-sm"
                : "text-ink-500 hover:text-saffron-600 hover:bg-white"
            }`}
          >
            {t === "revenue" ? "الإيرادات" : t === "costs" ? "التكاليف" : t === "invoices" ? "الفواتير" : "الضرائب"}
          </button>
        ))}
      </div>

      {tab === "revenue" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            {(["today", "week", "month", "custom"] as DateRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                className={`px-4 py-2 rounded-lg font-arabic text-sm transition-colors ${
                  dateRange === r
                    ? "bg-saffron-600 text-white shadow-sm"
                    : "bg-white text-ink-500 hover:bg-ink-200"
                }`}
              >
                {r === "today" ? "اليوم" : r === "week" ? "هذا الأسبوع" : r === "month" ? "هذا الشهر" : "مخصص"}
              </button>
            ))}
          </div>
          {dateRange === "custom" && (
            <div className="flex gap-3">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
              />
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sm">
              <p className="text-ink-400 text-sm font-arabic">إجمالي الإيرادات</p>
              <p className="text-2xl font-bold text-saffron-600 font-mono">
                {fmtCurrency(totalRevenue, currency)}
              </p>
            </div>
            <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sm">
              <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
              <p className="text-2xl font-bold text-ink-900">{totalOrders}</p>
            </div>
            <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sm">
              <p className="text-ink-400 text-sm font-arabic">متوسط قيمة الطلب</p>
              <p className="text-2xl font-bold text-ink-900 font-mono">
                {fmtCurrency(avgOrder, currency)}
              </p>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
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
                  <tr key={i} className="border-b border-ink-200 hover:bg-white">
                    <td className="p-3 font-arabic text-ink-900">{r.date}</td>
                    <td className="p-3 font-mono text-ink-900">{r.orderCount}</td>
                    <td className="p-3 font-mono text-saffron-600">{fmtCurrency(r.cash, currency)}</td>
                    <td className="p-3 font-mono text-blue-600">{fmtCurrency(r.card, currency)}</td>
                    <td className="p-3 font-mono text-amber-600">{fmtCurrency(r.wallet, currency)}</td>
                    <td className="p-3 font-mono text-saffron-600 font-bold">{fmtCurrency(r.total, currency)}</td>
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
            <div className="bg-white rounded-2xl p-4 shadow-sm flex-1 max-w-xs">
              <p className="text-ink-400 text-sm font-arabic">إجمالي التكاليف</p>
              <p className="text-2xl font-bold text-red-500 font-mono">
                {fmtCurrency(totalCosts, currency)}
              </p>
            </div>
            <button
              onClick={() => setShowAddCost(true)}
              className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
            >
              + إضافة تكلفة
            </button>
          </div>

          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
                  <th className="text-right p-3 font-medium">التاريخ</th>
                  <th className="text-right p-3 font-medium">البند</th>
                  <th className="text-right p-3 font-medium">التكلفة</th>
                  <th className="text-right p-3 font-medium">الملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="border-b border-ink-200 hover:bg-white">
                    <td className="p-3 font-arabic text-ink-900">{c.date.slice(0, 10)}</td>
                    <td className="p-3">
                      <span className="inline-block px-3 py-1 rounded-full text-xs font-arabic bg-white text-ink-900">
                        {c.category}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-red-500 font-bold">{fmtCurrency(c.amount_cents, currency)}</td>
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
            <div className="bg-white rounded-2xl p-4 shadow-sm flex-1 max-w-xs">
              <p className="text-ink-400 text-sm font-arabic">إجمالي الفواتير المستحقة</p>
              <p className="text-2xl font-bold text-amber-600 font-mono">
                {fmtCurrency(invoices.filter((i) => i.status === "PENDING" || i.status === "OVERDUE").reduce((a, i) => a + i.amount_cents, 0), currency)}
              </p>
            </div>
            <button
              onClick={() => setShowAddInvoice(true)}
              className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
            >
              + إنشاء فاتورة
            </button>
          </div>
          <div className="bg-white rounded-2xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-400 font-arabic">
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
                  <tr key={inv.id} className="border-b border-ink-200 hover:bg-white">
                    <td className="p-3 font-mono text-ink-900">{inv.id.slice(0, 8)}</td>
                    <td className="p-3 text-ink-900 text-sm">
                      {inv.period_start.slice(0, 10)} - {inv.period_end.slice(0, 10)}
                    </td>
                    <td className="p-3 font-mono text-saffron-600 font-bold">{fmtCurrency(inv.amount_cents, currency)}</td>
                    <td className="p-3">
                      <span className={`inline-block px-3 py-1 rounded-full text-xs font-arabic font-medium ${statusBadge(inv.status)}`}>
                        {statusLabel(inv.status)}
                      </span>
                    </td>
                    <td className="p-3 font-mono text-ink-500">{inv.due_date.slice(0, 10)}</td>
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button onClick={() => setShowInvoiceDetail(inv)} className="px-3 py-1 rounded-lg text-xs text-ink-400 hover:bg-white transition-colors" title="عرض التفاصيل">👁️</button>
                        {inv.status === "PENDING" && (
                          <button onClick={() => handlePayInvoice(inv)} className="px-3 py-1 rounded-lg text-xs font-arabic text-saffron-600 hover:bg-saffron-50 transition-colors">💳 دفع</button>
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
            <div className="bg-white rounded-2xl p-4 shadow-sm space-y-2">
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
            <div className="bg-white rounded-2xl p-4 shadow-sm space-y-2">
              <h2 className="font-bold text-ink-900 font-arabic">الضريبة المحصلة اليوم</h2>
              <p className="text-2xl font-bold text-saffron-600 font-mono">
                {fmtCurrency(taxCollectedToday, currency)}
              </p>
              <button
                onClick={exportCsv}
                className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
              >
                تصدير CSV للإقرار
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">إنشاء فاتورة جديدة</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">بداية الفترة</label>
                <input type="date" value={invoicePeriodStart} onChange={(e) => setInvoicePeriodStart(e.target.value)} className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">نهاية الفترة</label>
                <input type="date" value={invoicePeriodEnd} onChange={(e) => setInvoicePeriodEnd(e.target.value)} className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">المبلغ (ريال)</label>
                <input type="number" min="0" step="0.01" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500" dir="ltr" />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">تاريخ الاستحقاق</label>
                <input type="date" value={invoiceDueDate} onChange={(e) => setInvoiceDueDate(e.target.value)} className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500" />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowAddInvoice(false)} className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors">إلغاء</button>
              <button onClick={handleAddInvoice} className="h-10 px-6 rounded-xl bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors">إنشاء الفاتورة</button>
            </div>
          </div>
        </div>
      )}

      {showInvoiceDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold font-arabic text-ink-900">تفاصيل الفاتورة</h2>
              <button onClick={() => setShowInvoiceDetail(null)} className="text-ink-500 hover:text-ink-500 text-xl leading-none">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><span className="text-ink-400 font-arabic">رقم الفاتورة: </span><span className="font-mono text-ink-900">{showInvoiceDetail.id.slice(0, 8)}</span></div>
              <div><span className="text-ink-400 font-arabic">الحالة: </span><span className={`font-arabic font-medium ${showInvoiceDetail.status === "PAID" ? "text-saffron-600" : showInvoiceDetail.status === "OVERDUE" ? "text-red-500" : "text-amber-600"}`}>{statusLabel(showInvoiceDetail.status)}</span></div>
              <div><span className="text-ink-400 font-arabic">الفترة: </span><span className="text-ink-900">{showInvoiceDetail.period_start.slice(0, 10)} - {showInvoiceDetail.period_end.slice(0, 10)}</span></div>
              <div><span className="text-ink-400 font-arabic">تاريخ الاستحقاق: </span><span className="text-ink-900">{showInvoiceDetail.due_date.slice(0, 10)}</span></div>
              {showInvoiceDetail.paid_at && <div><span className="text-ink-400 font-arabic">تاريخ الدفع: </span><span className="text-ink-900">{showInvoiceDetail.paid_at.slice(0, 10)}</span></div>}
            </div>
            <div className="text-center py-4">
              <p className="text-sm text-ink-400 font-arabic">المبلغ</p>
              <p className="text-3xl font-bold text-saffron-600 font-mono">{fmtCurrency(showInvoiceDetail.amount_cents, currency)}</p>
            </div>
            <div className="flex gap-2 pt-2">
              {showInvoiceDetail.status === "PENDING" && (
                <button onClick={() => { handlePayInvoice(showInvoiceDetail); setShowInvoiceDetail(null); }} className="flex-1 h-10 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors">💳 دفع الفاتورة</button>
              )}
              <button onClick={() => setShowInvoiceDetail(null)} className="px-6 h-10 rounded-xl border border-ink-200 text-ink-500 text-sm font-bold hover:bg-white transition-colors">إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {showAddCost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900">إضافة تكلفة</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">البند</label>
                <select
                  value={costCategory}
                  onChange={(e) => setCostCategory(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500"
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
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
                  dir="ltr"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">التاريخ</label>
                <input
                  type="date"
                  value={costDate}
                  onChange={(e) => setCostDate(e.target.value)}
                  className="w-full h-10 px-4 rounded-xl bg-white border border-ink-200 text-ink-900 text-sm outline-none focus:border-saffron-500"
                />
              </div>
              <div>
                <label className="block text-sm font-arabic text-ink-900 mb-1">ملاحظات</label>
                <textarea
                  value={costNotes}
                  onChange={(e) => setCostNotes(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2 rounded-xl bg-white border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-saffron-500 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowAddCost(false)}
                className="h-10 px-6 rounded-xl bg-white text-ink-900 font-arabic text-sm hover:bg-ink-200 transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={handleAddCost}
                className="h-10 px-6 rounded-xl bg-saffron-600 text-white font-arabic text-sm hover:bg-saffron-700 transition-colors"
              >
                إضافة
              </button>
            </div>
          </div>
        </div>
      )}

      {message && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-saffron-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 font-arabic">
          {message}
        </div>
      )}
    </div>
  );
}
