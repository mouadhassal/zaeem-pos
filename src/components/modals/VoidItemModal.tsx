import { useState } from "react";

interface Props {
  itemName: string;
  itemPriceCents: number;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export default function VoidItemModal({ itemName, itemPriceCents, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");

  const needsManager = itemPriceCents > 2000;

  const handleConfirm = () => {
    if (!reason.trim()) return;
    if (needsManager && !showPin) {
      setShowPin(true);
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-elevated w-[420px] overflow-hidden">
        <div className="px-6 py-4 bg-red-50 border-b border-red-100">
          <h2 className="font-arabic font-bold text-lg text-red-700">إلغاء الصنف</h2>
          <p className="font-arabic text-sm text-red-500 mt-1">{itemName}</p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="font-arabic text-sm text-slate-500 mb-1.5 block">سبب الإلغاء *</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full h-12 rounded-xl border-2 border-slate-200 px-4 font-arabic text-sm focus:border-red-400 outline-none"
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
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="اكتب سبب الإلغاء..."
              className="w-full h-12 rounded-xl border-2 border-slate-200 px-4 font-arabic text-sm outline-none focus:border-red-400"
            />
          )}

          {showPin && (
            <div>
              <label className="font-arabic text-sm text-slate-500 mb-1.5 block">
                كلمة مرور المدير (أكثر من ٢٠٠٠ د.ع)
              </label>
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="w-full h-12 rounded-xl border-2 border-slate-200 px-4 font-mono text-sm outline-none focus:border-red-400"
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl bg-white text-slate-900 font-arabic font-bold hover:bg-slate-200"
          >
            رجوع
          </button>
          <button
            onClick={handleConfirm}
            disabled={!reason.trim() || (needsManager && showPin && !pin)}
            className="flex-1 h-12 rounded-xl bg-red-600 text-white font-arabic font-bold hover:bg-red-700 disabled:opacity-50"
          >
            تأكيد الإلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
