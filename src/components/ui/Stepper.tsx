interface Props {
  quantity: number;
  onAdd: () => void;
  onRemove?: (() => void) | undefined;
}

export default function Stepper({ quantity, onAdd, onRemove }: Props) {
  if (quantity === 0) {
    return (
      <button
        onClick={onAdd}
        className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center bg-saffron-500 text-white text-base font-medium transition-all active:scale-95"
        aria-label="إضافة"
      >
        +
      </button>
    );
  }

  return (
    // DOM order is [+, qty, -] so that under dir="rtl" it reads left-to-right
    // as "- qty +", per spec.
    <div className="flex items-center gap-1">
      <button
        onClick={onAdd}
        className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center bg-saffron-500 text-white text-base font-medium transition-all active:scale-95"
        aria-label="زيادة"
      >
        +
      </button>
      <span className="tabular text-xs text-text-2 min-w-[16px] text-center">
        {quantity}
      </span>
      {onRemove && (
        <button
          onClick={onRemove}
          className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center bg-surface-alt text-text-3 text-base font-medium transition-all active:scale-95"
          aria-label="تقليل"
        >
          −
        </button>
      )}
    </div>
  );
}
