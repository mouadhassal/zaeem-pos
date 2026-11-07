import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { realErrorText } from "../../lib/errors";
import { useAuthStore } from "../../stores/authStore";
import { useCurrency } from "../../hooks/useCurrency";

interface Props {
  /** How many lines the order has and what they come to. */
  lineCount: number;
  totalCents: number;
  /** Ask for a reason (the owner can turn this off in the preferences). */
  askReason: boolean;
  /** The server already refused without a manager's PIN: show the field at once. */
  needsPin?: boolean;
  /** Shown above the form, for example the server's refusal. */
  error?: string | null;
  /** May throw: the message is shown and the dialog stays. */
  onConfirm: (reason: string, managerPin?: string) => Promise<void>;
  onCancel: () => void;
}

const REASONS = ["الزبون غادر", "خطأ في الطلب", "العميل غير راغب", "تأخير", "أخرى"];

/**
 * Cancels a whole order in one go. The reason question is optional (a setting);
 * a manager's PIN is asked only when the order's value is over the owner's void
 * threshold and the person cancelling is not a manager.
 */
export default function CancelOrderModal({ lineCount, totalCents, askReason, needsPin = false, error = null, onConfirm, onCancel }: Props) {
  const { fmt } = useCurrency();
  const role = useAuthStore((s) => s.user?.role);
  const [reason, setReason] = useState("");
  const [custom, setCustom] = useState("");
  const [pin, setPin] = useState("");
  const [threshold, setThreshold] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(error);
  const isManager = ["MANAGER", "OWNER", "PLATFORM", "ADMIN"].includes(String(role ?? "").toUpperCase());

  useEffect(() => {
    const token = useAuthStore.getState().token;
    invoke<{ void_threshold_cents: number }>("get_manager_thresholds_v3", { sessionToken: token })
      .then((r) => setThreshold(r.void_threshold_cents))
      .catch(() => setThreshold(0));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const pinShown = !isManager && (needsPin || (threshold !== null && totalCents >= threshold));
  const finalReason = reason === "أخرى" ? custom.trim() : reason;
  const canConfirm = !busy && (!askReason || !!finalReason) && (!pinShown || !!pin);

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setMessage(null);
    try {
      await onConfirm(finalReason || "إلغاء الطلب", pinShown ? pin : undefined);
    } catch (err) {
      setMessage(realErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" data-testid="cancel-order-modal">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[420px] overflow-hidden" dir="rtl">
        <div className="px-6 py-4 bg-danger-soft border-b border-danger-soft flex items-center justify-between">
          <div>
            <h2 className="font-arabic font-bold text-lg text-danger">إلغاء الطلب كاملاً</h2>
            <p className="font-arabic text-sm text-danger mt-1">{lineCount} صنف · {fmt(totalCents)}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="إغلاق" className="w-8 h-8 rounded-lg hover:bg-white/40 flex items-center justify-center text-danger shrink-0">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="font-arabic text-sm text-ink-700">يُلغى كل ما في الطلب دفعة واحدة، ويصل إلغاؤه إلى المطبخ. لا يمكن التراجع عن ذلك.</p>
          {message && <p className="font-arabic text-sm text-danger bg-danger-soft rounded-sm px-3 py-2" data-testid="cancel-order-error">{message}</p>}

          {askReason && (
            <div className="space-y-2">
              <label className="font-arabic text-sm text-ink-500 block">سبب الإلغاء *</label>
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    data-testid={`cancel-reason-${r}`}
                    className={`h-9 px-3 rounded-sm border-2 text-sm font-arabic ${reason === r ? "border-danger bg-danger-soft text-danger font-bold" : "border-ink-200 text-ink-700 hover:border-danger"}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {reason === "أخرى" && (
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="اكتب السبب..."
                  className="w-full h-11 rounded-sm border-2 border-ink-200 px-4 font-arabic text-sm outline-none focus:border-danger"
                />
              )}
            </div>
          )}

          {pinShown && (
            <div>
              <label className="font-arabic text-sm text-ink-500 mb-1.5 block">رمز المدير (الطلب بقيمة كبيرة)</label>
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }}
                data-testid="cancel-order-pin"
                className="w-full h-11 rounded-sm border-2 border-ink-200 px-4 font-mono text-sm outline-none focus:border-danger"
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button type="button" onClick={onCancel} className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">رجوع</button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!canConfirm}
            data-testid="cancel-order-confirm"
            className="flex-1 h-12 rounded-xl bg-danger-600 text-white font-arabic font-bold hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "جارٍ الإلغاء..." : "إلغاء الطلب كاملاً"}
          </button>
        </div>
      </div>
    </div>
  );
}
