import { useEffect, useState, useCallback } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { useCurrency } from "../../hooks/useCurrency";
import { exportHtmlToPdf, pdfTableHtml } from "../../lib/pdfExport";

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

export default function ReportsPage() {
  const { fmt } = useCurrency();
  const token = useAuthStore((s) => s.token);
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
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const report = await invoke<{
        total_sales: number; order_count: number;
        top_items: { name: string; quantity: number }[];
        staff_performance: { name: string; order_count: number }[];
        inventory_status: { name: string; current_stock: number; min_stock: number }[];
      }>("get_sales_report_v3", { sessionToken: token, todayStartIso: todayStart.toISOString() });

      const totalSales = report.total_sales / 100;
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
  }, [token]);

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
            <div style="font-size:16px;font-weight:700">${fmt(Math.round(summary.totalSales * 100))}</div>
          </div>
          <div style="flex:1;border:1px solid #E4E7EC;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:11px;color:#667085">عدد الطلبات</div>
            <div style="font-size:16px;font-weight:700">${summary.orderCount}</div>
          </div>
          <div style="flex:1;border:1px solid #E4E7EC;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:11px;color:#667085">متوسط الفاتورة</div>
            <div style="font-size:16px;font-weight:700">${fmt(Math.round(summary.avgTicket * 100))}</div>
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

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-md border border-ink-200 p-4 space-y-1">
          <p className="text-ink-400 text-sm font-arabic">إجمالي المبيعات اليوم</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">
            {fmt(Math.round(summary.totalSales * 100))}
          </p>
        </div>
        <div className="bg-white rounded-md border border-ink-200 p-4 space-y-1">
          <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
          <p className="text-2xl font-bold text-ink-900">{summary.orderCount}</p>
        </div>
        <div className="bg-white rounded-md border border-ink-200 p-4 space-y-1">
          <p className="text-ink-400 text-sm font-arabic">متوسط الفاتورة</p>
          <p className="text-2xl font-bold text-ink-900 font-mono">
            {fmt(Math.round(summary.avgTicket * 100))}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3">
          <h2 className="font-bold text-ink-900 font-arabic">أفضل الأصناف</h2>
          {summary.topItems.map((item, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{item.name}</span>
              <span className="text-ink-400">{item.quantity}</span>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3">
          <h2 className="font-bold text-ink-900 font-arabic">أداء الموظفين</h2>
          {summary.staffPerformance.map((staff, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{staff.name}</span>
              <span className="text-ink-400">{staff.orderCount} طلب</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3">
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

      <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3">
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

      <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3">
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

        {forecast && forecast.items.length > 0 && (
          <div className="space-y-4">
            {Object.entries(
              forecast.items.reduce<Record<string, ItemForecast[]>>((acc, item) => {
                (acc[item.date] ??= []).push(item);
                return acc;
              }, {})
            )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, dayItems]) => (
                <div key={date}>
                  <p className="text-sm font-bold text-ink-700 font-arabic mb-1.5">{formatForecastDate(date)}</p>
                  <div className="space-y-1.5">
                    {dayItems.map((item) => (
                      <div key={item.menu_item_id} className="flex items-center justify-between text-sm border-b border-ink-100 last:border-0 pb-1.5 last:pb-0">
                        <span className="text-ink-900">{item.menu_item_name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-ink-400 font-arabic">{CONFIDENCE_LABEL[item.confidence]}</span>
                          <span className="font-mono font-bold text-ink-900">{item.predicted_quantity}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

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

      <div className="bg-white rounded-md border border-ink-200 p-4 space-y-3">
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
                <span className="text-ink-900 font-arabic">{o.table_name}</span>
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
                  <span className="text-ink-900 font-arabic">{o.table_name}</span>
                  <span className="text-ink-400 text-xs font-arabic mr-2">({o.status})</span>
                </div>
                <span className="text-ink-400 font-mono">{fmt(o.total_cents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
