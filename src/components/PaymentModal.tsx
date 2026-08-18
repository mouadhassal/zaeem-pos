import { useState, useEffect, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { IconX, IconCash, IconCreditCard, IconWallet, IconCircleCheck } from "@tabler/icons-react";
import { useCartStore } from "../stores/cartStore";
import { useOrderTypeStore } from "../stores/orderTypeStore";
import { openCashDrawer } from "../lib/printer";
import { useAuthStore } from "../stores/authStore";
import { useCurrency } from "../hooks/useCurrency";
import { realErrorText } from "../lib/errors";
import { parseMoneyInput } from "../lib/money";
import Typeahead from "./ui/Typeahead";

interface DebtorRow {
  id: string;
  name: string;
  phone: string;
}

type PaymentMethod = "CASH" | "CARD" | "WALLET" | "CREDIT";

function formatCompact(amt: number) {
  if (amt >= 1000) return `${(amt / 1000).toFixed(amt % 1000 === 0 ? 0 : 1)}k`;
  return amt.toString();
}

const QUICK_AMOUNTS = [1000, 5000, 10000, 25000, 50000, 60000, 75000, 100000];

interface Props {
  onClose: () => void;
  onSuccess: (method: string, receivedCents: number, changeCents: number, debtorId?: string) => void | Promise<void>;
  initialMethod?: PaymentMethod | undefined;
  initialDebtorId?: string | undefined;
  initialDebtorName?: string | undefined;
  /**
   * Split-bill payment flow: when set, this exact amount is what's owed
   * instead of the live cart total (the split order this modal is paying
   * was already created server-side with its own fixed total_cents --
   * reading from the cart here would be wrong once the cart's been cleared
   * or has moved on to the next split in the queue).
   */
  totalOverrideCents?: number | undefined;
  /** Shown under the total, e.g. "الفاتورة ١ (١ من ٢)" for split payments. */
  subtitleOverride?: string | undefined;
}

export default function PaymentModal({ onClose, onSuccess, initialMethod, initialDebtorId, initialDebtorName, totalOverrideCents, subtitleOverride }: Props) {
  // 2026-08-14 backend hardening pass: delivery zone fees were fully
  // configurable but never actually charged -- this is the amount the
  // cashier collects and change is computed against, so it has to be
  // folded in here, not just recorded on the order afterward (a mismatch
  // between what's collected and what orderService.ts's createOrder
  // records as total_cents would be a real cash-drawer discrepancy).
  const cartTotalCents = useCartStore((s) => s.total());
  const deliveryFeeCents = useOrderTypeStore((s) => (s.orderType === "DELIVERY" ? s.deliveryFeeCents : 0));
  const totalCents = totalOverrideCents ?? (cartTotalCents + deliveryFeeCents);
  const { fmt, symbol } = useCurrency();
  const [method, setMethod] = useState<PaymentMethod>(initialMethod ?? "CASH");
  const [receivedStr, setReceivedStr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const [debtorPhone, setDebtorPhone] = useState("");
  const [debtorName, setDebtorName] = useState<string | null>(initialDebtorName ?? null);
  const [debtorId, setDebtorId] = useState<string | null>(initialDebtorId ?? null);
  const [showNewDebtorForm, setShowNewDebtorForm] = useState(false);
  const [newDebtorName, setNewDebtorName] = useState("");
  const receivedCents = parseMoneyInput(receivedStr);
  const changeCents = Math.max(0, receivedCents - totalCents);
  const sufficient = method === "CARD" || method === "WALLET" || (method === "CREDIT" && !!debtorId) || receivedCents >= totalCents;

  // 2026-08-18 numpad double-digit fix: this used to also handle digit and
  // backspace keys, which duplicated the controlled `<input onChange>`
  // below -- a typed digit hit both this listener's own state update AND
  // the input's onChange, appending the character twice. The input is the
  // single source of truth for its own value now; this listener only
  // covers the two keys nothing else handles (Escape to close, Enter to
  // confirm once the amount is sufficient).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && sufficient) {
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sufficient, onClose]);

  // list_debtors_v3 takes no query param (returns the tenant's whole debtor
  // list) -- fetchSuggestions below re-fetches on each debounce tick (same
  // 300ms timing this replaced) and filters by phone-prefix client-side, so
  // this stays genuinely "fetch mode" (not pre-loaded into component state)
  // rather than an in-memory filter over a one-time load.
  const fetchDebtorSuggestions = useCallback(async (query: string): Promise<DebtorRow[]> => {
    const token = useAuthStore.getState().token;
    const debtors = await invoke<DebtorRow[]>("list_debtors_v3", { sessionToken: token });
    return debtors.filter((row) => row.phone.includes(query));
  }, []);

  useEffect(() => {
    if (method !== "CREDIT") {
      setDebtorName(null); setDebtorId(null); setError(null);
    }
  }, [method]);

  const handleConfirm = async () => {
    if (!sufficient) {
      setError("المبلغ غير كافٍ");
      return;
    }
    // 2026-08-09 audit fix: onSuccess (handlePaymentSuccess in pos/page.tsx)
    // is the actual async order-create + finalize-payment + print call --
    // this used to fire it without awaiting, then immediately flip
    // `processing` back to false, re-enabling the Confirm button while that
    // request was still in flight. A double-click (or just a slow DB round
    // trip) created and paid the order twice, with duplicate receipts/
    // kitchen tickets. Now genuinely blocks re-entry for the whole
    // duration, success or failure.
    if (method === "CREDIT") {
      if (!debtorId) { setError("يرجى إدخال رقم هاتف صحيح"); return; }
      setProcessing(true);
      try {
        await onSuccess(method, totalCents, 0, debtorId);
      } finally {
        setProcessing(false);
      }
      return;
    }
    setProcessing(true);
    try {
      // 2026-08-04: this used to fire for CARD/WALLET too -- there's no cash
      // to give change on either of those, so the drawer had no reason to
      // pop open other than announcing "someone just paid" to the whole
      // dining room. Cash-only, matching what the drawer is actually for.
      if (method === "CASH") {
        try {
          await openCashDrawer();
        } catch {
          // drawer may not be connected
        }
      }
      await onSuccess(method, method === "CASH" ? receivedCents : totalCents, method === "CASH" ? changeCents : 0);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[520px] overflow-hidden" dir="rtl">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-lg text-ink-900">الدفع</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-ink-100 flex items-center justify-center transition-colors"
          >
            <IconX className="w-5 h-5 text-ink-500" stroke={1.75} />
          </button>
        </div>

        <div className="px-6 py-4 bg-surface">
          <div className="flex justify-between items-center mb-1">
            <span className="font-arabic text-ink-400 text-sm">الإجمالي</span>
            <span className="font-mono font-bold text-xl text-ink-900">
              {fmt(totalCents)}
            </span>
          </div>
          <div className="font-arabic text-xs text-ink-500">
            {subtitleOverride ?? (
              <>
                {useCartStore.getState().tableName
                  ? `طاولة ${useCartStore.getState().tableName} · `
                  : ""}
                {useCartStore.getState().items.length} أصناف
              </>
            )}
          </div>
        </div>

        <div className="px-6 pt-4">
          <div className="flex gap-2 bg-surface-alt rounded-xl p-1">
            {(["CASH", "CARD", "WALLET", "CREDIT"] as PaymentMethod[]).map((m) => {
              const MethodIcon = m === "CASH" ? IconCash : m === "CARD" ? IconCreditCard : m === "WALLET" ? IconWallet : IconCircleCheck;
              return (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`flex-1 py-2.5 rounded-lg font-arabic font-medium text-sm transition-all flex items-center justify-center gap-1.5 ${
                    method === m
                      ? "bg-white text-ink-900 border border-line"
                      : "text-ink-400 hover:text-ink-900"
                  }`}
                >
                  <MethodIcon className="w-4 h-4" stroke={1.75} />
                  {m === "CASH" ? "نقدي" : m === "CARD" ? "بطاقة" : m === "WALLET" ? "محفظة" : "دين"}
                </button>
              );
            })}
          </div>
        </div>

        {method === "CASH" && (
          <div className="px-6 py-4">
            <div className="mb-3">
              <label className="font-arabic text-sm text-ink-500 mb-1.5 block">
                المبلغ المستلم
              </label>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={receivedStr}
                  onChange={(e) => setReceivedStr(e.target.value)}
                  className="w-full h-14 text-right font-mono text-2xl font-bold text-ink-900 bg-white border-2 border-ink-200 rounded-sm px-4 focus:border-accent outline-none transition-all"
                  placeholder="٠"
                  autoFocus
                  dir="ltr"
                />
                <span className="absolute left-4 top-1/2 -translate-y-1/2 font-arabic text-ink-500">
                  {symbol}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 mb-4">
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => setReceivedStr(String(amt))}
                  className="h-10 rounded-lg bg-surface-alt font-mono font-medium text-ink-900 hover:bg-accent-soft hover:text-accent-text transition-colors"
                >
                  {formatCompact(amt)}
                </button>
              ))}
            </div>

            <div
              className={`rounded-xl p-4 flex justify-between items-center transition-colors ${
                receivedCents > 0 && sufficient
                  ? "bg-accent-soft"
                  : receivedCents > 0 && !sufficient
                  ? "bg-danger-soft"
                  : "bg-surface-alt"
              }`}
            >
              <span
                className={`font-arabic font-medium ${
                  receivedCents > 0 && sufficient
                    ? "text-accent-text"
                    : receivedCents > 0 && !sufficient
                    ? "text-danger"
                    : "text-ink-400"
                }`}
              >
                {receivedCents > 0 && !sufficient
                  ? "المبلغ غير كافٍ"
                  : "الباقي"}
              </span>
              <span
                className={`font-mono font-bold text-2xl ${
                  receivedCents > 0 && sufficient
                    ? "text-accent-text"
                    : receivedCents > 0 && !sufficient
                    ? "text-danger"
                    : "text-ink-500"
                }`}
              >
                {receivedCents > 0 ? fmt(sufficient ? changeCents : totalCents - receivedCents) : "---"}
              </span>
            </div>
          </div>
        )}

        {method === "CREDIT" && (
          <div className="px-6 py-4 space-y-3">
            <div>
              <label className="font-arabic text-sm text-ink-500 mb-1.5 block">
                رقم هاتف العميل
              </label>
              <Typeahead<DebtorRow>
                value={debtorPhone}
                onChange={(v) => {
                  setDebtorPhone(v);
                  // Typing again invalidates whatever was previously
                  // selected/resolved -- matches the old effect's behavior
                  // of clearing debtorName/debtorId until a fresh match.
                  setDebtorName(null);
                  setDebtorId(null);
                  setError(null);
                }}
                fetchSuggestions={fetchDebtorSuggestions}
                minChars={3}
                getKey={(d) => d.id}
                onSelect={(d) => { setDebtorName(d.name); setDebtorId(d.id); setError(null); setShowNewDebtorForm(false); }}
                renderItem={(d) => (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-900 font-medium">{d.name}</span>
                    <span className="font-mono text-ink-500 text-xs" dir="ltr">{d.phone}</span>
                  </div>
                )}
                placeholder="٠٧٧٠xxxxxxx"
                emptyMessage="رقم الهاتف غير موجود"
                autoFocus
                dir="ltr"
              />
            </div>
            {debtorName && (
              <div className="bg-accent-soft rounded-xl p-3 flex items-center justify-between">
                <span className="font-arabic text-sm text-accent-text">العميل: {debtorName}</span>
                <span className="font-mono text-sm text-accent-text font-bold">{fmt(totalCents)}</span>
              </div>
            )}
            {!debtorName && debtorPhone.trim().length >= 8 && !showNewDebtorForm && (
              <div className="space-y-2">
                <p className="text-sm text-danger font-arabic">رقم الهاتف غير موجود</p>
                <button
                  onClick={() => setShowNewDebtorForm(true)}
                  className="w-full h-10 rounded-xl bg-accent text-white text-sm font-bold hover:bg-accent-text transition-colors"
                >
                  إضافة مدين جديد
                </button>
              </div>
            )}
            {showNewDebtorForm && (
              <div className="bg-surface-alt rounded-xl border border-ink-200 p-3 space-y-2">
                <input
                  type="text"
                  value={newDebtorName}
                  onChange={(e) => setNewDebtorName(e.target.value)}
                  placeholder="اسم المدين *"
                  className="w-full h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-accent"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowNewDebtorForm(false); setNewDebtorName(""); }}
                    className="flex-1 h-9 rounded-sm bg-surface-alt text-ink-500 text-sm font-arabic hover:bg-ink-200 transition-colors"
                  >
                    إلغاء
                  </button>
                  <button
                    onClick={async () => {
                      if (!newDebtorName.trim()) return;
                      try {
                        const token = useAuthStore.getState().token;
                        const id = await invoke<string>("create_debtor_v3", {
                          sessionToken: token,
                          name: newDebtorName.trim(),
                          phone: debtorPhone.trim(),
                          email: null, address: null, notes: null,
                        });
                        setDebtorName(newDebtorName.trim());
                        setDebtorId(id);
                        setError(null);
                        setShowNewDebtorForm(false);
                        setNewDebtorName("");
                      } catch (err) {
                        setError(`حدث خطأ في إضافة المدين: ${realErrorText(err)}`);
                      }
                    }}
                    disabled={!newDebtorName.trim()}
                    className="flex-1 h-9 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-accent-text transition-colors disabled:opacity-50"
                  >
                    حفظ
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {method !== "CASH" && method !== "CREDIT" && (
          <div className="px-6 py-12 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent-soft flex items-center justify-center">
              <IconCircleCheck className="w-8 h-8 text-accent-text" stroke={1.75} />
            </div>
            <p className="font-arabic text-ink-900 font-medium mb-2">
              {method === "CARD" ? "استخدام جهاز البطاقة" : "الدفع بالمحفظة"}
            </p>
            <p className="font-arabic text-sm text-ink-500">
              {method === "CARD" ? "يرجى تمرير البطاقة على الجهاز" : "سيتم خصم المبلغ من المحفظة"}
            </p>
          </div>
        )}

        {error && (
          <p className="px-6 pb-2 text-danger text-sm text-center font-arabic">{error}</p>
        )}

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 h-14 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200 transition-colors"
          >
            إلغاء
          </button>
          <button
            onClick={handleConfirm}
            disabled={!sufficient || processing}
            className="flex-1 h-14 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-accent-text active:scale-[0.98] transition-all disabled:opacity-50 disabled:shadow-none"
          >
            {processing ? "...جارٍ" : "تأكيد وطباعة"}
          </button>
        </div>
      </div>
    </div>
  );
}
