import { useMenuGridStore } from "../../stores/menuGridStore";
import { PRODUCTS_PER_ROW_AUTO, PRODUCTS_PER_ROW_CHOICES } from "../../lib/menuGridLayout";

const OPTIONS: { value: number; label: string }[] = [
  { value: PRODUCTS_PER_ROW_AUTO, label: "تلقائي" },
  ...PRODUCTS_PER_ROW_CHOICES.map((n) => ({ value: n, label: String(n) })),
];

/** Settings > عام: how many item cards the POS screen shows per row on this device. */
export default function ProductsPerRowSetting() {
  const productsPerRow = useMenuGridStore((s) => s.productsPerRow);
  const setProductsPerRow = useMenuGridStore((s) => s.setProductsPerRow);

  return (
    <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
      <div>
        <span className="text-sm font-arabic text-ink-900 block">عدد الأصناف في كل صف</span>
        <span className="text-xs font-arabic text-ink-400">
          كلما زاد العدد صغرت بطاقات الأصناف في شاشة البيع، فيظهر عدد أكبر منها دون تمرير
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="عدد الأصناف في كل صف">
        {OPTIONS.map((o) => {
          const active = productsPerRow === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setProductsPerRow(o.value)}
              data-testid={`products-per-row-${o.value}`}
              className={`h-10 rounded-sm border-2 text-sm font-arabic transition-colors ${
                o.value === PRODUCTS_PER_ROW_AUTO ? "px-4" : "w-11"
              } ${
                active
                  ? "border-saffron-600 bg-saffron-50 text-saffron-600 font-bold"
                  : "border-ink-200 text-ink-700 hover:border-saffron-400"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      {/* A sketch of one row at the chosen count, so the owner sees the
          effect before going back to the till. */}
      <div className="rounded-sm bg-ink-50 border border-ink-200 p-2" aria-hidden="true">
        {productsPerRow === PRODUCTS_PER_ROW_AUTO ? (
          <p className="text-xs font-arabic text-ink-500 text-center py-2">حسب عرض الشاشة (البطاقات بحجمها الكامل)</p>
        ) : (
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${productsPerRow}, minmax(0, 1fr))` }}>
            {Array.from({ length: productsPerRow }, (_, i) => (
              <div key={i} className="rounded-[4px] bg-white border border-ink-200 overflow-hidden">
                <div className="h-6 bg-saffron-50" />
                <div className="h-1.5 m-1 rounded-full bg-ink-200" />
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-ink-500 font-arabic">
        يُحفظ لهذا الجهاز فقط. إذا كانت الشاشة أضيق من العدد المختار تظهر أصناف أقل حتى تبقى البطاقات مقروءة.
      </p>
    </div>
  );
}
