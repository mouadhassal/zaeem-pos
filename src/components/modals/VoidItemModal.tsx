import { useState, useEffect } from "react";
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { useCurrency } from "../../hooks/useCurrency";
import { IconX } from "@tabler/icons-react";

interface Props {
  itemName: string;
  itemPriceCents: number;
  onConfirm: (reason: string, managerOverridePin?: string) => void;
  onCancel: () => void;
}

// 2026-08-02: this used to be a hardcoded `itemPriceCents > 2000` -- a
// number picked assuming small everyday prices, wrong by orders of
// magnitude for a currency whose real menu prices run in the thousands
// (which meant almost every void tripped the manager gate). Now reads the
// tenant's real, Owner-configurable threshold (chain_config, see
// pricing.rs's ManagerThresholds). Rust re-checks this server-side
// regardless of what this modal decides -- this is UI affordance only.
export default function VoidItemModal({ itemName, itemPriceCents, onConfirm, onCancel }: Props) {
  const { fmt } = useCurrency();
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [thresholdCents, setThresholdCents] = useState<number | null>(null);
  const [thresholdLoadFailed, setThresholdLoadFailed] = useState(false);

  useEffect(() => {
    const token = useAuthStore.getState().token;
    invoke<{ void_threshold_cents: number }>("get_manager_thresholds_v3", { sessionToken: token })
      .then((r) => setThresholdCents(r.void_threshold_cents))
      .catch(() => { setThresholdCents(20000); setThresholdLoadFailed(true); });
  }, []);

  // While the real threshold is still loading, default to requiring a
  // manager (fail-safe, not fail-open) -- a false "needs manager" prompt
  // that resolves itself in a moment is far better than a window where a
  // large void could look like it needs no approval at all.
  const needsManager = thresholdCents === null ? true : itemPriceCents >= thresholdCents;

  const handleConfirm = async () => {
    const finalReason = reason === "أخرى" ? customReason.trim() : reason.trim();
    if (!finalReason) return;
    if (needsManager && !showPin) {
      setShowPin(true);
      return;
    }
    if (needsManager) {
      setVerifying(true);
      setPinError(null);
      try {
        // Same as ManagerPinModal: verified in Rust against `staff`, never
        // the dropped `users` table, and the hash never reaches this renderer.
        // Scoped to the requesting actor's own tenant/branch and audited on
        // grant (verify_manager_override_v3).
        const token = useAuthStore.getState().token;
        await invoke<boolean>("verify_manager_override_v3", { sessionToken: token, passwordOrPin: pin });
      } catch (err) {
        const msg = typeof err === "string" ? err : (err as Error)?.message ?? "";
        if (msg.includes("ECONNREFUSED") || msg.includes("network") || msg.includes("fetch")) {
          setPinError("خطأ في الاتصال بالخادم");
        } else {
          setPinError("كلمة المرور غير صحيحة");
        }
        return;
      } finally {
        setVerifying(false);
      }
    }
    // The PIN is re-verified server-side inside void_order_item_v3 itself
    // (against the item's REAL price, not whatever this modal was given) --
    // the check above is only a fast, friendly pre-flight so a wrong PIN
    // doesn't surface as a generic failure after the fact.
    onConfirm(finalReason, needsManager ? pin : undefined);
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[420px] overflow-hidden">
        <div className="px-6 py-4 bg-danger-soft border-b border-danger-soft flex items-center justify-between">
          <div>
            <h2 className="font-arabic font-bold text-lg text-danger">إلغاء الصنف</h2>
            <p className="font-arabic text-sm text-danger mt-1">{itemName}</p>
          </div>
          <button onClick={onCancel} className="w-8 h-8 rounded-lg hover:bg-white/40 flex items-center justify-center text-danger shrink-0">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {thresholdLoadFailed && (
            <p className="font-arabic text-xs text-warn bg-warn/10 rounded-sm px-3 py-2">
              تعذر تحميل حد الموافقة -- سيتم طلب تصريح المدير احتياطياً
            </p>
          )}
          <div>
            <label className="font-arabic text-sm text-ink-500 mb-1.5 block">سبب الإلغاء *</label>
            <select
              value={reason === "أخرى" ? "أخرى" : reason}
              onChange={(e) => {
                if (e.target.value === "أخرى") {
                  setReason("أخرى");
                } else {
                  setReason(e.target.value);
                }
              }}
              className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-arabic text-sm focus:border-danger outline-none"
            >
              <option value="">اختر سبباً</option>
              <option value="خطأ في الطلب">خطأ في الطلب</option>
              <option value="العميل غير راغب">العميل غير راغب</option>
              <option value="خطأ في التحضير">خطأ في التحضير</option>
              <option value="تأخير">تأخير</option>
              <option value="أخرى">أخرى</option>
            </select>
          </div>

          {reason === "أخرى" && (
            <input
              type="text"
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder="اكتب سبب الإلغاء..."
              className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-arabic text-sm outline-none focus:border-danger"
            />
          )}

          {showPin && (
            <div>
              <label className="font-arabic text-sm text-ink-500 mb-1.5 block">
                كلمة مرور المدير {thresholdCents !== null && `(أكثر من ${fmt(thresholdCents)})`}
              </label>
              <input
                type="password"
                value={pin}
                onChange={(e) => { setPin(e.target.value); setPinError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(); }}
                className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-mono text-sm outline-none focus:border-danger"
                autoFocus
              />
              {pinError && (
                <p className="text-danger text-sm mt-1.5 font-arabic">{pinError}</p>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200"
          >
            رجوع
          </button>
          <button
            onClick={handleConfirm}
            disabled={(!reason.trim() || (reason === "أخرى" && !customReason.trim())) || verifying || (needsManager && showPin && !pin)}
            className="flex-1 h-12 rounded-xl bg-danger-soft text-danger font-arabic font-bold hover:bg-danger-soft disabled:opacity-50"
          >
            {verifying ? "جاري التحقق..." : "تأكيد الإلغاء"}
          </button>
        </div>
      </div>
    </div>
  );
}
