import { useState } from "react";
import { useCartStore } from "../../stores/cartStore";
import type { SplitItem } from "../../stores/cartStore";

interface Props {
  onClose: () => void;
  onConfirm: (splits: SplitItem[]) => void;
}

export default function SplitBillModal({ onClose, onConfirm }: Props) {
  const items = useCartStore((s) => s.items);
  const [splits, setSplits] = useState<SplitItem[]>([
    { id: "split-1", label: "الفاتورة ١", itemIds: [], amountCents: 0 },
    { id: "split-2", label: "الفاتورة ٢", itemIds: [], amountCents: 0 },
  ]);

  const totalCents = useCartStore((s) => s.total());

  const allAssigned = splits.every((s) => s.itemIds.length > 0 || s.amountCents > 0);

  const assignedTotal = splits.reduce((sum, s) => sum + s.amountCents, 0);
  const remainder = totalCents - assignedTotal;

  const toggleItem = (splitId: string, itemId: string, itemTotal: number) => {
    setSplits((prev) =>
      prev.map((s) => {
        if (s.id !== splitId) return s;
        const exists = s.itemIds.includes(itemId);
        const newIds = exists
          ? s.itemIds.filter((i) => i !== itemId)
          : [...s.itemIds, itemId];
        const newAmount = exists
          ? s.amountCents - itemTotal
          : s.amountCents + itemTotal;
        return { ...s, itemIds: newIds, amountCents: newAmount };
      })
    );
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-elevated w-[600px] max-h-[80vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-lg text-slate-900">تقسيم الفاتورة</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-white flex items-center justify-center">
            <svg className="w-5 h-5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex gap-3">
            {splits.map((split, _idx) => (
              <div key={split.id} className="flex-1 bg-white rounded-xl p-4">
                <label className="font-arabic text-sm text-slate-500 mb-2 block">
                  {split.label}
                </label>
                <input
                  type="text"
                  value={split.label}
                  onChange={(e) =>
                    setSplits((prev) =>
                      prev.map((s) => (s.id === split.id ? { ...s, label: e.target.value } : s))
                    )
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 font-arabic text-sm mb-2"
                />
                <div className="font-mono font-bold text-lg text-emerald-600">
                  {new Intl.NumberFormat("ar-SA", {
                    style: "currency", currency: "SAR",
                  }).format(split.amountCents / 100)}
                </div>
              </div>
            ))}
            <button
              onClick={() =>
                setSplits((prev) => [
                  ...prev,
                  { id: `split-${prev.length + 1}`, label: `الفاتورة ${prev.length + 1}`, itemIds: [], amountCents: 0 },
                ])
              }
              className="w-12 h-full rounded-xl border-2 border-dashed border-slate-300 text-slate-500 hover:border-emerald-500 hover:text-emerald-500 flex items-center justify-center"
            >
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>

          <div className="bg-amber-50 rounded-xl p-3 flex justify-between items-center">
            <span className="font-arabic text-sm text-amber-800">المتبقي للتوزيع</span>
            <span className={`font-mono font-bold ${remainder === 0 ? "text-emerald-600" : "text-amber-600"}`}>
              {new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(remainder / 100)}
            </span>
          </div>

          <div className="space-y-2">
              {items.filter((i) => !i.voided).map((item) => {
              const itemTotal = (item.unitPriceCents + item.modifiers.reduce((m, m2) => m + m2.priceCents, 0)) * item.quantity;
              return (
                <div key={item.id} className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl p-3">
                  <span className="font-arabic flex-1 text-sm">{item.quantity}× {item.name}</span>
                  <span className="font-mono text-sm text-slate-500 ml-2">
                    {new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(itemTotal / 100)}
                  </span>
                  {splits.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => toggleItem(s.id, item.id, itemTotal)}
                      className={`px-2 py-1 rounded-lg text-xs font-arabic transition-colors ${
                        s.itemIds.includes(item.id)
                          ? "bg-emerald-600 text-white"
                          : "bg-white text-slate-400 hover:bg-slate-200"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 h-12 rounded-xl bg-white text-slate-900 font-arabic font-bold hover:bg-slate-200"
          >
            إلغاء
          </button>
          <button
            onClick={() => onConfirm(splits)}
            disabled={!allAssigned || remainder !== 0}
            className="flex-1 h-12 rounded-xl bg-emerald-600 text-white font-arabic font-bold hover:bg-emerald-700 disabled:opacity-50"
          >
            تأكيد التقسيم
          </button>
        </div>
      </div>
    </div>
  );
}
