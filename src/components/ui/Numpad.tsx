import { IconBackspace } from "@tabler/icons-react";

interface Props {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onConfirm?: () => void;
}

const KEYS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["", "0", "backspace"],
];

export default function Numpad({ onDigit, onBackspace, onClear, onConfirm }: Props) {
  return (
    <div className="grid grid-cols-3 gap-2 p-2">
      {KEYS.flat().map((k) => {
        if (k === "") {
          return <div key="empty" />;
        }
        if (k === "backspace") {
          return (
            <button
              key={k}
              onClick={onBackspace}
              aria-label="حذف"
              className="rounded-[10px] bg-surface-alt text-text-2 flex items-center justify-center transition-all active:scale-95"
              style={{ minHeight: 44, minWidth: 44 }}
            >
              <IconBackspace className="w-5 h-5" stroke={1.75} />
            </button>
          );
        }
        return (
          <button
            key={k}
            onClick={() => onDigit(k)}
            className="rounded-[10px] bg-surface-alt text-text text-lg font-medium transition-all active:scale-95"
            style={{ minHeight: 44, minWidth: 44 }}
          >
            {k}
          </button>
        );
      })}
      {onConfirm && (
        <button
          onClick={onConfirm}
          className="col-span-3 rounded-[10px] bg-accent text-white font-bold text-base transition-all active:scale-95"
          style={{ minHeight: 44 }}
        >
          تأكيد
        </button>
      )}
      <button
        onClick={onClear}
        className="col-span-3 rounded-[10px] bg-surface-alt text-text-muted text-sm font-medium transition-all active:scale-95"
        style={{ minHeight: 36 }}
      >
        مسح
      </button>
    </div>
  );
}
