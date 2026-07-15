import { useState, useEffect, useCallback } from "react";
import { IconX, IconCash, IconCreditCard, IconWallet, IconCircleCheck } from "@tabler/icons-react";
import { useCartStore } from "../stores/cartStore";
import { openCashDrawer } from "../lib/printer";
import { getDb } from "../db";
import { useCurrency } from "../hooks/useCurrency";

type PaymentMethod = "CASH" | "CARD" | "WALLET" | "CREDIT";

function formatCompact(amt: number) {
  if (amt >= 1000) return `${(amt / 1000).toFixed(amt % 1000 === 0 ? 0 : 1)}k`;
  return amt.toString();
}

const QUICK_AMOUNTS = [1000, 5000, 10000, 25000, 50000, 60000, 75000, 100000];

interface Props {
  onClose: () => void;
  onSuccess: (method: string, receivedCents: number, changeCents: number, debtorId?: string) => void;
}

export default function PaymentModal({ onClose, onSuccess }: Props) {
  const totalCents = useCartStore((s) => s.total());
  const { fmt, symbol } = useCurrency();
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [receivedStr, setReceivedStr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const [debtorPhone, setDebtorPhone] = useState("");
  const [debtorName, setDebtorName] = useState<string | null>(null);
  const [debtorId, setDebtorId] = useState<string | null>(null);
  const [showNewDebtorForm, setShowNewDebtorForm] = useState(false);
  const [newDebtorName, setNewDebtorName] = useState("");
  const receivedCents = Math.round((parseFloat(receivedStr) || 0) * 100);
  const changeCents = Math.max(0, receivedCents - totalCents);
  const sufficient = method === "CARD" || method === "WALLET" || (method === "CREDIT" && !!debtorId) || receivedCents >= totalCents;

  const handleKey = useCallback((key: string) => {
    setReceivedStr((prev) => {
      if (key === "backspace") return prev.slice(0, -1);
      if (key === "clear") return "";
      if (key === ".") {
        if (prev.includes(".")) return prev;
        return prev + ".";
      }
      if (prev.includes(".") && prev.split(".")[1]?.length >= 2) return prev;
      const next = prev + key;
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        handleKey(e.key);
      } else if (e.key === "Backspace") {
        handleKey("backspace");
      } else if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && sufficient) {
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sufficient, handleKey, onClose]);

  useEffect(() => {
    if (method === "CREDIT" && debtorPhone.trim().length >= 8) {
      getDb().then((db) => {
        db.selectFrom("debtors").selectAll().where("phone", "=", debtorPhone.trim()).executeTakeFirst().then((d) => {
          if (d) { setDebtorName(d.name); setDebtorId(d.id); setError(null); }
          else { setDebtorName(null); setDebtorId(null); setError("رقم الهاتف غير موجود"); }
        }).catch(() => {});
      });
    } else if (method === "CREDIT") {
      setDebtorName(null); setDebtorId(null); setError(null);
    }
  }, [debtorPhone, method]);

  const handleConfirm = async () => {
    if (!sufficient) {
      setError("المبلغ غير كافٍ");
      return;
    }
    if (method === "CREDIT") {
      if (!debtorId) { setError("يرجى إدخال رقم هاتف صحيح"); return; }
      setProcessing(true);
      onSuccess(method, totalCents, 0, debtorId);
      return;
    }
    setProcessing(true);
    try {
      await openCashDrawer();
    } catch {
      // drawer may not be connected
    }
    onSuccess(method, method === "CASH" ? receivedCents : totalCents, method === "CASH" ? changeCents : 0);
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl border border-ink-600 w-[520px] overflow-hidden" dir="rtl">
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
            {useCartStore.getState().tableName
              ? `طاولة ${useCartStore.getState().tableName} · `
              : ""}
            {useCartStore.getState().items.length} أصناف
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
                      ? "bg-surface text-ink-900 shadow-sm"
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
                  className="w-full h-14 text-right font-mono text-2xl font-bold text-ink-900 bg-surface border-2 border-ink-200 rounded-xl px-4 focus:border-accent outline-none transition-all"
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
                  onClick={() => setReceivedStr((amt / 100).toString())}
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
              <input
                type="text"
                inputMode="numeric"
                value={debtorPhone}
                onChange={(e) => setDebtorPhone(e.target.value)}
                className="w-full h-14 text-right font-mono text-lg bg-surface border-2 border-ink-200 rounded-xl px-4 focus:border-accent outline-none transition-all"
                placeholder="٠٧٧٠xxxxxxx"
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
                  className="w-full h-10 px-3 rounded-lg bg-surface border border-ink-200 text-ink-900 font-arabic text-sm outline-none focus:border-accent"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowNewDebtorForm(false); setNewDebtorName(""); }}
                    className="flex-1 h-9 rounded-lg bg-surface text-ink-500 text-sm font-arabic hover:bg-ink-200 transition-colors"
                  >
                    إلغاء
                  </button>
                  <button
                    onClick={async () => {
                      if (!newDebtorName.trim()) return;
                      try {
                        const db = await getDb();
                        const id = crypto.randomUUID();
                        const now = new Date().toISOString();
                        await db.insertInto("debtors").values({
                          id,
                          name: newDebtorName.trim(),
                          phone: debtorPhone.trim(),
                          email: null, address: null, notes: null,
                          total_debt_cents: 0, total_paid_cents: 0, balance_cents: 0,
                          is_active: 1, sync_version: 1, last_modified: now, sync_status: "pending",
                        }).execute();
                        setDebtorName(newDebtorName.trim());
                        setDebtorId(id);
                        setError(null);
                        setShowNewDebtorForm(false);
                        setNewDebtorName("");
                      } catch {
                        setError("حدث خطأ في إضافة المدين");
                      }
                    }}
                    disabled={!newDebtorName.trim()}
                    className="flex-1 h-9 rounded-lg bg-accent text-white text-sm font-bold hover:bg-accent-text transition-colors disabled:opacity-50"
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
            className="flex-1 h-14 rounded-xl bg-surface text-ink-900 font-arabic font-bold hover:bg-ink-200 transition-colors"
          >
            إلغاء
          </button>
          <button
            onClick={handleConfirm}
            disabled={!sufficient || processing}
            className="flex-1 h-14 rounded-xl bg-accent text-white font-arabic font-bold hover:bg-accent-text shadow-sh-3 active:scale-[0.98] transition-all disabled:opacity-50 disabled:shadow-none"
          >
            {processing ? "...جارٍ" : "تأكيد وطباعة"}
          </button>
        </div>
      </div>
    </div>
  );
}
