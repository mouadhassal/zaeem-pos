interface Props {
  disabled?: boolean;
  onClick: () => void;
  onHold?: () => void;
}

export default function PayKey({ disabled, onClick, onHold }: Props) {
  return (
    <div className="flex gap-2">
      <button
        onClick={onClick}
        disabled={disabled}
        className="flex-1 bg-accent text-white font-bold text-base rounded-[12px] transition-all active:scale-[0.98] disabled:opacity-40"
        style={{ height: 50, minHeight: 50 }}
      >
        دفع
      </button>
      {onHold && (
        <button
          onClick={onHold}
          className="px-4 rounded-[12px] bg-surface-alt text-text-2 text-sm font-medium transition-all active:scale-[0.98]"
          style={{ minHeight: 50, minWidth: 44 }}
        >
          تعليق
        </button>
      )}
    </div>
  );
}
