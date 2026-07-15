import CategoryGlyph from "./CategoryGlyph";
import Stepper from "./Stepper";

interface Props {
  name: string;
  priceCents: number;
  categoryName: string;
  photoUrl?: string | null | undefined;
  quantity: number;
  currencySymbol: string;
  onAdd: () => void;
  onRemove?: (() => void) | undefined;
}

export default function ItemCard({
  name, priceCents, categoryName, photoUrl,
  quantity, currencySymbol, onAdd, onRemove,
}: Props) {
  const formatted = (priceCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });

  return (
    <div
      className="bg-surface rounded-[13px] flex flex-col overflow-hidden shadow-sh-2 transition-all active:scale-[0.98]"
      style={{ minHeight: 0 }}
    >
      <CategoryGlyph categoryName={categoryName} photoUrl={photoUrl} />
      <div className="p-2.5 flex flex-col gap-2 flex-1">
        <span className="text-[13px] font-medium text-text leading-tight line-clamp-2">
          {name}
        </span>
        <div className="flex items-center justify-between mt-auto">
          <span className="tabular text-sm font-medium text-text flex items-baseline gap-1">
            <span dir="ltr">{formatted}</span>
            <span className="text-xs text-text-muted">{currencySymbol}</span>
          </span>
          <Stepper quantity={quantity} onAdd={onAdd} onRemove={onRemove} />
        </div>
      </div>
    </div>
  );
}
