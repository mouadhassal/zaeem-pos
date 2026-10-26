interface Props {
  quantity: number;
  onAdd: () => void;
  onRemove?: (() => void) | undefined;
  /**
   * Small cards (many per row) have no room for "- qty +" beside the price.
   * There the whole card already adds, so the stepper drops its "+" and
   * shows only the quantity and "-".
   */
  size?: "md" | "sm" | "xs";
}

const BUTTON_SIZE = {
  md: "w-[34px] h-[34px] rounded-[9px] text-lg",
  sm: "w-[28px] h-[28px] rounded-[8px] text-base",
  xs: "w-[24px] h-[24px] rounded-[7px] text-sm",
} as const;

export default function Stepper({ quantity, onAdd, onRemove, size = "md" }: Props) {
  const button = `${BUTTON_SIZE[size]} flex items-center justify-center font-medium transition-transform active:scale-95`;
  const small = size !== "md";

  if (quantity === 0) {
    if (size === "xs") return null;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onAdd(); }}
        className={`${button} bg-saffron-500 text-white`}
        aria-label="إضافة"
      >
        +
      </button>
    );
  }

  return (
    // DOM order is [+, qty, -] so that under dir="rtl" it reads left-to-right
    // as "- qty +", per spec.
    <div className={`flex items-center ${small ? "gap-0.5" : "gap-1"}`}>
      {!small && (
        <button
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          className={`${button} bg-saffron-500 text-white`}
          aria-label="زيادة"
        >
          +
        </button>
      )}
      <span className={`tabular text-xs text-center ${small ? "font-semibold text-danger min-w-[14px]" : "text-text-2 min-w-[16px]"}`}>
        {quantity}
      </span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
          className={`${button} bg-surface-alt text-text-3`}
          aria-label="تقليل"
        >
          −
        </button>
      )}
    </div>
  );
}
