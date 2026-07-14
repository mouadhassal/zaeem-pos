import { useEffect, useState, useCallback } from "react";
import { getDb } from "../db";

interface KdsOrder {
  id: string;
  table_name: string;
  items: { name: string; quantity: number }[];
  status: string;
  created_at: string;
  elapsed: number;
}

export default function KDSApp() {
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [filter, setFilter] = useState<string>("all");

  const fetchOrders = useCallback(async () => {
    try {
      const db = await getDb();
      const rows = await db
        .selectFrom("orders")
        .innerJoin("tables", "tables.id", "orders.table_id")
        .select([
          "orders.id",
          "tables.name as table_name",
          "orders.status",
          "orders.created_at",
        ])
        .where("orders.status", "in", ["PENDING", "PREPARING"])
        .orderBy("orders.created_at", "asc")
        .execute();

      const now = Date.now();
      const result: KdsOrder[] = [];

      for (const row of rows) {
        const items = await db
          .selectFrom("order_items")
          .innerJoin("menu_items", "menu_items.id", "order_items.menu_item_id")
          .select(["menu_items.name", "order_items.quantity"])
          .where("order_items.order_id", "=", row.id)
          .execute();

        const created = new Date(row.created_at).getTime();
        result.push({
          id: row.id,
          table_name: row.table_name,
          items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
          status: row.status,
          created_at: row.created_at,
          elapsed: Math.floor((now - created) / 60000),
        });
      }

      setOrders(result);
    } catch {
      // KDS will retry on next poll
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const markReady = async (orderId: string) => {
    try {
      const db = await getDb();
      await db
        .updateTable("orders")
        .set({ status: "READY", last_modified: new Date().toISOString() })
        .where("id", "=", orderId)
        .execute();
      fetchOrders();
    } catch {
      // handle error
    }
  };

  const filteredOrders =
    filter === "all" ? orders : orders.filter((o) => o.status === filter);

  return (
    <div
      className="h-screen w-screen bg-slate-50 text-slate-900 overflow-hidden"
      dir="rtl"
    >
      <div className="h-14 bg-white flex items-center justify-between px-4 border-b border-slate-200 shadow-sm">
        <h1 className="text-lg font-bold">شاشة المطبخ</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 h-8 rounded-lg text-sm font-bold ${
              filter === "all" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            الكل
          </button>
          <button
            onClick={() => setFilter("PENDING")}
            className={`px-3 h-8 rounded-lg text-sm font-bold ${
              filter === "PENDING" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            جديد
          </button>
          <button
            onClick={() => setFilter("PREPARING")}
            className={`px-3 h-8 rounded-lg text-sm font-bold ${
              filter === "PREPARING" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"
            }`}
          >
            قيد التحضير
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 p-4 overflow-y-auto" style={{ height: "calc(100vh - 56px)" }}>
        {filteredOrders.map((order) => (
          <div
            key={order.id}
            className={`bg-white rounded-2xl p-4 space-y-3 shadow-sm border-t-4 ${
              order.elapsed > 15
                ? "border-red-500"
                : order.elapsed > 10
                ? "border-amber-500"
                : "border-emerald-500"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold text-slate-900">{order.table_name}</span>
              <span className="text-sm font-mono text-slate-400">#{order.id.slice(0, 8)}</span>
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  order.elapsed > 15
                    ? "bg-red-50 text-red-600"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {order.elapsed} دقيقة
              </span>
            </div>

            <div className="space-y-1">
              {order.items.map((item, i) => (
                <div key={i} className="flex justify-between text-sm text-slate-700">
                  <span>
                    {item.quantity}x {item.name}
                  </span>
                </div>
              ))}
            </div>

            <button
              onClick={() => markReady(order.id)}
              className="w-full h-12 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 transition-colors"
            >
              جاهز
            </button>
          </div>
        ))}

        {filteredOrders.length === 0 && (
          <div className="col-span-3 flex items-center justify-center text-slate-400 text-lg font-arabic">
            لا توجد طلبات حالياً
          </div>
        )}
      </div>
    </div>
  );
}
