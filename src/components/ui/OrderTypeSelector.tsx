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
      <div className="bg-surface rounded-2xl border border-ink-600 w-[400px] overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-200">
          <h2 className="font-arabic font-bold text-lg text-ink-900">نوع الطلب</h2>
        </div>
        <div className="p-4 space-y-2">
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="w-full p-4 rounded-xl border-2 border-ink-200 hover:border-accent hover:bg-accent-soft text-right transition-all group"
            >
              <div className="font-arabic font-bold text-ink-900 group-hover:text-accent-text">
                {t.label}
              </div>
              <div className="font-arabic text-sm text-ink-500 mt-0.5">
                {t.description}
              </div>
            </button>
          ))}
        </div>
        <div className="px-6 py-4 border-t border-ink-200">
          <button
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-surface text-ink-900 font-arabic font-bold hover:bg-ink-200"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
