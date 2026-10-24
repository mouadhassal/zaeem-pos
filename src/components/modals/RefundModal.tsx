import { useMemo, useState } from "react";
import { IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import { formatMoney } from "../../lib/money";
import { realErrorText } from "../../lib/errors";
import { historyNumber, refundOrder, refundableLines, type HistoryDetail, type RefundOutcome } from "../../lib/orderHistory";
import { refundPreview } from "../../lib/refund";

interface Props {
  order: HistoryDetail;
  isManager: boolean;
  onClose: () => void;
  onDone: (outcome: RefundOutcome) => void;
}

// Where the money goes back, by how the order was paid.
const METHOD_NOTE: Record<string, string> = {
  CASH: "يُعاد نقداً من درج ورديتك، ويُخصم من النقد المتوقع عند إغلاقها.",
  CARD: "أعِد المبلغ على جهاز البطاقة.",
  WALLET: "أعِد المبلغ إلى محفظة الزبون.",
  CREDIT: "يُخصم من دين الزبون.",
};

/**
 * Refund a paid order: all of it, or chosen lines. The amount shown is the
 * main terminal's own formula (lib/refund.ts mirrors it); a reason is
 * always required and a cashier needs a manager PIN. Refunded food is not
 * put back in stock.
 */
export default function RefundModal({ order, isManager, onClose, onDone }: Props) {
  const lines = useMemo(() => refundableLines(order), [order]);
  const open = lines.filter((l) => !l.comped && l.quantity > l.refundedQuantity);
  const [mode, setMode] = useState<"ALL" | "ITEMS">("ALL");
  const [take, setTake] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = refundPreview(lines, mode === "ALL" ? "ALL" : take, order.total_cents, order.delivery_fee_cents, order.refunded_cents);
  const method = order.payments[0]?.method ?? "CASH";
  const nameOf = (id: string) => order.items.find((i) => i.id === id)?.name ?? "";
  const canConfirm = amount > 0 && reason.trim().length > 0 && (isManager || pin.length > 0) && !busy;

  const step = (id: string, delta: number, max: number) =>
    setTake((t) => ({ ...t, [id]: Math.min(max, Math.max(0, (t[id] ?? 0) + delta)) }));

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = mode === "ALL" ? null : Object.entries(take).filter(([, q]) => q > 0).map(([order_item_id, quantity]) => ({ order_item_id, quantity }));
      const outcome = await refundOrder(order.id, reason.trim(), chosen, isManager ? undefined : pin);
      onDone(outcome);
    } catch (e) {
      setError(realErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" data-testid="refund-modal">
      <div className="bg-white rounded-md shadow-sh-3 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col border border-line" dir="rtl">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-base font-bold font-arabic text-text">
            استرداد الطلب <span className="font-mono" dir="ltr">{historyNumber(order)}</span>
          </h2>
          <button onClick={onClose} aria-label="إغلاق" className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-text-muted"><IconX className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(["ALL", "ITEMS"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} data-testid={m === "ALL" ? "refund-mode-all" : "refund-mode-items"}
                className={`h-10 rounded-sm text-sm font-bold font-arabic border-2 transition-colors ${mode === m ? "border-accent bg-accent-soft text-text" : "border-line bg-white text-text-3 hover:bg-surface-alt"}`}>
                {m === "ALL" ? "الطلب كاملاً" : "أصناف محددة"}
              </button>
            ))}
          </div>

          {mode === "ITEMS" && (
            <div className="space-y-1.5">
              {open.length === 0 && <p className="text-sm text-text-muted font-arabic">لا توجد أصناف متبقية للاسترداد.</p>}
              {open.map((l) => {
                const left = l.quantity - l.refundedQuantity;
                const n = take[l.id] ?? 0;
                return (
                  <div key={l.id} className="flex items-center justify-between gap-3 rounded-sm border border-line p-2" data-testid="refund-line">
                    <div className="min-w-0">
                      <p className="text-sm font-arabic font-bold text-text truncate">{nameOf(l.id)}</p>
                      <p className="text-xs text-text-muted font-arabic">
                        متبقٍ {left} · <span className="font-mono" dir="ltr">{formatMoney(l.unitValueCents)}</span> للواحد
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => step(l.id, -1, left)} disabled={n === 0} aria-label="أقل" data-testid="refund-minus"
                        className="w-8 h-8 rounded-sm border border-line flex items-center justify-center disabled:opacity-40"><IconMinus className="w-4 h-4" /></button>
                      <span className="w-6 text-center font-mono font-bold" data-testid="refund-qty">{n}</span>
                      <button onClick={() => step(l.id, 1, left)} disabled={n >= left} aria-label="أكثر" data-testid="refund-plus"
                        className="w-8 h-8 rounded-sm border border-line flex items-center justify-center disabled:opacity-40"><IconPlus className="w-4 h-4" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="rounded-sm bg-surface-alt p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-arabic text-text-2">المبلغ المسترد</span>
              <span className="text-xl font-bold font-mono tabular text-danger" dir="ltr" data-testid="refund-amount">{formatMoney(amount)}</span>
            </div>
            <p className="mt-1 text-xs font-arabic text-text-3">{METHOD_NOTE[method] ?? METHOD_NOTE.CASH}</p>
            <p className="mt-0.5 text-xs font-arabic text-text-muted">الطعام المسترد لا يعود إلى المخزون.</p>
          </div>

          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سبب الاسترداد (مطلوب)" data-testid="refund-reason"
            className="w-full h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-sm font-arabic outline-none focus:border-accent" />
          {!isManager && (
            <input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="رمز المدير" type="password" inputMode="numeric" data-testid="refund-pin"
              className="w-full h-10 px-3 rounded-sm bg-white border-2 border-ink-200 text-sm font-mono outline-none focus:border-accent" dir="ltr" />
          )}
          {error && <div className="rounded-sm bg-danger-soft px-3 py-2 text-xs font-arabic text-danger" data-testid="refund-error">{error}</div>}
        </div>

        <div className="px-5 py-4 border-t border-line flex gap-2">
          <button onClick={onClose} className="flex-1 h-10 rounded-sm bg-white text-text-3 text-sm font-arabic border border-line hover:bg-surface-alt">رجوع</button>
          <button onClick={confirm} disabled={!canConfirm} data-testid="refund-confirm"
            className="flex-1 h-10 rounded-sm bg-danger text-white text-sm font-bold font-arabic disabled:opacity-50">
            {busy ? "جارٍ..." : "تأكيد الاسترداد"}
          </button>
        </div>
      </div>
    </div>
  );
}
