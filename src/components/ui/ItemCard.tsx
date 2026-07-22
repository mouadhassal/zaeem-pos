import CategoryGlyph from "./CategoryGlyph";
import Stepper from "./Stepper";

interface Props {
  name: string;
  priceCents: number;
  /** Shown struck-through above priceCents when set (happy-hour discount active). */
  originalPriceCents?: number;
  categoryName: string;
  photoUrl?: string | null | undefined;
  quantity: number;
  currencySymbol: string;
  onAdd: () => void;
  onRemove?: (() => void) | undefined;
  /** Small pill overlay, e.g. "🕐 -20%" for an active happy-hour rule. */
  badge?: string;
}

export default function ItemCard({
  name, priceCents, originalPriceCents, categoryName, photoUrl,
  quantity, currencySymbol, onAdd, onRemove, badge,
}: Props) {
  const formatted = (priceCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
  const formattedOriginal = originalPriceCents != null
    ? (originalPriceCents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : null;

  const inCart = quantity > 0;

  return (
    <div
      className="bg-white rounded-[12px] flex flex-col overflow-hidden transition-all active:scale-[0.98] relative"
      style={{
        minHeight: 0,
        boxShadow: inCart
          ? "0 0 0 2px #F04E23, 0 1px 3px rgba(16,24,40,.08)"
          : "0 1px 3px rgba(16,24,40,.08)",
      }}
    >
      {badge && (
        <span
          className="absolute top-1.5 start-1.5 z-10 text-[10px] font-semibold text-white rounded-full px-1.5 py-0.5"
          style={{ background: "#F04E23" }}
        >
          {badge}
        </span>
      )}
      {/* Photos-first: photo fills this area when present; the category
       * glyph on its wash gradient fills the EXACT same geometry when absent
       * (CategoryGlyph.tsx) -- zero layout shift either way. */}
      <CategoryGlyph categoryName={categoryName} photoUrl={photoUrl} />
      <div className="p-2 flex flex-col gap-1.5 flex-1">
        <span className="text-[13px] font-medium text-text leading-tight truncate">
          {name}
        </span>
        <div className="flex items-center justify-between mt-auto">
          <span className="tabular text-[13px] font-medium text-text flex items-baseline gap-1">
            {formattedOriginal && (
              <span dir="ltr" className="text-[11px] text-text-muted line-through">{formattedOriginal}</span>
            )}
            <span dir="ltr">{formatted}</span>
            <span className="text-xs text-text-muted">{currencySymbol}</span>
          </span>
          <Stepper quantity={quantity} onAdd={onAdd} onRemove={onRemove} />
        </div>
      </div>
    </div>
  );
}
