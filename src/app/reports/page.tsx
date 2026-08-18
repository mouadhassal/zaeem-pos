import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { useCurrency } from "../../hooks/useCurrency";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";
import DatePicker from "../../components/ui/DatePicker";

interface SalesSummary {
  totalSales: number;
  orderCount: number;
  avgTicket: number;
  topItems: { name: string; quantity: number }[];
  staffPerformance: { name: string; orderCount: number }[];
  inventoryStatus: { name: string; currentStock: number; minStock: number }[];
}

// Mirrors anomaly.rs's AnomalyKind/Severity/AnomalyFinding (serde
// SCREAMING_SNAKE_CASE) -- this is a fully-offline, non-AI statistical
// check (void rate, cash variance, void-then-resell pattern), run
// on-demand only. See anomaly.rs's module doc for why it never calls
// an AI vendor: these findings can accuse a real employee, so every
// one carries real numbers a manager can verify, not a black-box score.
type AnomalyKind = "HIGH_VOID_RATE" | "CASH_VARIANCE" | "VOID_RESELL_PATTERN";
type AnomalySeverity = "LOW" | "MEDIUM" | "HIGH";

interface AnomalyFinding {
  staff_id: string;
  staff_name: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  description: string;
  evidence: Record<string, unknown>;
}

const ANOMALY_KIND_LABEL: Record<AnomalyKind, string> = {
  HIGH_VOID_RATE: "معدل إلغاء مرتفع",
  CASH_VARIANCE: "عجز نقدي متكرر",
  VOID_RESELL_PATTERN: "نمط إلغاء ثم بيع",
};

const SEVERITY_STYLE: Record<AnomalySeverity, { badge: string; label: string }> = {
  HIGH: { badge: "bg-red-50 text-red-600 border-red-200", label: "خطورة عالية" },
  MEDIUM: { badge: "bg-amber-50 text-amber-700 border-amber-200", label: "خطورة متوسطة" },
  LOW: { badge: "bg-ink-100 text-ink-500 border-ink-200", label: "خطورة منخفضة" },
};

// Mirrors forecast.rs's Confidence/ItemForecast/IngredientForecast/
// DemandForecast (serde SCREAMING_SNAKE_CASE) -- same fully-offline
// philosophy as the anomaly section above: a simple day-of-week average
// a manager can sanity-check, not an opaque model.
type Confidence = "LOW" | "MEDIUM" | "HIGH";

interface ItemForecast {
  menu_item_id: string;
  menu_item_name: string;
  date: string;
  predicted_quantity: number;
  confidence: Confidence;
  weeks_with_a_sale: number;
}

interface IngredientForecast {
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  predicted_consumption: number;
  current_stock: number;
  will_run_short: boolean;
}

interface DemandForecast {
  items: ItemForecast[];
  ingredients: IngredientForecast[];
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: "ثقة عالية",
  MEDIUM: "ثقة متوسطة",
  LOW: "ثقة منخفضة",
};

