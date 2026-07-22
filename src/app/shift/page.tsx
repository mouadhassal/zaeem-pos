import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconClockHour3, IconReceipt2, IconCash, IconCreditCard,
  IconPlayerPlayFilled, IconLogout2, IconAlertTriangle, IconX,
} from "@tabler/icons-react";
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

/** Rust returns the real reason ("opening a shift requires a Branch-scoped
 * actor", "select a branch to open a shift for", etc.) as the Err(String) --
 * this used to be thrown away by a bare `catch {}` everywhere on this page,
 * which is exactly why "start shift" looked like it silently did nothing. */
function errText(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return fallback;
}

export default function ShiftPage() {
  const user = useAuthStore((s) => s.user);
  const setActiveShiftId = useShiftStore((s) => s.setActiveShiftId);
  const [currency, setCurrency] = useState("SAR");

  const [activeShift, setActiveShift] = useState<ActiveShift | null>(null);
  const [stats, setStats] = useState<ShiftStats>({ orderCount: 0, totalSales: 0, cashTotal: 0, cardTotal: 0 });
  const [recentOrders, setRecentOrders] = useState<{ id: string; total_cents: number; created_at: string; status: string }[]>([]);
  const [elapsed, setElapsed] = useState("00:00:00");
  const [initialLoading, setInitialLoading] = useState(true);

  const [startingCash, setStartingCash] = useState("");
  const [startingShift, setStartingShift] = useState(false);

  // Owner accounts have no home branch (tenant-scoped, see open_shift_v3's
  // doc comment) -- they must pick which branch they're opening a till for.
  // Branch-scoped staff (Manager/Cashier/Kitchen/Server) never see this.
  const [branches, setBranches] = useState<[string, string][]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string>("");
  const needsBranchPicker = user?.branchId == null;

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [actualCash, setActualCash] = useState("");
  const [managerPassword, setManagerPassword] = useState("");
  const [needsAuth, setNeedsAuth] = useState(false);
  const [closing, setClosing] = useState(false);

  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showMsg = (text: string, isError = false) => {
    setMessage({ text, isError });
    setTimeout(() => setMessage(null), 3500);
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
    } catch (err) {
      showMsg(errText(err, "حدث خطأ في تحميل بيانات الوردية"), true);
    } finally {
      setInitialLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchShiftData();
  }, [fetchShiftData]);

  useEffect(() => {
    if (!needsBranchPicker) return;
    (async () => {
      try {
        const token = useAuthStore.getState().token;
        const rows = await invoke<[string, string][]>("list_branches_v3", { sessionToken: token });
        setBranches(rows);
        if (rows.length === 1) setSelectedBranchId(rows[0][0]);
      } catch (err) {
        showMsg(errText(err, "تعذر تحميل قائمة الفروع"), true);
      }
    })();
  }, [needsBranchPicker]);

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
    if (needsBranchPicker && !selectedBranchId) {
      showMsg("الرجاء اختيار الفرع أولاً", true);
      return;
    }
    const cents = Math.round(parseFloat(startingCash || "0") * 100);
    setStartingShift(true);
    try {
      const token = useAuthStore.getState().token;
      const id = await invoke<string>("open_shift_v3", {
        sessionToken: token,
        startingCashCents: cents,
        branchId: needsBranchPicker ? selectedBranchId : null,
      });
      setActiveShiftId(id);
      showMsg("تم بدء الوردية بنجاح");
      await fetchShiftData();
    } catch (err) {
      showMsg(errText(err, "حدث خطأ في بدء الوردية"), true);
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
        try {
          await invoke<boolean>("verify_manager_override_v3", {
            sessionToken: token,
            passwordOrPin: managerPassword,
          });
        } catch (err) {
          const msg = typeof err === "string" ? err : (err as Error)?.message ?? "";
          if (msg.includes("ECONNREFUSED") || msg.includes("network") || msg.includes("fetch")) {
            showMsg("خطأ في الاتصال بالخادم", true);
          } else {
            showMsg("كلمة المرور غير صحيحة", true);
          }
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
    } catch (err) {
      showMsg(errText(err, "حدث خطأ في إغلاق الوردية"), true);
    } finally {
      setClosing(false);
    }
  };

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center h-full" dir="rtl">
        <div className="bg-surface rounded-[13px] p-8 w-full max-w-sm space-y-4 shadow-sh-2 border border-line">
          <div className="h-6 w-40 mx-auto rounded bg-surface-alt animate-pulse" />
          <div className="h-14 w-full rounded-xl bg-surface-alt animate-pulse" />
          <div className="h-14 w-full rounded-xl bg-surface-alt animate-pulse" />
        </div>
      </div>
    );
  }

  if (summary) {
    return (
      <div className="flex items-center justify-center h-full" dir="rtl">
        <div className="bg-surface rounded-[13px] p-8 w-full max-w-sm space-y-6 shadow-sh-3 border border-line">
          <div className="text-center space-y-1">
            <div className="w-12 h-12 rounded-full bg-accent-soft flex items-center justify-center mx-auto mb-1">
              <IconReceipt2 className="w-6 h-6 text-accent-text" stroke={1.75} />
            </div>
            <h1 className="text-lg font-bold text-text">ملخص إغلاق الوردية</h1>
          </div>
          <div className="bg-surface-alt rounded-xl p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-text-3">المتوقع</span>
              <span className="font-mono text-text font-bold tabular" dir="ltr">
                {fmtCurrency(summary.expectedCash, currency)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-3">الفعلي</span>
              <span className="font-mono text-text font-bold tabular" dir="ltr">
                {fmtCurrency(summary.actualCash, currency)}
              </span>
            </div>
            <div className="border-t border-line pt-3 flex justify-between text-sm">
              <span className="text-text-3">الفرق</span>
              <span
                className="font-mono font-bold tabular"
                dir="ltr"
                style={{ color: summary.difference >= 0 ? "var(--ok)" : "var(--danger)" }}
              >
                {summary.difference >= 0 ? "+" : ""}
                {fmtCurrency(summary.difference, currency)}
              </span>
            </div>
          </div>
          <button
            onClick={() => setSummary(null)}
            className="w-full h-14 rounded-xl bg-accent text-white font-bold hover:bg-accent-text shadow-sh-3 active:scale-[0.98] transition-all"
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
        <div className="bg-surface rounded-[13px] p-8 w-full max-w-sm space-y-6 shadow-sh-3 border border-line">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 rounded-full bg-accent-soft flex items-center justify-center mx-auto mb-1">
              <IconClockHour3 className="w-6 h-6 text-accent-text" stroke={1.75} />
            </div>
            <h1 className="text-lg font-bold text-text">ابدأ الوردية</h1>
            <p className="text-sm text-text-3">أدخل الرصيد الافتتاحي لبدء الوردية</p>
          </div>

          {needsBranchPicker && (
            <div className="space-y-2">
              <label className="text-text-3 text-sm">الفرع</label>
              <select
                value={selectedBranchId}
                onChange={(e) => setSelectedBranchId(e.target.value)}
                className="w-full h-14 bg-surface rounded-xl px-4 text-text outline-none focus:border-accent border border-line transition-all"
                dir="rtl"
              >
                <option value="" disabled>اختر الفرع</option>
                {branches.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-text-3 text-sm">الرصيد الافتتاحي</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={startingCash}
              onChange={(e) => setStartingCash(e.target.value)}
              className="w-full h-14 bg-surface rounded-xl px-4 text-text text-lg font-mono outline-none focus:border-accent border border-line transition-all"
              dir="ltr"
              placeholder="0.00"
            />
          </div>

          <button
            onClick={handleStartShift}
            disabled={startingShift || (needsBranchPicker && !selectedBranchId)}
            className="w-full h-14 rounded-xl bg-accent text-white font-bold text-lg flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-accent-text shadow-sh-3 active:scale-[0.98] transition-all"
          >
            {startingShift ? (
              "جاري..."
            ) : (
              <>
                <IconPlayerPlayFilled className="w-5 h-5" />
                بدء الوردية
              </>
            )}
          </button>
        </div>

        {message && (
          <div
            className="fixed top-20 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-sh-3 z-50 text-white font-medium"
            style={{ background: message.isError ? "var(--danger)" : "var(--ok)" }}
          >
            {message.text}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text">الوردية الحالية</h1>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="bg-surface rounded-[13px] p-4 shadow-sh-2 border border-line">
          <div className="flex items-center gap-1.5 text-text-3 text-xs mb-1.5">
            <IconClockHour3 className="w-3.5 h-3.5" stroke={1.75} />
            الوقت المنقضي
          </div>
          <p className="text-2xl font-bold font-mono tabular text-accent-text" dir="ltr">{elapsed}</p>
        </div>
        <div className="bg-surface rounded-[13px] p-4 shadow-sh-2 border border-line">
          <div className="flex items-center gap-1.5 text-text-3 text-xs mb-1.5">
            <IconReceipt2 className="w-3.5 h-3.5" stroke={1.75} />
            عدد الطلبات
          </div>
          <p className="text-2xl font-bold text-text tabular">{stats.orderCount}</p>
        </div>
        <div className="bg-surface rounded-[13px] p-4 shadow-sh-2 border border-line">
          <div className="flex items-center gap-1.5 text-text-3 text-xs mb-1.5">
            إجمالي المبيعات
          </div>
          <p className="text-2xl font-bold text-accent-text font-mono tabular" dir="ltr">{fmtCurrency(stats.totalSales, currency)}</p>
        </div>
        <div className="bg-surface rounded-[13px] p-4 shadow-sh-2 border border-line">
          <div className="flex items-center gap-1.5 text-text-3 text-xs mb-1.5">
            <IconCash className="w-3.5 h-3.5" stroke={1.75} />
            نقدي
          </div>
          <p className="text-2xl font-bold text-accent-text font-mono tabular" dir="ltr">{fmtCurrency(stats.cashTotal, currency)}</p>
        </div>
      </div>

      <div className="bg-surface rounded-[13px] p-4 shadow-sh-2 border border-line">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-text">آخر الطلبات</h2>
          <div className="flex items-center gap-1.5 text-text-3 text-xs">
            <IconCreditCard className="w-3.5 h-3.5" stroke={1.75} />
            <span className="font-mono tabular" dir="ltr">{fmtCurrency(stats.cardTotal, currency)}</span>
            <span>شبكة</span>
          </div>
        </div>
        {recentOrders.length === 0 ? (
          <div className="text-center text-text-muted py-4 text-sm">
            لا توجد طلبات بعد
          </div>
        ) : (
          <div className="space-y-2">
            {recentOrders.map((o) => (
              <div key={o.id} className="flex items-center justify-between py-2 border-b border-line-2 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-text-muted">{o.id.slice(0, 6)}</span>
                  <span className="text-sm text-text">
                    {o.status === "PAID" ? "مدفوع" : o.status === "CANCELLED" ? "ملغي" : o.status}
                  </span>
                </div>
                <span className="font-mono text-sm text-text tabular" dir="ltr">{fmtCurrency(o.total_cents, currency)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-center pt-4">
        <button
          onClick={openCloseModal}
          className="h-14 px-10 rounded-xl text-white font-bold text-base flex items-center gap-2.5 shadow-sh-3 active:scale-[0.98] transition-all"
          style={{ background: "var(--danger)" }}
        >
          <IconLogout2 className="w-5 h-5" stroke={1.75} />
          إغلاق الوردية
        </button>
      </div>

      {showCloseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" dir="rtl">
          <div className="bg-surface rounded-[13px] shadow-sh-3 border border-line w-full max-w-sm mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-line flex items-center justify-between">
              <h2 className="text-base font-bold text-text">إغلاق الوردية</h2>
              <button
                onClick={() => setShowCloseModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:bg-surface-alt transition-colors"
              >
                <IconX className="w-4 h-4" stroke={1.75} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-text-3 text-sm">الرصيد الفعلي (النقدي)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                  className="w-full h-14 bg-surface rounded-xl px-4 text-text text-lg font-mono outline-none focus:border-accent border border-line transition-all"
                  dir="ltr"
                  placeholder="0.00"
                  autoFocus
                />
              </div>

              {needsAuth && (
                <div className="space-y-2 rounded-xl p-3" style={{ background: "var(--danger-soft)" }}>
                  <div className="flex items-center gap-1.5 text-sm font-medium" style={{ color: "var(--danger)" }}>
                    <IconAlertTriangle className="w-4 h-4" stroke={1.75} />
                    الفرق كبير -- يتطلب كلمة مرور المدير
                  </div>
                  <input
                    type="password"
                    value={managerPassword}
                    onChange={(e) => setManagerPassword(e.target.value)}
                    className="w-full h-12 bg-surface rounded-xl px-4 text-text outline-none focus:border-accent border border-line transition-all"
                    dir="ltr"
                    autoFocus
                  />
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-line flex gap-3">
              <button
                onClick={() => setShowCloseModal(false)}
                className="flex-1 h-12 rounded-xl bg-surface text-text font-bold hover:bg-surface-alt border border-line transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={handleCloseShift}
                disabled={closing}
                className="flex-1 h-12 rounded-xl text-white font-bold disabled:opacity-50 shadow-sh-3 transition-all"
                style={{ background: "var(--danger)" }}
              >
                {closing ? "جاري الإغلاق..." : "تأكيد الإغلاق"}
              </button>
            </div>
          </div>
        </div>
      )}

      {message && (
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-sh-3 z-50 text-white font-medium"
          style={{ background: message.isError ? "var(--danger)" : "var(--ok)" }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
