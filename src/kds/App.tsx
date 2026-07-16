import { useEffect, useState, useCallback } from "react";
import { getDb } from "../db";

interface KdsOrder {
  id: string;
  table_name: string;
  items: { name: string; quantity: number }[];
  status: string;
  created_at: string;
  createdMs: number;
}

const TARGET_PREP_MS = 12 * 60 * 1000;

function AgingBar({ createdMs, now }: { createdMs: number; now: number }) {
  const ratio = Math.min((now - createdMs) / TARGET_PREP_MS, 1.4);
  const pct = Math.min(ratio, 1) * 100;
  const color =
    ratio >= 1 ? "var(--danger)" : ratio >= 0.66 ? "var(--warn)" : "var(--line)";
  return (
    <div className="h-1.5 w-full rounded-full bg-surface-alt overflow-hidden">
      <div
        className="h-full rounded-full transition-[width] duration-1000 ease-linear"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

export default function KDSApp() {
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [now, setNow] = useState(Date.now());

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

      const result: KdsOrder[] = [];
      for (const row of rows) {
        const items = await db
          .selectFrom("order_items")
          .innerJoin("menu_items", "menu_items.id", "order_items.menu_item_id")
          .select(["menu_items.name", "order_items.quantity"])
          .where("order_items.order_id", "=", row.id)
          .execute();

        result.push({
          id: row.id,
          table_name: row.table_name,
          items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
          status: row.status,
          created_at: row.created_at,
          createdMs: new Date(row.created_at).getTime(),
        });
      }
      setOrders(result);
    } catch {
      // KDS keeps last snapshot on read failure
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const dataTimer = setInterval(fetchOrders, 10000);
    return () => clearInterval(dataTimer);
  }, [fetchOrders]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

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
      // will be reflected on next fetch
    }
  };

  const filteredOrders =
    filter === "all" ? orders : orders.filter((o) => o.status === filter);

  const chip = (key: string, label: string) => (
    <button
      onClick={() => setFilter(key)}
      className={`px-4 h-10 rounded-[12px] text-base font-medium transition-all active:scale-95 ${
        filter === key
          ? "bg-text text-white"
          : "bg-surface-alt text-text-2"
      }`}
      style={{ minHeight: 44 }}
    >
      {label}
    </button>
  );

  return (
    <div className="h-screen w-screen bg-bg text-text overflow-hidden" dir="rtl">
      <div className="h-16 bg-surface flex items-center justify-between px-6 border-b border-line shrink-0">
        <h1 className="text-2xl font-bold">شاشة المطبخ</h1>
        <div className="flex gap-2">
          {chip("all", "الكل")}
          {chip("PENDING", "جديد")}
          {chip("PREPARING", "قيد التحضير")}
        </div>
      </div>

      <div
        className="grid grid-cols-3 gap-4 p-4 overflow-y-auto"
        style={{ height: "calc(100vh - 64px)" }}
      >
        {filteredOrders.map((order) => {
          const mins = Math.floor((now - order.createdMs) / 60000);
          const late = now - order.createdMs >= TARGET_PREP_MS;
          return (
            <div
              key={order.id}
              className="bg-surface rounded-[13px] p-4 space-y-3 shadow-sh-2 flex flex-col"
            >
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold">{order.table_name}</span>
                <span className="tabular text-base text-text-muted">
                  #{order.id.slice(0, 8)}
                </span>
              </div>

              <AgingBar createdMs={order.createdMs} now={now} />

              <div className="flex items-center justify-between">
                <span
                  className="tabular text-lg font-medium"
                  style={{ color: late ? "var(--danger)" : "var(--text-2)" }}
                >
                  {mins} دقيقة
                </span>
              </div>

              <div className="space-y-1.5 flex-1">
                {order.items.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 text-lg">
                    <span className="tabular font-medium text-text">
                      {item.quantity}×
                    </span>
                    <span className="text-text">{item.name}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => markReady(order.id)}
                className="w-full rounded-[12px] text-white text-lg font-bold active:scale-[0.98] transition-transform"
                style={{ backgroundColor: "var(--ok)", height: 52 }}
              >
                جاهز
              </button>
            </div>
          );
        })}

        {filteredOrders.length === 0 && (
          <div className="col-span-3 flex items-center justify-center text-text-muted text-xl">
            ما في طلبات هلق.
          </div>
        )}
      </div>
    </div>
  );
}
