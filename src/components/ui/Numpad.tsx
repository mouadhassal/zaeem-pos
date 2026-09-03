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
              className="rounded-sm bg-surface-alt text-text-2 flex items-center justify-center transition-transform active:scale-95"
              style={{ minHeight: 52, minWidth: 52 }}
            >
              <IconBackspace className="w-5 h-5" stroke={1.75} />
            </button>
          );
        }
        return (
          <button
            key={k}
            onClick={() => onDigit(k)}
            className="rounded-sm bg-surface-alt text-text text-lg font-medium transition-transform active:scale-95"
            style={{ minHeight: 52, minWidth: 52 }}
          >
            {k}
          </button>
        );
      })}
      {onConfirm && (
        <button
          onClick={onConfirm}
          className="col-span-3 rounded-sm bg-accent text-white font-bold text-base transition-transform active:scale-95"
          style={{ minHeight: 52 }}
        >
          تأكيد
        </button>
      )}
      <button
        onClick={onClear}
        className="col-span-3 rounded-sm bg-surface-alt text-text-muted text-sm font-medium transition-transform active:scale-95"
        style={{ minHeight: 40 }}
      >
        مسح
      </button>
    </div>
  );
}
