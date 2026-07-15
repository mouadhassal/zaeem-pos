import { IconMinus as Minus, IconPlus as Plus, IconX as X } from "@tabler/icons-react";
import { getCategoryStyle } from "./CategoryConfig";

interface Props {
  id: string;
  categoryName: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  currencySymbol: string;
  onIncrement?: ((id: string) => void) | undefined;
  onDecrement?: ((id: string) => void) | undefined;
  onVoid?: ((id: string) => void) | undefined;
}

export default function OrderLine({
  id, categoryName, name, quantity, unitPriceCents, currencySymbol,
  onIncrement, onDecrement, onVoid,
}: Props) {
  const style = getCategoryStyle(categoryName);
  const Icon = style.icon;
  const lineTotal = unitPriceCents * quantity;

  const fmt = (c: number) =>
    (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <div className="group flex items-center gap-2 py-1.5">
      <div
        className="w-[34px] h-[34px] rounded-[9px] shrink-0 flex items-center justify-center"
        style={{ backgroundColor: style.wash }}
      >
        <Icon size={16} stroke={1.75} color={style.glyphColor} style={{ opacity: 0.7 }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text truncate">{name}</p>
        <span className="tabular text-xs text-text-muted flex items-baseline gap-1">
          <span dir="ltr">{fmt(unitPriceCents)}</span>
          <span>{currencySymbol}</span>
          <span>× {quantity}</span>
        </span>
      </div>
      {(onIncrement || onDecrement) && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onDecrement?.(id)}
            aria-label="إنقاص الكمية"
            className="w-6 h-6 rounded-[7px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-colors"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="tabular text-sm text-text w-4 text-center">{quantity}</span>
          <button
            type="button"
            onClick={() => onIncrement?.(id)}
            aria-label="زيادة الكمية"
            className="w-6 h-6 rounded-[7px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      )}
      <span className="tabular text-sm font-medium text-text shrink-0 min-w-[60px] flex items-baseline gap-1 justify-end">
        <span dir="ltr">{fmt(lineTotal)}</span>
        <span className="text-xs text-text-muted">{currencySymbol}</span>
      </span>
      {onVoid && (
        <button
          type="button"
          onClick={() => onVoid(id)}
          aria-label="إلغاء الصنف"
          className="w-6 h-6 rounded-[7px] text-text-muted flex items-center justify-center hover:bg-surface-alt hover:text-danger transition-colors shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
