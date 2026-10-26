import CategoryGlyph from "./CategoryGlyph";
import Stepper from "./Stepper";
import { formatAmount } from "../../lib/money";
import type { CardDensity } from "../../lib/menuGridLayout";

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
  /** The item has option groups (without onion, extra cheese...): tapping opens the picker, and the card says so. */
  hasOptions?: boolean;
  /** Smaller cards when the owner picks many products per row (lib/menuGridLayout.ts). */
  density?: CardDensity;
  glyphHeightPx?: number;
  iconSizePx?: number;
}

const DENSITY = {
  regular: { body: "p-2 gap-1.5", name: "text-[13px]", price: "text-[13px]", old: "text-[11px]", cur: "text-xs", pill: "text-[10px]", stepper: "md" },
  compact: { body: "p-1.5 gap-1", name: "text-[12px]", price: "text-[12px]", old: "text-[10px]", cur: "text-[10px]", pill: "text-[9px]", stepper: "sm" },
  // Mini draws its stepper on the picture (below), not in the price row.
  mini: { body: "p-1.5 gap-0.5", name: "text-[11px]", price: "text-[11px]", old: "text-[9px]", cur: "text-[9px]", pill: "text-[9px]", stepper: "xs" },
} as const;

export default function ItemCard({
  name, priceCents, originalPriceCents, categoryName, photoUrl,
  quantity, currencySymbol, onAdd, onRemove, badge, hasOptions,
  density = "regular", glyphHeightPx, iconSizePx,
}: Props) {
  const d = DENSITY[density];
  // Currency-scale-aware -- was raw cents.toLocaleString(), which silently
  // assumed scale 0 (see lib/money.ts's formatAmount doc comment).
  const formatted = formatAmount(priceCents);
  const formattedOriginal = originalPriceCents != null ? formatAmount(originalPriceCents) : null;

  const inCart = quantity > 0;

  return (
    // The whole card is the tap target (it used to be only the small "+"):
    // a cashier taps the picture or the name, not a 34px corner button.
    <div
      role="button"
      tabIndex={0}
      onClick={onAdd}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAdd(); } }}
      data-testid="item-card"
      className={`bg-white rounded-lg flex flex-col overflow-hidden cursor-pointer select-none transition-[border-color,transform] active:scale-[0.98] relative border ${inCart ? 'border-danger' : 'border-ink-200 hover:border-saffron-400'}`}
    >
      {badge && (
        <span
          className={`absolute top-1.5 start-1.5 z-10 ${d.pill} font-semibold text-white rounded-full px-1.5 py-0.5 bg-danger`}
        >
          {badge}
        </span>
      )}
      {/* Photos-first: photo fills this area when present; the category
       * glyph on its wash gradient fills the EXACT same geometry when absent
       * (CategoryGlyph.tsx) -- zero layout shift either way. */}
      <div className="relative">
        <CategoryGlyph
          categoryName={categoryName}
          photoUrl={photoUrl}
          {...(glyphHeightPx != null ? { heightPx: glyphHeightPx } : {})}
          {...(iconSizePx != null ? { iconSizePx } : {})}
        />
        {density === "mini" && inCart && (
          <div className="absolute bottom-1 end-1 rounded-[8px] bg-white/90 p-0.5">
            <Stepper quantity={quantity} onAdd={onAdd} onRemove={onRemove} size={d.stepper} />
          </div>
        )}
      </div>
      {hasOptions && (
        <span
          className={`absolute top-1.5 end-1.5 z-10 ${d.pill} font-semibold rounded-full ${density === "regular" ? "px-2" : "px-1.5"} py-0.5 bg-accent-soft text-accent-text`}
          data-testid="item-card-options"
        >
          + إضافات
        </span>
      )}
      <div className={`${d.body} flex flex-col flex-1`}>
        <span className={`${d.name} font-medium text-text leading-tight truncate`}>
          {name}
        </span>
        <div className="flex items-center justify-between gap-1 mt-auto min-h-[24px]">
          <span className={`tabular ${d.price} font-medium text-text flex items-baseline gap-1 min-w-0`}>
            {formattedOriginal && (
              <span dir="ltr" className={`${d.old} text-text-muted line-through`}>{formattedOriginal}</span>
            )}
            <span dir="ltr">{formatted}</span>
            <span className={`${d.cur} text-text-muted`}>{currencySymbol}</span>
          </span>
          {density !== "mini" && <Stepper quantity={quantity} onAdd={onAdd} onRemove={onRemove} size={d.stepper} />}
        </div>
      </div>
    </div>
  );
}
