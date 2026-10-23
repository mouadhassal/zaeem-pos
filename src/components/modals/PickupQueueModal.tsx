import { useEffect, useState } from "react";
import { IconX, IconPhone, IconToolsKitchen2 } from "@tabler/icons-react";
import { formatAmount } from "../../lib/money";
import { formatArabicTime } from "../../lib/dateLocal";
import { orderNo } from "../../lib/orderNumber";
import { realErrorText } from "../../lib/errors";
import { pickupCountdown, pickupKitchenLabel } from "../../lib/pickup";
import type { PickupOrder } from "../../lib/orderService";

interface Props {
  orders: PickupOrder[];
  /** True when the signed-in user is a manager or owner: no PIN asked for a no-show. */
  isManager: boolean;
  onClose: () => void;
  /** Loads the order into the cart and opens payment. */
  onCollect: (order: PickupOrder) => void;
  onSendNow: (orderId: string) => Promise<void>;
  onNoShow: (orderId: string, reason: string, managerPin?: string) => Promise<void>;
}

/**
 * Phone orders waiting for their customer: when each is due, where it is in
 * the kitchen, and the three things a cashier does with one -- the customer
 * is here (collect and pay), they came early (send to the kitchen now), or
 * they never came (cancel, with a reason and a manager).
 */
export default function PickupQueueModal({ orders, isManager, onClose, onCollect, onSendNow, onNoShow }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [noShowFor, setNoShowFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmNoShow = (orderId: string) =>
    run(async () => {
      await onNoShow(orderId, reason.trim(), isManager ? undefined : pin);
      setNoShowFor(null);
      setReason("");
      setPin("");
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" data-testid="pickup-queue">
      <div className="bg-white rounded-md shadow-sh-3 w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col border border-line" dir="rtl">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-base font-bold font-arabic text-text">طلبات الاستلام ({orders.length})</h2>
          <button onClick={onClose} aria-label="إغلاق" className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-text-muted"><IconX className="w-4 h-4" /></button>
        </div>

        {error && <div className="mx-5 mt-3 rounded-sm bg-danger-soft px-3 py-2 text-xs font-arabic text-danger">{error}</div>}

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {orders.length === 0 ? (
            <div className="text-center py-10 text-text-muted font-arabic text-sm">
              لا توجد طلبات بانتظار الاستلام.
              <br />
              <span className="text-xs">لطلب هاتفي: اختر «سفري» ثم وقت الاستلام.</span>
            </div>
          ) : (
            orders.map((o) => {
              const due = pickupCountdown(now, o.pickup_at_ms);
              const kitchen = pickupKitchenLabel(o);
              return (
                <div key={o.order_id} className={`rounded-xl border p-3 ${due.late ? "border-danger" : "border-line"}`} data-testid="pickup-row">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-arabic font-bold text-sm text-text">
                        {o.customer_name} <span className="font-mono text-xs text-text-muted">#{orderNo(o.order_id)}</span>
                      </p>
                      {o.customer_phone && (
                        <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-text-muted" dir="ltr">
                          <IconPhone className="w-3 h-3" /> {o.customer_phone}
                        </p>
                      )}
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-arabic">
                        <span className="text-text-2">استلام {formatArabicTime(new Date(o.pickup_at_ms))}</span>
                        <span className={`rounded-full px-2 py-0.5 font-bold ${due.late ? "bg-danger-soft text-danger" : "bg-surface-alt text-text-3"}`}>{due.label}</span>
                        <span className={`rounded-full px-2 py-0.5 font-bold ${kitchen.ready ? "bg-ok-soft text-ok" : "bg-surface-alt text-text-3"}`} data-testid="pickup-kitchen">{kitchen.label}</span>
                      </p>
                    </div>
                    <p className="font-mono font-bold text-sm text-text">{formatAmount(o.total_cents)}</p>
                  </div>

                  {noShowFor === o.order_id ? (
                    <div className="mt-3 space-y-2 rounded-sm bg-surface-alt p-2">
                      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (مثلاً: لم يرد على الهاتف)" autoFocus
                        className="w-full h-9 px-3 rounded-sm bg-white border-2 border-ink-200 text-sm font-arabic outline-none focus:border-accent" />
                      {!isManager && (
                        <input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="رمز المدير" type="password" inputMode="numeric"
                          className="w-full h-9 px-3 rounded-sm bg-white border-2 border-ink-200 text-sm font-mono outline-none focus:border-accent" dir="ltr" />
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => { setNoShowFor(null); setReason(""); setPin(""); }}
                          className="flex-1 h-9 rounded-sm bg-white text-text-3 text-sm font-arabic border border-line hover:bg-line transition-colors">رجوع</button>
                        <button onClick={() => confirmNoShow(o.order_id)} disabled={busy || !reason.trim() || (!isManager && !pin)}
                          className="flex-1 h-9 rounded-sm bg-danger text-white text-sm font-bold font-arabic disabled:opacity-50">إلغاء الطلب</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button onClick={() => onCollect(o)} disabled={busy} data-testid="pickup-collect"
                        className="h-9 px-4 rounded-sm bg-accent text-white text-sm font-bold font-arabic disabled:opacity-50">استلام ودفع</button>
                      {!o.kitchen_sent && (
                        <button onClick={() => run(() => onSendNow(o.order_id))} disabled={busy}
                          className="h-9 px-3 rounded-sm border border-line bg-white text-text-2 text-sm font-arabic flex items-center gap-1 hover:bg-surface-alt disabled:opacity-50">
                          <IconToolsKitchen2 className="w-4 h-4" /> للمطبخ الآن
                        </button>
                      )}
                      <button onClick={() => { setNoShowFor(o.order_id); setError(null); }} disabled={busy}
                        className="h-9 px-3 rounded-sm text-danger text-sm font-arabic hover:bg-danger-soft disabled:opacity-50">لم يحضر</button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
