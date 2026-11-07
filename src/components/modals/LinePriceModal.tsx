import { useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { useCurrency } from "../../hooks/useCurrency";
import { minorToInputValue, parseMoneyInput } from "../../lib/money";

interface Props {
  itemName: string;
  /** The menu price of one unit with its options. */
  unitCents: number;
  /** The special price now in force, if any (per unit). */
  currentPriceCents: number | null;
  /** The new price per unit; the line's discount is menu price minus this. */
  onConfirm: (priceCents: number) => void;
  /** Back to the menu price. */
  onReset: () => void;
  onCancel: () => void;
}

/**
 * A special price for one line (a friend, a regular, a mistake on the menu).
 * It can only go down: the difference is recorded as a discount on the order,
 * so the owner's discount limit, the manager's PIN and the audit trail apply.
 */
export default function LinePriceModal({ itemName, unitCents, currentPriceCents, onConfirm, onReset, onCancel }: Props) {
  const { fmt } = useCurrency();
  const [text, setText] = useState(minorToInputValue(currentPriceCents ?? unitCents));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.select(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const parsed = text.trim() === "" ? null : parseMoneyInput(text);
  const valid = parsed !== null && parsed >= 0 && parsed < unitCents;
  const tooHigh = parsed !== null && parsed >= unitCents;

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" data-testid="line-price-modal">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[380px] overflow-hidden" dir="rtl">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="font-arabic font-bold text-lg text-ink-900">سعر خاص</h2>
            <p className="font-arabic text-sm text-ink-500 mt-0.5">{itemName} · السعر في القائمة {fmt(unitCents)}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="إغلاق" className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-ink-500">
            <IconX className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 space-y-3">
          <label className="font-arabic text-sm text-ink-500 block">السعر الجديد للواحد</label>
          <input
            ref={inputRef}
            value={text}
            inputMode="decimal"
            dir="ltr"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid && parsed !== null) onConfirm(parsed); }}
            data-testid="line-price-input"
            className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 text-lg tabular outline-none focus:border-accent"
          />
          {tooHigh && <p className="font-arabic text-xs text-danger">السعر الخاص يكون أقل من سعر القائمة. لرفع السعر عدّل سعر الصنف في القائمة.</p>}
          {valid && parsed !== null && (
            <p className="font-arabic text-xs text-ink-500">خصم {fmt(unitCents - parsed)} على كل واحد، يُسجَّل على الفاتورة باسمك.</p>
          )}
        </div>
        <div className="px-6 py-4 border-t border-line flex gap-3">
          {currentPriceCents !== null && (
            <button type="button" onClick={onReset} data-testid="line-price-reset" className="h-12 px-4 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">سعر القائمة</button>
          )}
          <button type="button" onClick={onCancel} className="flex-1 h-12 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">رجوع</button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => parsed !== null && onConfirm(parsed)}
            data-testid="line-price-confirm"
            className="flex-1 h-12 rounded-xl bg-accent text-white font-arabic font-bold hover:opacity-90 disabled:opacity-40"
          >
            تطبيق
          </button>
        </div>
      </div>
    </div>
  );
}
