import { useCartStore } from "../../stores/cartStore";
import EmptyState from "../ui/EmptyState";
import { Trash2, Plus, Minus, Hash } from "lucide-react";
import { useCurrency } from "../../hooks/useCurrency";

interface Props {
  onVoidItem: (itemId: string, name: string, price: number) => void;
  onTransfer: () => void;
}

export default function LeftPanel({ onVoidItem }: Props) {
  const { fmt } = useCurrency();
  const items = useCartStore((s) => s.items);
  const updateQty = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);

  if (items.length === 0) {
    return (
      <div className="w-[320px] bg-slate-50 border-l border-slate-200 flex flex-col shrink-0">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
          <Hash className="w-4 h-4 text-slate-400" />
          <span className="font-semibold text-slate-700 text-sm">الطلبية</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            title="الطلبية فارغة"
            description="اختر المنتجات من القائمة"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="w-[320px] bg-slate-50 border-l border-slate-200 flex flex-col shrink-0">
      <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
        <Hash className="w-4 h-4 text-slate-400" />
        <span className="font-semibold text-slate-700 text-sm">الطلبية</span>
        <span className="mr-auto text-xs text-slate-400">{items.length} أصناف</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="bg-white border border-slate-200 rounded-sm p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
                <p className="text-xs text-slate-400">{fmt(item.unitPriceCents)}</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onVoidItem(item.id, item.name, item.unitPriceCents)}
                  className="p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                  title="إلغاء"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => removeItem(item.id)}
                  className="p-1 rounded text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors shrink-0"
                  title="حذف"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-emerald-700">
                {fmt(item.unitPriceCents * item.quantity)}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => updateQty(item.id, -1)}
                  className="w-7 h-7 flex items-center justify-center rounded bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                  disabled={item.quantity <= 1}
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="w-8 text-center text-sm font-medium text-slate-700">{item.quantity}</span>
                <button
                  onClick={() => updateQty(item.id, 1)}
                  className="w-7 h-7 flex items-center justify-center rounded bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
            {item.notes && (
              <p className="text-xs text-slate-400 bg-slate-50 rounded px-2 py-1">{item.notes}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