const WEEKDAY_LABEL_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function formatForecastDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${WEEKDAY_LABEL_AR[d.getDay()]} ${dateStr}`;
}

// 2026-08-13: this page used to hardcode "today so far" with no way to see
// any other period, while finance/page.tsx (same data class -- paid order
// totals) already had today/week/month/custom. Same DateRange shape and
// rangeStart/rangeEnd helpers as that page, kept local rather than shared
// since finance's version also feeds cost/invoice/tax tabs this page
// doesn't have.
type DateRange = "today" | "week" | "month" | "custom";

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

function rangeEnd(range: DateRange, customEnd?: string): Date | null {
  // null = "up to now" -- matches get_sales_report_v3's range_end_iso:
  // None meaning, avoids sending a redundant "end = right now" bound on
  // the three preset ranges.
  if (range !== "custom") return null;
  return new Date((customEnd || new Date().toISOString().slice(0, 10)) + "T23:59:59");
}

// Mirrors reconcile.rs's UnreconciledOrder/ReconciliationReport -- a
// read-only report (no order is ever changed automatically), surfaced
// on-demand so a manager can decide what actually happened to an order
// that's been open too long or has no payment on file.
interface UnreconciledOrder {
  order_id: string;
  table_name: string;
  status: string;
  total_cents: number;
  created_at: string;
}

interface ReconciliationReport {
  stale_open_orders: UnreconciledOrder[];
  paid_orders_missing_payment: UnreconciledOrder[];
}

// Mirrors repo.rs's RefundableOrderRow -- see that struct's own doc
// comment for why this is a purpose-built read model (table name +
// refund status joined in) rather than reusing the bare OrderRow.
interface RefundableOrder {
  id: string;
  table_name: string | null;
  order_type: string;
  total_cents: number;
  refunded_cents: number;
  created_at: string;
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  DINE_IN: "داخلي", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين",
};

export default function ReportsPage() {
  const { fmt } = useCurrency();
  const token = useAuthStore((s) => s.token);
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [anomalies, setAnomalies] = useState<AnomalyFinding[] | null>(null);
  const [anomaliesLoading, setAnomaliesLoading] = useState(false);
  const [anomaliesError, setAnomaliesError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<DemandForecast | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  // A tenant's full menu (often 30-50+ items) all clearing the "enough
  // history" bar meant the old UI dumped every item for every one of the 7
  // forecast days -- a wall of numbers, not something an owner could act
  // on in 5 seconds. Each day's items already arrive sorted by predicted
  // quantity descending (forecast.rs), so showing only the top N by
  // default and letting a specific day be expanded on demand keeps the
  // same data, just curated the way a manager actually scans it: "what's
  // busy, what do I prep more of" first, full detail on request.
  const [expandedForecastDates, setExpandedForecastDates] = useState<Set<string>>(new Set());
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  // 2026-08-13: refund_order_v3's UI -- see repo.rs's refund_order for
  // what this actually reverses (stock/loyalty/debt, atomically). Loaded
  // eagerly (not on-demand like anomalies/forecast/reconciliation above)
  // since checking "can I refund this" is the whole point of a manager
  // opening this section, not a heavier optional analysis.
  const [refundableOrders, setRefundableOrders] = useState<RefundableOrder[] | null>(null);
  const [refundableLoading, setRefundableLoading] = useState(true);
  const [refundableError, setRefundableError] = useState<string | null>(null);
  const [refundingId, setRefundingId] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const startDate = rangeStart(dateRange, customStart);
      const endDate = rangeEnd(dateRange, customEnd);

      const report = await invoke<{
        total_sales: number; order_count: number;
        top_items: { name: string; quantity: number }[];
        staff_performance: { name: string; order_count: number }[];
        inventory_status: { name: string; current_stock: number; min_stock: number }[];
      }>("get_sales_report_v3", {
        sessionToken: token,
        todayStartIso: startDate.toISOString(),
        rangeEndIso: endDate ? endDate.toISOString() : null,
      });

      const totalSales = report.total_sales;
      const orderCount = report.order_count;
      const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;

      setSummary({
        totalSales,
        orderCount,
        avgTicket,
        topItems: report.top_items.map((i) => ({ name: i.name, quantity: i.quantity ?? 0 })),
        staffPerformance: report.staff_performance.map((s) => ({ name: s.name, orderCount: s.order_count ?? 0 })),
        inventoryStatus: report.inventory_status.map((i) => ({ name: i.name, currentStock: i.current_stock, minStock: i.min_stock })),
      });
    } catch (e) {
      console.error("Reports error:", e);
      setLoadError("تعذر تحميل التقرير. تحقق من اتصال الخادم.");
    } finally {
      setLoading(false);
    }
  }, [token, dateRange, customStart, customEnd]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const runAnomalyCheck = async () => {
    setAnomaliesLoading(true);
    setAnomaliesError(null);
    try {
      const findings = await invoke<AnomalyFinding[]>("detect_anomalies_v3", { sessionToken: token });
      setAnomalies(findings);
    } catch (e) {
      console.error("Anomaly check error:", e);
      setAnomaliesError("تعذر إجراء الفحص. حاول مرة أخرى.");
    } finally {
      setAnomaliesLoading(false);
    }
  };

  const runForecast = async () => {
    setForecastLoading(true);
    setForecastError(null);
    try {
      const result = await invoke<DemandForecast>("forecast_demand_v3", { sessionToken: token });
      setForecast(result);
    } catch (e) {
      console.error("Forecast error:", e);
      setForecastError("تعذر إجراء التوقع. حاول مرة أخرى.");
    } finally {
      setForecastLoading(false);
    }
  };

  const runReconciliation = async () => {
    setReconciliationLoading(true);
    setReconciliationError(null);
    try {
      const result = await invoke<ReconciliationReport>("reconcile_orders_v3", { sessionToken: token });
      setReconciliation(result);
    } catch (e) {
      console.error("Reconciliation error:", e);
      setReconciliationError("تعذر إجراء الفحص. حاول مرة أخرى.");
    } finally {
      setReconciliationLoading(false);
    }
  };

  const fetchRefundableOrders = useCallback(async () => {
    setRefundableLoading(true);
    setRefundableError(null);
    try {
      const rows = await invoke<RefundableOrder[]>("list_recent_paid_orders_v3", { sessionToken: token });
      setRefundableOrders(rows);
    } catch (e) {
      console.error("Refundable orders error:", e);
      setRefundableError("تعذر تحميل الطلبات المدفوعة.");
    } finally {
      setRefundableLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchRefundableOrders();
  }, [fetchRefundableOrders]);

  async function handleRefund(order: RefundableOrder) {
    const reason = window.prompt("سبب الاسترداد (اختياري):");
    // A cancelled prompt (null) must not proceed -- an empty string (user
    // left it blank and hit OK) is a valid "no reason given" and should.
    if (reason === null) return;
    if (!window.confirm(`استرداد الطلب بمبلغ ${fmt(order.total_cents)}؟ سيتم إرجاع المخزون ونقاط الولاء والدين المرتبطين بهذا الطلب. لا يمكن التراجع عن هذا الإجراء.`)) return;
    setRefundingId(order.id);
    try {
      await invoke("refund_order_v3", { sessionToken: token, orderId: order.id, reason: reason || null });
      await fetchRefundableOrders();
    } catch (e) {
      console.error("Refund error:", e);
      window.alert(`تعذر استرداد الطلب: ${e}`);
    } finally {
      setRefundingId(null);
    }
  }

  // Arabic PDF export -- see lib/pdfExport.ts's doc comment for why this
  // renders via html2canvas + doc.addImage() instead of jsPDF's own text
  // renderer (no Arabic shaping/bidi support at all). Verified by actually
  // generating a PDF and rasterizing it: correctly shaped, right-to-left,
  // right-aligned Arabic throughout.
  const exportPdf = async () => {
    if (!summary || exportingPdf) return;
    setExportingPdf(true);
    try {
      const bodyHtml = `
        <h1 style="font-size:22px;font-weight:700;text-align:center;margin:0 0 4px">تقرير المبيعات</h1>
        <p style="font-size:11px;color:#667085;text-align:center;margin:0 0 16px">${new Date().toLocaleDateString("ar-SA")}</p>
        <div style="display:flex;gap:12px;margin-bottom:20px">
          <div style="flex:1;border:1px solid #E4E7EC;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:11px;color:#667085">إجمالي المبيعات</div>
            <div style="font-size:16px;font-weight:700">${fmt(summary.totalSales)}</div>
          </div>
          <div style="flex:1;border:1px solid #E4E7EC;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:11px;color:#667085">عدد الطلبات</div>
            <div style="font-size:16px;font-weight:700">${summary.orderCount}</div>
          </div>
          <div style="flex:1;border:1px solid #E4E7EC;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:11px;color:#667085">متوسط الفاتورة</div>
            <div style="font-size:16px;font-weight:700">${fmt(Math.round(summary.avgTicket))}</div>
          </div>
        </div>
        ${pdfTableHtml("أفضل الأصناف", ["الصنف", "الكمية"], summary.topItems.map((i) => [i.name, String(i.quantity)]))}
        ${pdfTableHtml("أداء الموظفين", ["الموظف", "الطلبات"], summary.staffPerformance.map((s) => [s.name, String(s.orderCount)]))}
        ${pdfTableHtml("حالة المخزون", ["الصنف", "المخزون", "الحد الأدنى"], summary.inventoryStatus.map((inv) => [inv.name, String(inv.currentStock), String(inv.minStock)]))}
      `;
      await exportHtmlToPdf(`تقرير-المبيعات-${new Date().toISOString().slice(0, 10)}.pdf`, bodyHtml, token ?? "");
    } finally {
      setExportingPdf(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ink-500 font-arabic">
        جاري التحميل...
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-red-500 font-arabic">{loadError || "حدث خطأ في تحميل التقرير"}</p>
        <button onClick={fetchReports} className="text-sm text-saffron-600 hover:text-saffron-700 font-bold font-arabic">إعادة المحاولة</button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">التقارير</h1>
        <button
          onClick={exportPdf}
          disabled={exportingPdf}
          className="h-10 px-4 rounded-sm bg-red-50 text-red-600 border border-red-200 text-sm font-bold hover:bg-red-100 transition-colors disabled:opacity-50"
        >
          {exportingPdf ? "جاري التصدير..." : "تصدير PDF"}
        </button>
      </div>

      <div className="space-y-3">
        <div className="flex gap-2">
          {(["today", "week", "month", "custom"] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              className={`px-4 py-2 rounded-lg font-arabic text-sm transition-colors ${
                dateRange === r ? "bg-saffron-600 text-white" : "bg-white text-ink-500 hover:bg-ink-200"
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
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="zc-card p-4 space-y-1">
          <p className="text-ink-400 text-sm font-arabic">إجمالي المبيعات</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">
            {fmt(summary.totalSales)}
          </p>
        </div>
        <div className="zc-card p-4 space-y-1">
          <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
          <p className="text-2xl font-bold text-ink-900">{summary.orderCount}</p>
        </div>
        <div className="zc-card p-4 space-y-1">
          <p className="text-ink-400 text-sm font-arabic">متوسط الفاتورة</p>
          <p className="text-2xl font-bold text-ink-900 font-mono">
            {fmt(Math.round(summary.avgTicket))}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="zc-card p-4 space-y-3">
          <h2 className="font-bold text-ink-900 font-arabic">أفضل الأصناف</h2>
          {summary.topItems.map((item, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{item.name}</span>
              <span className="text-ink-400">{item.quantity}</span>
            </div>
          ))}
        </div>

        <div className="zc-card p-4 space-y-3">
          <h2 className="font-bold text-ink-900 font-arabic">أداء الموظفين</h2>
          {summary.staffPerformance.map((staff, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{staff.name}</span>
              <span className="text-ink-400">{staff.orderCount} طلب</span>
            </div>
          ))}
        </div>
      </div>

      <div className="zc-card p-4 space-y-3">
        <h2 className="font-bold text-ink-900 font-arabic">حالة المخزون</h2>
        {summary.inventoryStatus.map((inv, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-ink-900">{inv.name}</span>
            <span
              className={`font-mono ${
                inv.currentStock <= inv.minStock
                  ? "text-red-500 font-bold"
                  : "text-ink-400"
              }`}
            >
              {inv.currentStock} / {inv.minStock}
            </span>
          </div>
        ))}
      </div>

      {/* 2026-08-15: anomaly detection, demand forecasting, and order
          reconciliation used to just appear one after another with no
          visual grouping, indistinguishable from the descriptive report
          sections above them (top items, staff, inventory). All three
          are the same kind of thing -- a statistical read on data that
          already exists, not a new report -- so they get one shared
          eyebrow label instead of reading as three unrelated features
          bolted onto the page over time. */}
      <div className="pt-2">
        <h2 className="text-xs font-bold tracking-[0.15em] text-ink-400 font-arabic uppercase">الرؤى</h2>
        <p className="text-xs text-ink-300 font-arabic mt-0.5">فحوصات إحصائية محلية بالكامل -- بدون ذكاء اصطناعي</p>
      </div>

      <div className="zc-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-bold text-ink-900 font-arabic">فحص الحالات غير الطبيعية</h2>
            <p className="text-xs text-ink-400 font-arabic mt-0.5">
              فحص إحصائي محلي بالكامل (بدون ذكاء اصطناعي) لآخر 30 يوم -- معدل الإلغاء، العجز النقدي، ونمط الإلغاء ثم البيع
            </p>
          </div>
          <button
            onClick={runAnomalyCheck}
            disabled={anomaliesLoading}
            className="h-10 px-4 rounded-sm bg-ink-900 text-white text-sm font-bold hover:bg-ink-800 transition-colors disabled:opacity-50 shrink-0 font-arabic"
          >
            {anomaliesLoading ? "جاري الفحص..." : "فحص الآن"}
          </button>
        </div>

        {anomaliesError && (
          <p className="text-sm text-red-500 font-arabic">{anomaliesError}</p>
        )}

        {anomalies && anomalies.length === 0 && !anomaliesError && (
          <p className="text-sm text-ink-400 font-arabic">لا توجد حالات غير عادية خلال آخر 30 يوم</p>
        )}

        {anomalies && anomalies.length > 0 && (
          <div className="space-y-2">
            {anomalies.map((finding, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border border-ink-200 rounded-sm p-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink-900">{finding.staff_name}</span>
                    <span className="text-xs text-ink-400 font-arabic">{ANOMALY_KIND_LABEL[finding.kind]}</span>
                  </div>
                  <p className="text-sm text-ink-500 font-arabic">{finding.description}</p>
                </div>
                <span className={`text-xs font-bold px-2 py-1 rounded-sm border shrink-0 font-arabic ${SEVERITY_STYLE[finding.severity].badge}`}>
                  {SEVERITY_STYLE[finding.severity].label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="zc-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-bold text-ink-900 font-arabic">توقع الطلب للأسبوع القادم</h2>
            <p className="text-xs text-ink-400 font-arabic mt-0.5">
              متوسط المبيعات لنفس يوم الأسبوع خلال آخر 8 أسابيع (بدون ذكاء اصطناعي)
            </p>
          </div>
          <button
            onClick={runForecast}
            disabled={forecastLoading}
            className="h-10 px-4 rounded-sm bg-ink-900 text-white text-sm font-bold hover:bg-ink-800 transition-colors disabled:opacity-50 shrink-0 font-arabic"
          >
            {forecastLoading ? "جاري التوقع..." : "توقع الآن"}
          </button>
        </div>

        {forecastError && <p className="text-sm text-red-500 font-arabic">{forecastError}</p>}

        {forecast && forecast.items.length === 0 && !forecastError && (
          <p className="text-sm text-ink-400 font-arabic">لا توجد بيانات مبيعات كافية لإجراء توقع بعد</p>
        )}

        {forecast && forecast.items.length > 0 && (() => {
          const TOP_ITEMS_PER_DAY = 5;
          const byDate = Object.entries(
            forecast.items.reduce<Record<string, ItemForecast[]>>((acc, item) => {
              (acc[item.date] ??= []).push(item);
              return acc;
            }, {})
          ).sort(([a], [b]) => a.localeCompare(b));

          const toggleDate = (date: string) => {
            setExpandedForecastDates((prev) => {
              const next = new Set(prev);
              if (next.has(date)) next.delete(date); else next.add(date);
              return next;
            });
          };

          return (
            <div className="space-y-4">
              {/* Week-at-a-glance: total predicted covers per day, so "how
                  busy is next week" is answerable at a glance before
                  drilling into any single item. */}
              <div className="grid grid-cols-7 gap-1.5">
                {byDate.map(([date, dayItems]) => {
                  const dayTotal = dayItems.reduce((s, it) => s + it.predicted_quantity, 0);
                  const maxTotal = Math.max(...byDate.map(([, d]) => d.reduce((s, it) => s + it.predicted_quantity, 0)), 1);
                  return (
                    <div key={date} className="text-center">
                      <p className="text-[10px] text-ink-400 font-arabic mb-1">{formatForecastDate(date).split(" ")[0]}</p>
                      <div className="h-14 flex items-end justify-center">
                        <div
                          className="w-6 rounded-t-sm bg-saffron-500"
                          style={{ height: `${Math.max(8, (dayTotal / maxTotal) * 100)}%` }}
                          title={`${dayTotal} صنف متوقع`}
                        />
                      </div>
                      <p className="text-xs font-mono font-bold text-ink-900 mt-1">{Math.round(dayTotal)}</p>
                    </div>
                  );
                })}
              </div>

              {byDate.map(([date, dayItems]) => {
                const expanded = expandedForecastDates.has(date);
                const shown = expanded ? dayItems : dayItems.slice(0, TOP_ITEMS_PER_DAY);
                const remaining = dayItems.length - shown.length;
                return (
                  <div key={date}>
                    <p className="text-sm font-bold text-ink-700 font-arabic mb-1.5">{formatForecastDate(date)}</p>
                    <div className="space-y-1.5">
                      {shown.map((item) => (
                        <div key={item.menu_item_id} className="flex items-center justify-between text-sm border-b border-ink-100 last:border-0 pb-1.5 last:pb-0">
                          <span className="text-ink-900">{item.menu_item_name}</span>
                          <div className="flex items-center gap-2">
                            {item.confidence === "LOW" && (
                              <span className="text-[10px] text-ink-400 font-arabic">{CONFIDENCE_LABEL[item.confidence]}</span>
                            )}
                            <span className="font-mono font-bold text-ink-900">{item.predicted_quantity}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {remaining > 0 && (
                      <button
                        onClick={() => toggleDate(date)}
                        className="text-xs text-saffron-600 font-arabic mt-1.5 hover:underline"
                      >
                        {expanded ? "إخفاء" : `عرض ${remaining} صنف إضافي`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {forecast && forecast.ingredients.length > 0 && (
          <div className="pt-3 border-t border-ink-200 space-y-2">
            <h3 className="text-sm font-bold text-ink-700 font-arabic">المكونات المتوقع نفادها</h3>
            {forecast.ingredients.map((ing) => (
              <div key={ing.ingredient_id} className="flex items-center justify-between text-sm">
                <span className="text-ink-900">{ing.ingredient_name}</span>
                <span className={`font-mono ${ing.will_run_short ? "text-red-500 font-bold" : "text-ink-400"}`}>
                  {ing.current_stock} / {ing.predicted_consumption} {ing.unit}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="zc-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-bold text-ink-900 font-arabic">تسوية الطلبات</h2>
            <p className="text-xs text-ink-400 font-arabic mt-0.5">
              طلبات مفتوحة منذ أكثر من 6 ساعات، أو مسجلة كمدفوعة بدون دفعة فعلية
            </p>
          </div>
          <button
            onClick={runReconciliation}
            disabled={reconciliationLoading}
            className="h-10 px-4 rounded-sm bg-ink-900 text-white text-sm font-bold hover:bg-ink-800 transition-colors disabled:opacity-50 shrink-0 font-arabic"
          >
            {reconciliationLoading ? "جاري الفحص..." : "فحص الآن"}
          </button>
        </div>

        {reconciliationError && <p className="text-sm text-red-500 font-arabic">{reconciliationError}</p>}

        {reconciliation &&
          reconciliation.stale_open_orders.length === 0 &&
          reconciliation.paid_orders_missing_payment.length === 0 &&
          !reconciliationError && (
            <p className="text-sm text-ink-400 font-arabic">لا توجد طلبات تحتاج مراجعة</p>
          )}

        {reconciliation && reconciliation.paid_orders_missing_payment.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-red-600 font-arabic">طلبات مدفوعة بدون دفعة مسجلة</h3>
            {reconciliation.paid_orders_missing_payment.map((o) => (
              <div key={o.order_id} className="flex items-center justify-between text-sm border border-red-200 bg-red-50 rounded-sm p-2">
                <span className="text-ink-900 font-arabic">{o.table_name || `#${o.order_id.slice(0, 6)}`}</span>
                <span className="text-ink-400 font-mono">{fmt(o.total_cents)}</span>
              </div>
            ))}
          </div>
        )}

        {reconciliation && reconciliation.stale_open_orders.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-amber-700 font-arabic">طلبات مفتوحة منذ فترة طويلة</h3>
            {reconciliation.stale_open_orders.map((o) => (
              <div key={o.order_id} className="flex items-center justify-between text-sm border border-amber-200 bg-amber-50 rounded-sm p-2">
                <div>
                  <span className="text-ink-900 font-arabic">{o.table_name || `#${o.order_id.slice(0, 6)}`}</span>
                  <span className="text-ink-400 text-xs font-arabic mr-2">({o.status})</span>
                </div>
                <span className="text-ink-400 font-mono">{fmt(o.total_cents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pt-2">
        <h2 className="text-xs font-bold tracking-[0.15em] text-ink-400 font-arabic uppercase">الإجراءات</h2>
      </div>

      <div className="zc-card p-4 space-y-3">
        <div>
          <h2 className="font-bold text-ink-900 font-arabic">الطلبات المدفوعة (استرداد)</h2>
          <p className="text-xs text-ink-400 font-arabic mt-0.5">
            آخر 50 طلب مدفوع -- الاسترداد يعيد المخزون ونقاط الولاء والدين المرتبطين بالطلب تلقائياً
          </p>
        </div>

        {refundableLoading && <p className="text-sm text-ink-400 font-arabic">جاري التحميل...</p>}
        {refundableError && <p className="text-sm text-red-500 font-arabic">{refundableError}</p>}
        {refundableOrders && refundableOrders.length === 0 && !refundableLoading && (
          <p className="text-sm text-ink-400 font-arabic">لا توجد طلبات مدفوعة بعد</p>
        )}

        {refundableOrders && refundableOrders.length > 0 && (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {refundableOrders.map((o) => {
              const isRefunded = o.refunded_cents > 0;
              return (
                <div key={o.id} className={`flex items-center justify-between text-sm border rounded-sm p-2 ${isRefunded ? "border-ink-200 bg-ink-50" : "border-ink-200 bg-white"}`}>
                  <div>
                    <span className={`font-arabic ${isRefunded ? "text-ink-400 line-through" : "text-ink-900"}`}>
                      {o.table_name || ORDER_TYPE_LABEL[o.order_type] || o.order_type}
                    </span>
                    <span className="text-ink-400 text-xs font-arabic mr-2">
                      {new Date(o.created_at).toLocaleString("ar-SA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {isRefunded && <span className="text-[10px] text-red-500 font-arabic mr-2">تم الاسترداد</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono ${isRefunded ? "text-ink-400 line-through" : "text-ink-700"}`}>{fmt(o.total_cents)}</span>
                    {!isRefunded && (
                      <button
                        onClick={() => handleRefund(o)}
                        disabled={refundingId === o.id}
                        className="h-8 px-3 rounded-sm border border-red-200 text-red-600 text-xs font-bold font-arabic hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        {refundingId === o.id ? "جارٍ..." : "استرداد"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
