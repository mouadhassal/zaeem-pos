import { useCartStore } from "../../stores/cartStore";
import { useOrderTypeStore } from "../../stores/orderTypeStore";
import ActionButton from "../ui/ActionButton";
import { Receipt, Printer, Clock, Split } from "lucide-react";
import { useCurrency } from "../../hooks/useCurrency";

interface Props {
  onSplit: () => void;
  onOrderType: () => void;
}

export default function RightPanel({ onSplit, onOrderType }: Props) {
  const { fmt } = useCurrency();
  const items = useCartStore((s) => s.items);
  const subtotal = useCartStore((s) => s.subtotal());
  const tax = useCartStore((s) => s.tax());
  const total = useCartStore((s) => s.total());
  const clearCart = useCartStore((s) => s.clearCart);
  const { orderType, customerName, customerPhone } = useOrderTypeStore();

  const handlePayment = () => {
    window.dispatchEvent(new CustomEvent("open-payment"));
  };

  const handleHold = () => {
    window.dispatchEvent(new CustomEvent("hold-order"));
  };

  const handleClear = () => {
    clearCart();
  };

  const taxCents = tax.taxCents + tax.secondaryTaxCents + tax.serviceChargeCents;

  return (
    <div className="w-[360px] bg-slate-50 border-r border-slate-200 flex flex-col shrink-0">
      <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200">
        <Receipt className="w-4 h-4 text-slate-400" />
        <span className="font-semibold text-slate-700 text-sm">الفاتورة</span>
      </div>

      {customerName && (
        <div className="px-4 py-2 bg-slate-100 border-b border-slate-200">
          <p className="text-xs text-slate-500">العميل</p>
          <p className="text-sm font-semibold text-slate-700">{customerName}</p>
          {customerPhone && <p className="text-xs text-slate-400">{customerPhone}</p>}
        </div>
      )}

      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
        <button
          onClick={onOrderType}
          className="flex-1 h-9 rounded-sm text-sm font-medium bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors"
        >
          {orderType === "DINE_IN" ? "داخلي" : orderType === "TAKEAWAY" ? "طلبات خارجية" : "توصيل"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {items.length === 0 ? (
          <div className="text-center py-8">
            <Receipt className="w-10 h-10 text-slate-200 mx-auto mb-2" />
            <p className="text-sm text-slate-400">لا توجد أصناف</p>
          </div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="bg-white border border-slate-200 rounded-sm p-3">
              <div className="flex justify-between items-start">
                <p className="text-sm font-medium text-slate-800">{item.name}</p>
                <span className="text-sm font-semibold text-slate-700">
                  {fmt(item.unitPriceCents * item.quantity)}
                </span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <p className="text-xs text-slate-400">سعر الوحدة: {fmt(item.unitPriceCents)}</p>
                <span className="text-xs text-slate-500">الكمية: {item.quantity}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-4 border-t border-slate-200 bg-white space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">المجموع</span>
          <span className="text-slate-700">{fmt(subtotal)}</span>
        </div>
        {taxCents > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">الضريبة</span>
            <span className="text-slate-700">{fmt(taxCents)}</span>
          </div>
        )}
        <div className="border-t border-slate-200 pt-2 flex justify-between">
          <span className="font-bold text-slate-800">الإجمالي</span>
          <span className="font-bold text-emerald-700">{fmt(total)}</span>
        </div>
        <div className="flex gap-2">
          <ActionButton onClick={handlePayment} className="flex-1 h-11" disabled={items.length === 0}>
            <Printer className="w-4 h-4" />
            دفع
          </ActionButton>
          <ActionButton variant="secondary" onClick={onSplit} className="h-11" disabled={items.length === 0}>
            <Split className="w-4 h-4" />
          </ActionButton>
        </div>
        <div className="flex gap-2">
          <ActionButton variant="secondary" onClick={handleHold} className="flex-1 h-10" disabled={items.length === 0}>
            <Clock className="w-4 h-4" />
            تعليق
          </ActionButton>
          <ActionButton variant="ghost" onClick={handleClear} className="h-10" disabled={items.length === 0}>
            مسح
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
