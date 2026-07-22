import { useEffect, useState, useRef, useCallback } from "react";
import { IconChefHat, IconNote } from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../../stores/authStore";

interface KDSItem {
  name: string;
  quantity: number;
  notes: string | null;
}

interface KDSOrder {
  id: string;
  table_name: string | null;
  order_type: string;
  status: string;
  items: KDSItem[];
  created_at: string;
  notes: string | null;
}

const STATUS_FLOW: Record<string, string> = {
  PENDING: "PREPARING",
  PREPARING: "READY",
  READY: "SERVED",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "قيد الانتظار",
  PREPARING: "قيد التحضير",
  READY: "جاهز",
  SERVED: "مخدم",
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "border-r-4 border-warn",
  PREPARING: "border-r-4 border-ink-500",
  READY: "border-r-4 border-ok",
  SERVED: "border-r-4 border-ink-300 opacity-60",
};

const STATUS_BG: Record<string, string> = {
  PENDING: "bg-surface-alt",
  PREPARING: "bg-surface-alt",
  READY: "bg-accent-soft",
};

const ORDER_TYPE_LABELS: Record<string, string> = {
  DINE_IN: "داخلي",
  TAKEAWAY: "طلبات خارجية",
  DELIVERY: "توصيل",
  ONLINE: "أونلاين",
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
}

function elapsed(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function KDSPage() {
  const token = useAuthStore((s) => s.token);
  const [orders, setOrders] = useState<KDSOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("all");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playAlert = () => {
    try {
      if (!audioRef.current) {
        audioRef.current = new Audio("data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACAf39/f4B/f3+AgH9/f3+AgH9/f4B/f3+AgH9/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+AgH9/f4B/f3+");
      }
      audioRef.current.play().catch(() => {});
    } catch {}
  };

  const fetchOrders = useCallback(async () => {
    try {
      const kdsOrders = await invoke<KDSOrder[]>("list_kitchen_orders_v3", { sessionToken: token });

      setOrders((prev) => {
        const currCount = kdsOrders.filter((o) => o.status === "PENDING").length;
        const prevCountVal = prev.filter((o) => o.status === "PENDING").length;
        if (currCount > prevCountVal) playAlert();
        return kdsOrders;
      });
    } catch {
      setError("حدث خطأ في تحميل الطلبات");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handleStatusChange = async (orderId: string, currentStatus: string) => {
    const nextStatus = STATUS_FLOW[currentStatus] as "PREPARING" | "READY" | "SERVED" | undefined;
    if (!nextStatus) return;
    try {
      await invoke("update_order_status_v3", { sessionToken: token, orderId, newStatus: nextStatus });
      await fetchOrders();
    } catch {
      setError("حدث خطأ في تحديث الحالة");
    }
  };

  const filteredOrders = activeTab === "all"
    ? orders
    : orders.filter((o) => o.status === activeTab);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-ink-500 font-arabic">جاري التحميل...</div>;
  }

  const pendingCount = orders.filter((o) => o.status === "PENDING").length;
  const preparingCount = orders.filter((o) => o.status === "PREPARING").length;
  const readyCount = orders.filter((o) => o.status === "READY").length;

  return (
    <div className="flex flex-col h-full overflow-hidden" dir="rtl">
      <div className="bg-surface border-b border-ink-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-ink-900">شاشة المطبخ</h1>
          <span className="text-xs text-ink-500 font-mono">تحديث تلقائي كل ١٠ ثوان</span>
        </div>
        <div className="flex gap-4">
          <div className="flex items-center gap-1 text-sm">
            <span className="inline-block w-3 h-3 rounded-full bg-warn" />
            <span className="font-arabic text-ink-500">انتظار: {pendingCount}</span>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <span className="inline-block w-3 h-3 rounded-full bg-ink-500" />
            <span className="font-arabic text-ink-500">تحضير: {preparingCount}</span>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <span className="inline-block w-3 h-3 rounded-full bg-ok" />
            <span className="font-arabic text-ink-500">جاهز: {readyCount}</span>
          </div>
        </div>
      </div>

      <div className="flex gap-2 px-6 py-3 bg-surface border-b border-ink-200">
        {["all", "PENDING", "PREPARING", "READY"].map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className={`px-4 py-1.5 rounded-lg text-sm font-arabic transition-colors ${activeTab === t ? "bg-ink-900 text-white shadow-sh-1" : "bg-surface text-ink-500 hover:bg-ink-200"}`}>
            {t === "all" ? "الكل" : STATUS_LABELS[t] ?? t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 bg-danger-soft border border-danger-soft rounded-xl p-3 text-sm text-danger font-arabic">{error}</div>
        )}
        {filteredOrders.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <IconChefHat className="w-10 h-10 mx-auto mb-2 text-ink-300" stroke={1.5} />
              <p className="text-ink-500 font-arabic">لا توجد طلبات في المطبخ</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredOrders.map((order) => (
              <div key={order.id} className={`bg-surface rounded-2xl shadow-sh-1 overflow-hidden ${STATUS_COLORS[order.status]}`}>
                <div className={`p-4 ${STATUS_BG[order.status] || "bg-surface"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-ink-900 font-arabic">
                        {order.table_name || `#${order.id.slice(0, 6)}`}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-arabic bg-surface text-ink-500">
                        {ORDER_TYPE_LABELS[order.order_type] || order.order_type}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-ink-500">
                      {fmtTime(order.created_at)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-ink-500 font-arabic">
                      <span className="font-mono">{elapsed(order.created_at)}</span> منذ الطلب
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-arabic font-medium ${
                      order.status === "PENDING" ? "bg-surface text-warn" :
                      order.status === "PREPARING" ? "bg-surface text-ink-600" :
                      "bg-surface text-ok"
                    }`}>
                      {STATUS_LABELS[order.status] || order.status}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {order.items.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-surface rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-surface-alt text-ink-700 text-xs font-bold font-mono">
                            {item.quantity}
                          </span>
                          <span className="font-arabic text-sm text-ink-900">{item.name}</span>
                        </div>
                        {item.notes && (
                          <span className="text-[10px] text-warn font-arabic bg-surface-alt px-1.5 py-0.5 rounded">
                            {item.notes}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  {order.notes && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-400 font-arabic bg-surface rounded-lg px-3 py-1.5">
                      <IconNote className="w-3.5 h-3.5 shrink-0" stroke={1.75} />
                      {order.notes}
                    </div>
                  )}
                </div>

                <div className="p-3 border-t border-ink-200">
                  {order.status === "PENDING" && (
                    <button onClick={() => handleStatusChange(order.id, order.status)} className="w-full h-10 rounded-xl bg-ink-800 text-white text-sm font-bold hover:bg-ink-900 transition-colors shadow-sh-1">
                      بدء التحضير
                    </button>
                  )}
                  {order.status === "PREPARING" && (
                    <button onClick={() => handleStatusChange(order.id, order.status)} className="w-full h-10 rounded-xl bg-ok text-white text-sm font-bold hover:bg-ok transition-colors shadow-sh-1">
                      تم التجهيز
                    </button>
                  )}
                  {order.status === "READY" && (
                    <div className="flex gap-2">
                      <button onClick={() => handleStatusChange(order.id, order.status)} className="flex-1 h-10 rounded-xl bg-ink-200 text-ink-500 text-sm font-bold hover:bg-ink-300 transition-colors">
                        تم التقديم
                      </button>
                      <button onClick={() => handleStatusChange(order.id, "PREPARING")} className="px-4 h-10 rounded-xl bg-surface-alt text-warn text-sm font-bold hover:bg-ink-200 transition-colors">
                        إعادة
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
