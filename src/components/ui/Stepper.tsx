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
        className="w-8 h-8 rounded-[10px] flex items-center justify-center bg-surface-alt text-text-3 text-lg font-medium transition-all active:scale-95"
        style={{ minWidth: 32, minHeight: 32 }}
        aria-label="إضافة"
      >
        +
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span className="tabular text-sm text-text-2 min-w-[20px] text-center">
        {quantity}
      </span>
      <button
        onClick={onAdd}
        className="w-8 h-8 rounded-[10px] flex items-center justify-center bg-accent text-white text-lg font-medium transition-all active:scale-95"
        style={{ minWidth: 32, minHeight: 32 }}
        aria-label="زيادة"
      >
        +
      </button>
      {onRemove && quantity > 0 && (
        <button
          onClick={onRemove}
          className="w-8 h-8 rounded-[10px] flex items-center justify-center bg-surface-alt text-text-3 text-lg font-medium transition-all active:scale-95"
          style={{ minWidth: 32, minHeight: 32 }}
          aria-label="تقليل"
        >
          −
        </button>
      )}
    </div>
  );
}
