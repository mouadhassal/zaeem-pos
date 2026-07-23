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

export default function ReportsPage() {
  const { fmt } = useCurrency();
  const token = useAuthStore((s) => s.token);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

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
      await exportHtmlToPdf(`تقرير-المبيعات-${new Date().toISOString().slice(0, 10)}.pdf`, bodyHtml);
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
          className="h-10 px-4 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-colors disabled:opacity-50"
        >
          {exportingPdf ? "جاري التصدير..." : "تصدير PDF"}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic">إجمالي المبيعات اليوم</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">
            {fmt(Math.round(summary.totalSales * 100))}
          </p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
          <p className="text-2xl font-bold text-ink-900">{summary.orderCount}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sh-1">
          <p className="text-ink-400 text-sm font-arabic">متوسط الفاتورة</p>
          <p className="text-2xl font-bold text-ink-900 font-mono">
            {fmt(Math.round(summary.avgTicket * 100))}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sh-1">
          <h2 className="font-bold text-ink-900 font-arabic">أفضل الأصناف</h2>
          {summary.topItems.map((item, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{item.name}</span>
              <span className="text-ink-400">{item.quantity}</span>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sh-1">
          <h2 className="font-bold text-ink-900 font-arabic">أداء الموظفين</h2>
          {summary.staffPerformance.map((staff, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{staff.name}</span>
              <span className="text-ink-400">{staff.orderCount} طلب</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sh-1">
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
    </div>
  );
}
