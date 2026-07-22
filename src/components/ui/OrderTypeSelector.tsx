import { IconToolsKitchen2, IconShoppingBag, IconTruckDelivery, IconWorld, IconWallet } from "@tabler/icons-react";
import type { OrderType } from "../../stores/orderTypeStore";

interface Props {
  onSelect: (type: OrderType) => void;
  onClose: () => void;
}

const TYPES: { id: OrderType; label: string; description: string; icon: typeof IconToolsKitchen2; color: string }[] = [
  { id: "DINE_IN", label: "صالة", description: "طلب على طاولة", icon: IconToolsKitchen2, color: "bg-emerald-50 border-emerald-200 hover:border-emerald-400 text-emerald-700" },
  { id: "TAKEAWAY", label: "سفري", description: "طلب من العميل ومغادرة", icon: IconShoppingBag, color: "bg-blue-50 border-blue-200 hover:border-blue-400 text-blue-700" },
  { id: "DELIVERY", label: "توصيل", description: "توصيل إلى العنوان", icon: IconTruckDelivery, color: "bg-amber-50 border-amber-200 hover:border-amber-400 text-amber-700" },
  { id: "ONLINE", label: "أونلاين", description: "طلب من منصة خارجية", icon: IconWorld, color: "bg-purple-50 border-purple-200 hover:border-purple-400 text-purple-700" },
  { id: "DEBT", label: "دين", description: "طلب بالدين (مدين معروف)", icon: IconWallet, color: "bg-red-50 border-red-200 hover:border-red-400 text-red-700" },
];

export default function OrderTypeSelector({ onSelect, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface rounded-2xl border border-line w-[480px] overflow-hidden shadow-sh-3">
        <div className="px-6 py-4 border-b border-line">
          <h2 className="font-arabic font-bold text-lg text-text">نوع الطلب</h2>
          <p className="font-arabic text-sm text-text-muted mt-0.5">اختر نوع الطلبية</p>
        </div>
        <div className="p-4 grid grid-cols-2 gap-3">
          {TYPES.map((t) => {
            const IconComp = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                className={`p-4 rounded-xl border-2 text-right transition-all group ${t.color}`}
              >
                <div className="flex items-center gap-3">
                  <IconComp className="w-6 h-6 shrink-0" stroke={1.75} />
                  <div>
                    <div className="font-arabic font-bold text-sm">{t.label}</div>
                    <div className="font-arabic text-xs opacity-70 mt-0.5">{t.description}</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="px-6 py-4 border-t border-line">
          <button
            onClick={onClose}
            className="w-full h-11 rounded-xl bg-surface-alt text-text-3 font-arabic font-bold hover:bg-line transition-colors"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
