import type { OrderType } from "../../stores/orderTypeStore";

interface Props {
  onSelect: (type: OrderType) => void;
  onClose: () => void;
}

const TYPES: { id: OrderType; label: string; description: string }[] = [
  { id: "DINE_IN", label: "داخلي", description: "طلب على طاولة" },
  { id: "TAKEAWAY", label: "سفري", description: "طلب من العميل ومغادرة" },
  { id: "DELIVERY", label: "توصيل", description: "توصيل إلى العنوان" },
  { id: "ONLINE", label: "أونلاين", description: "طلب من منصة خارجية" },
];

export default function OrderTypeSelector({ onSelect, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-elevated w-[400px] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="font-arabic font-bold text-lg text-slate-900">نوع الطلب</h2>
        </div>
        <div className="p-4 space-y-2">
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="w-full p-4 rounded-xl border-2 border-slate-200 hover:border-emerald-200 hover:bg-emerald-50 text-right transition-all group"
            >
              <div className="font-arabic font-bold text-slate-900 group-hover:text-emerald-700">
                {t.label}
              </div>
              <div className="font-arabic text-sm text-slate-500 mt-0.5">
                {t.description}
              </div>
            </button>
          ))}
        </div>
        <div className="px-6 py-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-white text-slate-900 font-arabic font-bold hover:bg-slate-200"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
