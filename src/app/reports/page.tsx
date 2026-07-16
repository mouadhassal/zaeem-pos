import { useEffect, useState, useCallback } from "react";
import { getDb } from "../../db";
import { useCurrency } from "../../hooks/useCurrency";
import jsPDF from "jspdf";
import "jspdf-autotable";

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
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayOrders = await db
        .selectFrom("orders")
        .select([
          db.fn.sum<number>("total_cents").as("total"),
          db.fn.count<number>("id").as("count"),
        ])
        .where("status", "=", "PAID")
        .where("closed_at", ">=", todayStart.toISOString())
        .executeTakeFirst();

      const totalSales = (todayOrders?.total ?? 0) / 100;
      const orderCount = todayOrders?.count ?? 0;
      const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;

      const items = await db
        .selectFrom("order_items")
        .innerJoin("menu_items", "menu_items.id", "order_items.menu_item_id")
        .select([
          "menu_items.name",
          db.fn.sum<number>("order_items.quantity").as("quantity"),
        ])
        .groupBy("menu_items.name")
        .orderBy("quantity", "desc")
        .limit(5)
        .execute();

      const staff = await db
        .selectFrom("orders")
        .innerJoin("staff", "staff.id", "orders.user_id")
        .select([
          "staff.name",
          db.fn.count<number>("orders.id").as("orderCount"),
        ])
        .where("orders.status", "=", "PAID")
        .where("orders.closed_at", ">=", todayStart.toISOString())
        .groupBy("staff.name")
        .execute();

      const inventory = await db
        .selectFrom("ingredients")
        .select(["name", "current_stock", "min_stock"])
        .execute();

      setSummary({
        totalSales,
        orderCount,
        avgTicket,
        topItems: items.map((i) => ({
          name: i.name,
          quantity: i.quantity ?? 0,
        })),
        staffPerformance: staff.map((s) => ({
          name: s.name,
          orderCount: s.orderCount ?? 0,
        })),
        inventoryStatus: inventory.map((i) => ({
          name: i.name,
          currentStock: i.current_stock,
          minStock: i.min_stock,
        })),
      });
    } catch (e) {
      console.error("Reports error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const exportPdf = () => {
    if (!summary) return;
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text("Sales Report", 105, 20, { align: "center" });
    doc.setFontSize(10);
    doc.text(`Date: ${new Date().toLocaleDateString("en-US")}`, 10, 30);
    doc.setFontSize(12);
    doc.text(`Total Sales: ${fmt(summary.totalSales * 100)}`, 10, 42);
    doc.text(`Orders: ${summary.orderCount}`, 10, 52);
    doc.text(`Avg Ticket: ${fmt(summary.avgTicket * 100)}`, 10, 62);

    doc.text("Top Items", 10, 78);
    (doc as any).autoTable({
      startY: 84,
      head: [["Item", "Qty"]],
      body: summary.topItems.map((i) => [i.name, i.quantity.toString()]),
      theme: "grid",
      styles: { fontSize: 9 },
      headStyles: { fillColor: [41, 128, 185] },
    });

    const y2 = (doc as any).lastAutoTable.finalY + 12;
    doc.text("Staff Performance", 10, y2);
    (doc as any).autoTable({
      startY: y2 + 6,
      head: [["Staff", "Orders"]],
      body: summary.staffPerformance.map((s) => [s.name, s.orderCount.toString()]),
      theme: "grid",
      styles: { fontSize: 9 },
      headStyles: { fillColor: [41, 128, 185] },
    });

    const y3 = (doc as any).lastAutoTable.finalY + 12;
    doc.text("Inventory", 10, y3);
    (doc as any).autoTable({
      startY: y3 + 6,
      head: [["Item", "Stock", "Min"]],
      body: summary.inventoryStatus.map((inv) => [inv.name, inv.currentStock.toString(), inv.minStock.toString()]),
      theme: "grid",
      styles: { fontSize: 9 },
      headStyles: { fillColor: [41, 128, 185] },
    });

    doc.save(`report-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  const exportCsv = () => {
    if (!summary) return;
    const rows = [
      ["تقرير المبيعات", "", ""],
      ["إجمالي المبيعات", summary.totalSales.toString(), ""],
      ["عدد الطلبات", summary.orderCount.toString(), ""],
      ["متوسط الفاتورة", summary.avgTicket.toFixed(2), ""],
      [],
      ["أفضل الأصناف", "", ""],
      ...summary.topItems.map((i) => [i.name, i.quantity.toString(), ""]),
      [],
      ["أداء الموظفين", "", ""],
      ...summary.staffPerformance.map((s) => [s.name, s.orderCount.toString(), ""]),
      [],
      ["حالة المخزون", "", ""],
      ...summary.inventoryStatus.map((inv) => [
        inv.name,
        inv.currentStock.toString(),
        inv.minStock.toString(),
      ]),
    ];

    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `تقرير-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
      <div className="flex items-center justify-center h-full text-red-500 font-arabic">
        حدث خطأ في تحميل التقرير
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">التقارير</h1>
        <button
          onClick={exportCsv}
          className="h-10 px-4 rounded-xl bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors"
        >
          تصدير CSV
        </button>
        <button
          onClick={exportPdf}
          className="h-10 px-4 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 transition-colors"
        >
          تصدير PDF
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sm">
          <p className="text-ink-400 text-sm font-arabic">إجمالي المبيعات اليوم</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">
            {fmt(Math.round(summary.totalSales * 100))}
          </p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sm">
          <p className="text-ink-400 text-sm font-arabic">عدد الطلبات</p>
          <p className="text-2xl font-bold text-ink-900">{summary.orderCount}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 space-y-1 shadow-sm">
          <p className="text-ink-400 text-sm font-arabic">متوسط الفاتورة</p>
          <p className="text-2xl font-bold text-ink-900 font-mono">
            {fmt(Math.round(summary.avgTicket * 100))}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sm">
          <h2 className="font-bold text-ink-900 font-arabic">أفضل الأصناف</h2>
          {summary.topItems.map((item, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{item.name}</span>
              <span className="text-ink-400">{item.quantity}</span>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sm">
          <h2 className="font-bold text-ink-900 font-arabic">أداء الموظفين</h2>
          {summary.staffPerformance.map((staff, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-ink-900">{staff.name}</span>
              <span className="text-ink-400">{staff.orderCount} طلب</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl p-4 space-y-3 shadow-sm">
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
