interface Props {
  disabled?: boolean;
  onClick: () => void;
  onHold?: () => void;
  holdDisabled?: boolean;
  /** "Send to kitchen now, pay later" dine-in fix: a real pre-payment step
      for DINE_IN -- fires the kitchen ticket (creates the order, or appends
      to one already sent) without collecting payment. Only passed by the
      caller when this is actually offered (DINE_IN with a table picked);
      omitted entirely otherwise, same convention as `onHold`. */
  onSendToKitchen?: () => void;
  sendToKitchenDisabled?: boolean;
  sendToKitchenLabel?: string;
}

export default function PayKey({ disabled, onClick, onHold, holdDisabled, onSendToKitchen, sendToKitchenDisabled, sendToKitchenLabel }: Props) {
  return (
    <div className="flex flex-col gap-2">
      {onSendToKitchen && (
        <button
          onClick={onSendToKitchen}
          disabled={sendToKitchenDisabled}
          className="h-11 rounded-[12px] bg-ink-800 text-white text-sm font-bold transition-[transform,opacity] active:scale-[0.98] disabled:opacity-40"
        >
          {sendToKitchenLabel ?? "إرسال للمطبخ"}
        </button>
      )}
      <div className="flex gap-2">
        <button
          onClick={onClick}
          disabled={disabled}
          className="flex-1 bg-saffron-500 text-white font-bold text-base rounded-[12px] transition-[transform,opacity] active:scale-[0.98] disabled:opacity-40"
          style={{ height: 52, minHeight: 52 }}
        >
          دفع
        </button>
        {onHold && (
          <button
            onClick={onHold}
            disabled={holdDisabled}
            className="px-4 rounded-[12px] bg-surface-alt text-text-2 text-sm font-medium transition-[transform,opacity] active:scale-[0.98] disabled:opacity-40"
            style={{ minHeight: 52, minWidth: 48 }}
          >
            تعليق
          </button>
        )}
      </div>
    </div>
  );
}
