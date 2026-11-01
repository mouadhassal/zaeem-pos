import { useEffect, useMemo, useRef, useState } from "react";
import { IconBackspace, IconX } from "@tabler/icons-react";
import { formatAmount, getCurrency, scaleFor, CURRENCY_SYMBOL } from "../../lib/money";
import { formatWeight, resolveWeighing, type WeighMode, type WeighResult } from "../../lib/weight";

interface Props {
  itemName: string;
  /** The menu price: one kilogram. */
  pricePerKgCents: number;
  /** Editing a portion already in the cart. */
  initialGrams?: number;
  confirmLabel?: string;
  onConfirm: (portion: WeighResult) => void;
  onCancel: () => void;
}

const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "back"] as const;
const QUICK_KG = [
  { label: "ربع كيلو", kg: "0.25" },
  { label: "نصف كيلو", kg: "0.5" },
  { label: "كيلو", kg: "1" },
];

/**
 * "Give me 10,000 of shawarma" / "285 grams": shown when a cashier taps an item
 * sold by weight. Two ways in, one result: type the AMOUNT the customer asked
 * for and see the weight, or type the WEIGHT in kilograms and see the price.
 * The server prices the portion again from the weight, so what is shown here
 * is for the cashier's eyes only.
 */
export default function WeightModal({ itemName, pricePerKgCents, initialGrams, confirmLabel, onConfirm, onCancel }: Props) {
  const scale = scaleFor(getCurrency());
  const [mode, setMode] = useState<WeighMode>(initialGrams ? "weight" : "amount");
  const [text, setText] = useState(initialGrams ? String(initialGrams / 1000) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const result = useMemo(() => resolveWeighing(mode, text, pricePerKgCents, scale), [mode, text, pricePerKgCents, scale]);
  const typed = text.trim().length > 0;

  const press = (k: (typeof KEYS)[number]) => {
    if (k === "back") setText((v) => v.slice(0, -1));
    else if (k === ".") setText((v) => (v.includes(".") ? v : (v === "" ? "0." : v + ".")));
    else setText((v) => v + k);
  };

  const confirm = () => {
    if (result.ok) onConfirm(result.value);
  };

  const switchTo = (next: WeighMode) => {
    if (next === mode) return;
    setMode(next);
    setText("");
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" data-testid="weight-modal">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[440px] max-w-[95vw] max-h-[95vh] flex flex-col overflow-hidden" dir="rtl">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="font-arabic font-bold text-lg text-ink-900 truncate">{itemName}</h2>
            <p className="text-xs text-ink-500 font-arabic tabular">
              السعر: <span dir="ltr">{formatAmount(pricePerKgCents)}</span> {CURRENCY_SYMBOL} / كغ
            </p>
          </div>
          <button onClick={onCancel} className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-ink-500" aria-label="إغلاق">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 bg-surface-alt rounded-sm p-1" role="radiogroup" aria-label="طريقة الإدخال">
            {([
              ["amount", "بالمبلغ"],
              ["weight", "بالوزن (كغ)"],
            ] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => switchTo(m)}
                data-testid={`weight-mode-${m}`}
                className={`h-10 rounded-[6px] text-sm font-arabic transition-colors ${mode === m ? "bg-saffron-600 text-white font-bold" : "text-ink-600 hover:text-ink-900"}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className="block text-xs text-ink-500 font-arabic mb-1">
              {mode === "amount" ? `المبلغ الذي طلبه الزبون (${CURRENCY_SYMBOL})` : "الوزن بالكيلوغرام، مثلاً 0.285"}
            </label>
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirm();
                }
              }}
              inputMode="decimal"
              dir="ltr"
              data-testid="weight-input"
              className="w-full h-14 rounded-sm border-2 border-ink-200 focus:border-saffron-500 outline-none text-center text-2xl tabular font-medium"
              placeholder={mode === "amount" ? "10000" : "0.285"}
            />
          </div>

          {mode === "weight" && (
            <div className="flex gap-2">
              {QUICK_KG.map((q) => (
                <button
                  key={q.kg}
                  type="button"
                  onClick={() => setText(q.kg)}
                  className="flex-1 h-9 rounded-[8px] bg-surface-alt text-xs font-arabic text-ink-700 hover:bg-ink-200 active:scale-95"
                >
                  {q.label}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2" dir="ltr">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                aria-label={k === "back" ? "حذف" : k}
                className="rounded-sm bg-surface-alt text-text text-lg font-medium transition-transform active:scale-95 flex items-center justify-center"
                style={{ minHeight: 48 }}
              >
                {k === "back" ? <IconBackspace className="w-5 h-5" stroke={1.75} /> : k}
              </button>
            ))}
          </div>

          <div className="rounded-md bg-saffron-50 px-4 py-3 min-h-[64px] flex flex-col justify-center" aria-live="polite" data-testid="weight-result">
            {result.ok ? (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-arabic text-ink-700">
                  {mode === "amount" ? "الوزن" : "السعر"}
                </span>
                <span className="text-2xl font-bold tabular text-ink-900">
                  {mode === "amount" ? (
                    <span data-testid="weight-result-value">≈ {formatWeight(result.value.grams)}</span>
                  ) : (
                    <span data-testid="weight-result-value">
                      <span dir="ltr">{formatAmount(result.value.lineCents)}</span> <span className="text-sm text-ink-500">{CURRENCY_SYMBOL}</span>
                    </span>
                  )}
                </span>
              </div>
            ) : (
              <p className="text-sm font-arabic text-ink-500">{typed ? result.reason : mode === "amount" ? "اكتب المبلغ لأعرف الوزن" : "اكتب الوزن لأعرف السعر"}</p>
            )}
          </div>
        </div>

        <div className="px-5 pb-5 flex gap-2">
          <button
            type="button"
            onClick={confirm}
            disabled={!result.ok}
            data-testid="weight-confirm"
            className="flex-1 h-12 rounded-sm bg-accent text-white font-bold font-arabic disabled:opacity-40 active:scale-[0.98]"
          >
            {confirmLabel ?? "إضافة للسلة"}
          </button>
          <button type="button" onClick={onCancel} className="h-12 px-5 rounded-sm bg-surface-alt text-ink-700 font-arabic active:scale-[0.98]">
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
