interface CartItem {
  id: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifiers?: { name: string; priceCents: number }[];
}

interface Props {
  items: CartItem[];
  onQuantityChange: (id: string, delta: number) => void;
  onRemove: (id: string) => void;
  onCheckout: () => void;
  onHold: () => void;
}

export default function CartPanel({
  items,
  onQuantityChange,
  onRemove,
  onCheckout,
  onHold,
}: Props) {
  const subtotal = items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0
  );
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;

  if (items.length === 0) {
    return (
      <div className="w-[380px] bg-cart border-r border-ink-200 flex flex-col" dir="rtl">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-ink-900">السلة</h2>
          <span className="text-xs font-mono text-ink-500 bg-white px-2 py-1 rounded-full">
            ٠
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <div className="w-20 h-20 rounded-full bg-white flex items-center justify-center">
            <svg className="w-8 h-8 text-ink-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="9" cy="21" r="1" />
              <circle cx="20" cy="21" r="1" />
              <path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" />
            </svg>
          </div>
          <p className="font-arabic text-ink-500 text-center text-sm">
            اختر طاولة وأضف أصنافاً
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-[380px] bg-cart border-r border-ink-200 flex flex-col" dir="rtl">
      <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
        <h2 className="font-arabic font-bold text-ink-900">السلة</h2>
        <span className="text-xs font-mono text-ink-400 bg-ink-200 px-2 py-1 rounded-full">
          {items.reduce((s, i) => s + i.quantity, 0)}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-3 space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3 mx-4 p-4 bg-white rounded-xl shadow-sh-1"
          >
            <div className="w-12 h-12 rounded-lg bg-white flex-shrink-0 flex items-center justify-center">
              <span className="text-lg">🍽</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between">
                <p className="font-arabic font-medium text-ink-900 text-sm truncate">
                  {item.name}
                </p>
                <button
                  onClick={() => onRemove(item.id)}
                  className="text-ink-900 hover:text-stop transition-colors flex-shrink-0"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {item.modifiers?.map((m, i) => (
                <p key={i} className="text-xs text-ink-500 font-arabic">
                  + {m.name}
                </p>
              ))}
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => onQuantityChange(item.id, -1)}
                    className="w-7 h-7 rounded-lg bg-white text-ink-500 flex items-center justify-center hover:bg-ink-200 transition-colors"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M5 12h14" />
                    </svg>
                  </button>
                  <span className="font-mono font-semibold text-ink-900 w-5 text-center text-sm">
                    {item.quantity}
                  </span>
                  <button
                    onClick={() => onQuantityChange(item.id, 1)}
                    className="w-7 h-7 rounded-lg bg-saffron-50 text-saffron-600 flex items-center justify-center hover:bg-saffron-100 transition-colors"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
                <span className="font-mono text-saffron-600 text-sm font-semibold">
                  {new Intl.NumberFormat("ar-SA", {
                    style: "currency",
                    currency: "SAR",
                  }).format((item.unitPriceCents * item.quantity) / 100)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="p-6 bg-white border-t border-ink-200 mt-auto space-y-3">
        <div className="flex justify-between items-center">
          <span className="font-arabic text-ink-400 text-sm">المجموع الفرعي</span>
          <span className="font-mono text-ink-900 text-sm font-medium">
            {new Intl.NumberFormat("ar-SA", {
              style: "currency",
              currency: "SAR",
            }).format(subtotal / 100)}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="font-arabic text-ink-400 text-sm">الضريبة ٥٪</span>
          <span className="font-mono text-ink-500 text-sm">
            {new Intl.NumberFormat("ar-SA", {
              style: "currency",
              currency: "SAR",
            }).format(tax / 100)}
          </span>
        </div>
        <div className="flex justify-between items-center pt-4 border-t border-ink-200">
          <span className="font-arabic font-bold text-ink-900">الإجمالي</span>
          <span className="font-mono font-bold text-xl text-saffron-600">
            {new Intl.NumberFormat("ar-SA", {
              style: "currency",
              currency: "SAR",
            }).format(total / 100)}
          </span>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={onHold}
            className="flex-1 h-14 rounded-xl border-2 border-ink-200 text-ink-500 font-arabic font-bold hover:bg-white transition-colors text-sm"
          >
            تعليق
          </button>
          <button
            onClick={onCheckout}
            className="flex-1 h-14 rounded-xl bg-saffron-600 hover:bg-saffron-700 text-white font-arabic font-bold shadow-sh-3 shadow-saffron-600\/20 transition-all active:scale-[0.98] text-sm"
          >
            دفع
          </button>
        </div>
      </div>
    </div>
  );
}
