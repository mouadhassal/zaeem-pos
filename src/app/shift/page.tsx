import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../../stores/authStore";
import { useShiftStore } from "../../stores/shiftStore";

const DIFF_THRESHOLD_CENTS = 5000;

interface ActiveShift {
  id: string;
  opened_at: string;
  starting_cash_cents: number;
  user_id: string;
}

interface ShiftStats {
  orderCount: number;
  totalSales: number;
  cashTotal: number;
  cardTotal: number;
}

interface SummaryData {
  expectedCash: number;
  actualCash: number;
  difference: number;
}

function formatElapsed(start: string): string {
  const ms = Date.now() - new Date(start).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtCurrency(cents: number, curr: string = "SAR"): string {
  return new Intl.NumberFormat("ar-SA", {
    style: "currency",
    currency: curr,
  }).format(cents / 100);
}

export default function ShiftPage() {
  const user = useAuthStore((s) => s.user);
  const setActiveShiftId = useShiftStore((s) => s.setActiveShiftId);
  const [currency, setCurrency] = useState("SAR");

  const [activeShift, setActiveShift] = useState<ActiveShift | null>(null);
  const [stats, setStats] = useState<ShiftStats>({ orderCount: 0, totalSales: 0, cashTotal: 0, cardTotal: 0 });
  const [recentOrders, setRecentOrders] = useState<{ id: string; total_cents: number; created_at: string; status: string }[]>([]);
  const [elapsed, setElapsed] = useState("00:00:00");

  const [startingCash, setStartingCash] = useState("");
  const [startingShift, setStartingShift] = useState(false);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [actualCash, setActualCash] = useState("");
  const [managerPassword, setManagerPassword] = useState("");
  const [needsAuth, setNeedsAuth] = useState(false);
  const [closing, setClosing] = useState(false);

  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showMsg = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  };

  const fetchShiftData = useCallback(async () => {
    try {
      const token = useAuthStore.getState().token;

      const cfg = await invoke<{ currency: string }>("get_chain_config_v3", { sessionToken: token });
      if (cfg) setCurrency(cfg.currency);

      const shift = await invoke<ActiveShift | null>("get_active_shift_v3", { sessionToken: token });

      setActiveShift(shift ?? null);
      setActiveShiftId(shift?.id ?? null);

      if (shift) {
        const stats = await invoke<{ order_count: number; total_sales: number; cash_total: number; card_total: number }>(
          "get_shift_stats_v3", { sessionToken: token, shiftId: shift.id }
        );
        setStats({
          orderCount: stats.order_count,
          totalSales: stats.total_sales,
          cashTotal: stats.cash_total,
          cardTotal: stats.card_total,
        });

        const orders = await invoke<{ id: string; total_cents: number; created_at: string; status: string }[]>(
          "list_shift_orders_v3", { sessionToken: token, shiftId: shift.id }
        );
        setRecentOrders(orders);
      }
    } catch {
      showMsg("حدث خطأ في تحميل بيانات الوردية");
    }
  }, [user?.id]);

  useEffect(() => {
    fetchShiftData();
  }, [fetchShiftData]);

  useEffect(() => {
    if (activeShift) {
      timerRef.current = setInterval(() => {
        setElapsed(formatElapsed(activeShift.opened_at));
      }, 1000);
      setElapsed(formatElapsed(activeShift.opened_at));
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [activeShift]);

  const handleStartShift = async () => {
    if (!user) return;
    const cents = Math.round(parseFloat(startingCash || "0") * 100);
    setStartingShift(true);
    try {
      const token = useAuthStore.getState().token;
      const id = await invoke<string>("open_shift_v3", { sessionToken: token, startingCashCents: cents });
      setActiveShiftId(id);
      showMsg("تم بدء الوردية بنجاح ✓");
      await fetchShiftData();
    } catch {
      showMsg("حدث خطأ في بدء الوردية");
    } finally {
      setStartingShift(false);
    }
  };

  const openCloseModal = () => {
    setActualCash("");
    setManagerPassword("");
    setNeedsAuth(false);
    setShowCloseModal(true);
  };

  const handleCloseShift = async () => {
    if (!user || !activeShift) return;
    setClosing(true);

    try {
      const token = useAuthStore.getState().token;

      const shiftStats = await invoke<{ cash_total: number }>("get_shift_stats_v3", { sessionToken: token, shiftId: activeShift.id });

      const expectedCashCents = shiftStats.cash_total + activeShift.starting_cash_cents;
      const actualCashCents = Math.round(parseFloat(actualCash || "0") * 100);
      const diffCents = actualCashCents - expectedCashCents;
      const absDiff = Math.abs(diffCents);

      if (absDiff > DIFF_THRESHOLD_CENTS && !needsAuth) {
        setNeedsAuth(true);
        setClosing(false);
        return;
      }

      if (needsAuth) {
        const valid = await invoke<boolean>("verify_manager_override_v3", {
          sessionToken: token,
          passwordOrPin: managerPassword,
        }).catch(() => false);
        if (!valid) {
          showMsg("كلمة المرور غير صحيحة");
          setClosing(false);
          return;
        }
      }

      await invoke("close_shift_v3", { sessionToken: token, shiftId: activeShift.id, endingCashCents: actualCashCents, differenceCents: diffCents });

      setSummary({
        expectedCash: expectedCashCents,
        actualCash: actualCashCents,
        difference: diffCents,
      });

      setShowCloseModal(false);
      setActiveShift(null);
      setActiveShiftId(null);
    } catch {
      showMsg("حدث خطأ في إغلاق الوردية");
    } finally {
      setClosing(false);
    }
  };

  if (summary) {
    return (
      <div className="flex items-center justify-center h-full" dir="rtl">
        <div className="bg-white rounded-2xl p-8 w-full max-w-sm space-y-6 border border-ink-600">
          <h1 className="text-xl font-bold text-ink-900 text-center font-arabic">
            ملخص إغلاق الوردية
          </h1>
          <div className="bg-white rounded-xl p-4 space-y-3 border border-ink-200">
            <div className="flex justify-between text-sm">
              <span className="text-ink-400 font-arabic">المتوقع</span>
              <span className="font-mono text-ink-900 font-bold">
                {fmtCurrency(summary.expectedCash, currency)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-ink-400 font-arabic">الفعلي</span>
              <span className="font-mono text-ink-900 font-bold">
                {fmtCurrency(summary.actualCash, currency)}
              </span>
            </div>
            <div className="border-t border-ink-200 pt-3 flex justify-between text-sm">
              <span className="text-ink-400 font-arabic">الفرق</span>
              <span
                className={`font-mono font-bold ${
                  summary.difference >= 0
                    ? "text-saffron-600"
                    : "text-red-500"
                }`}
              >
                {summary.difference >= 0 ? "+" : ""}
                {fmtCurrency(summary.difference, currency)}
              </span>
            </div>
          </div>
          <button
            onClick={() => setSummary(null)}
            className="w-full h-14 rounded-xl bg-saffron-600 text-white font-bold hover:bg-saffron-700 transition-colors shadow-lg shadow-saffron-600\/20"
          >
            فتح وردية جديدة
          </button>
        </div>
      </div>
    );
  }

  if (!activeShift) {
    return (
      <div className="flex items-center justify-center h-full" dir="rtl">
        <div className="bg-white rounded-2xl p-8 w-full max-w-sm space-y-6 border border-ink-600">
          <div className="text-center space-y-2">
            <h1 className="text-xl font-bold text-ink-900 font-arabic">ابدأ الوردية</h1>
            <p className="text-sm text-ink-400 font-arabic">أدخل الرصيد الافتتاحي لبدء الوردية</p>
          </div>

          <div className="space-y-2">
            <label className="text-ink-400 text-sm font-arabic">الرصيد الافتتاحي</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={startingCash}
              onChange={(e) => setStartingCash(e.target.value)}
              className="w-full h-14 bg-white rounded-xl px-4 text-ink-900 text-lg font-mono outline-none focus:ring-2 focus:ring-saffron-200 border border-ink-200"
              dir="ltr"
              placeholder="0.00"
            />
          </div>

          <button
            onClick={handleStartShift}
            disabled={startingShift}
            className="w-full h-14 rounded-xl bg-saffron-600 text-white font-bold text-lg flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-saffron-700 transition-colors shadow-lg shadow-600/20"
          >
            {startingShift ? (
              "جاري..."
            ) : (
              <>🟢 بدء الوردية</>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">الوردية الحالية</h1>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-ink-400 text-xs font-arabic mb-1">⏱️ الوقت المنقضي</p>
          <p className="text-2xl font-bold font-mono text-saffron-600">{elapsed}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-ink-400 text-xs font-arabic mb-1">عدد الطلبات</p>
          <p className="text-2xl font-bold text-ink-900">{stats.orderCount}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-ink-400 text-xs font-arabic mb-1">إجمالي المبيعات</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">{fmtCurrency(stats.totalSales, currency)}</p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-ink-400 text-xs font-arabic mb-1">نقدي</p>
          <p className="text-2xl font-bold text-saffron-600 font-mono">{fmtCurrency(stats.cashTotal, currency)}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-ink-900 font-arabic">آخر الطلبات</h2>
        </div>
        {recentOrders.length === 0 ? (
          <div className="text-center text-ink-500 font-arabic py-4 text-sm">
            لا توجد طلبات بعد
          </div>
        ) : (
          <div className="space-y-2">
            {recentOrders.map((o) => (
              <div key={o.id} className="flex items-center justify-between py-2 border-b border-ink-200 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-ink-500">{o.id.slice(0, 6)}</span>
                  <span className="text-sm text-ink-900 font-arabic">
                    {o.status === "PAID" ? "مدفوع" : o.status === "CANCELLED" ? "ملغي" : o.status}
                  </span>
                </div>
                <span className="font-mono text-sm text-ink-900">{fmtCurrency(o.total_cents, currency)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-center pt-4">
        <button
          onClick={openCloseModal}
          className="h-16 px-12 rounded-2xl bg-red-500 text-white font-bold text-lg flex items-center gap-3 hover:bg-red-600 transition-colors shadow-lg shadow-red-500/30"
        >
          🔴 إغلاق الوردية
        </button>
      </div>

      {showCloseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="text-lg font-bold font-arabic text-ink-900 text-center">
              إغلاق الوردية
            </h2>

            <div className="space-y-2">
              <label className="text-ink-400 text-sm font-arabic">الرصيد الفعلي (النقدي)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={actualCash}
                onChange={(e) => setActualCash(e.target.value)}
                className="w-full h-14 bg-white rounded-xl px-4 text-ink-900 text-lg font-mono outline-none focus:ring-2 focus:ring-saffron-200 border border-ink-200"
                dir="ltr"
                placeholder="0.00"
              />
            </div>

            {needsAuth && (
              <div className="space-y-2">
                <label className="text-ink-400 text-sm font-arabic">
                  كلمة مرور المدير (الفارق كبير)
                </label>
                <input
                  type="password"
                  value={managerPassword}
                  onChange={(e) => setManagerPassword(e.target.value)}
                  className="w-full h-14 bg-white rounded-xl px-4 text-ink-900 outline-none focus:ring-2 focus:ring-saffron-200 border border-ink-200"
                  dir="ltr"
                />
              </div>
            )}

            <button
              onClick={handleCloseShift}
              disabled={closing}
              className="w-full h-14 rounded-xl bg-red-500 text-white font-bold disabled:opacity-50 hover:bg-red-600 transition-colors shadow-lg shadow-red-500/20"
            >
              {closing ? "جاري الإغلاق..." : "تأكيد الإغلاق"}
            </button>

            <button
              onClick={() => setShowCloseModal(false)}
              className="w-full h-10 rounded-xl bg-white text-ink-500 font-arabic text-sm hover:bg-ink-200 transition-colors"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className={`fixed top-20 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-lg z-50 font-arabic ${
          message.includes("خطأ") || message.includes("صحيحة") ? "bg-red-500 text-white" : "bg-saffron-600 text-white"
        }`}>
          {message}
        </div>
      )}
    </div>
  );
}
