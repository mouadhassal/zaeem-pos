import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../../stores/authStore";

interface Props {
  itemName: string;
  itemPriceCents: number;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export default function VoidItemModal({ itemName, itemPriceCents, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const needsManager = itemPriceCents > 2000;

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
    onConfirm(finalReason);
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl border border-ink-600 w-[420px] overflow-hidden">
        <div className="px-6 py-4 bg-danger-soft border-b border-danger-soft">
          <h2 className="font-arabic font-bold text-lg text-danger">إلغاء الصنف</h2>
          <p className="font-arabic text-sm text-danger mt-1">{itemName}</p>
        </div>

        <div className="p-6 space-y-4">
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
              className="w-full h-12 rounded-xl border-2 border-ink-200 px-4 font-arabic text-sm focus:border-danger outline-none"
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
              className="w-full h-12 rounded-xl border-2 border-ink-200 px-4 font-arabic text-sm outline-none focus:border-danger"
            />
          )}

          {showPin && (
            <div>
              <label className="font-arabic text-sm text-ink-500 mb-1.5 block">
                كلمة مرور المدير (أكثر من ٢٠٠٠ د.ع)
              </label>
              <input
                type="password"
                value={pin}
                onChange={(e) => { setPin(e.target.value); setPinError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(); }}
                className="w-full h-12 rounded-xl border-2 border-ink-200 px-4 font-mono text-sm outline-none focus:border-danger"
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
            className="flex-1 h-12 rounded-xl bg-surface text-ink-900 font-arabic font-bold hover:bg-ink-200"
          >
            رجوع
          </button>
          <button
            onClick={handleConfirm}
            disabled={(!reason.trim() || (reason === "أخرى" && !customReason.trim())) || verifying || (needsManager && showPin && !pin)}
            className="flex-1 h-12 rounded-xl bg-danger text-white font-arabic font-bold hover:bg-danger disabled:opacity-50"
          >
            {verifying ? "جاري التحقق..." : "تأكيد الإلغاء"}
          </button>
        </div>
      </div>
    </div>
  );
}
