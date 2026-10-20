import { useMemo, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { useCurrency } from "../../hooks/useCurrency";
import { missingRequired, selectionToModifiers, toggleChoice, type Modifier, type OptionGroup, type Selection } from "../../lib/itemOptions";

interface Props {
  itemName: string;
  groups: OptionGroup[];
  initialSelection?: Selection;
  initialNote?: string;
  /** Modifiers the line already has that no longer belong to any group; kept when confirming. */
  keepModifiers?: Modifier[];
  confirmLabel?: string;
  onConfirm: (result: { modifiers: Modifier[]; note: string }) => void;
  onCancel: () => void;
}

/**
 * Shown when a cashier taps an item that has options ("without onion",
 * "extra cheese +2,000") and when they edit a line already in the cart. Also
 * carries a free-text note for the kitchen. Prices shown here are for the
 * cashier's eyes only; the server re-prices every option from the menu.
 */
export default function OptionPickerModal({ itemName, groups, initialSelection, initialNote, keepModifiers, confirmLabel, onConfirm, onCancel }: Props) {
  const { fmt } = useCurrency();
  const [selection, setSelection] = useState<Selection>(initialSelection ?? {});
  const [note, setNote] = useState(initialNote ?? "");
  const [showMissing, setShowMissing] = useState(false);

  const missing = useMemo(() => missingRequired(groups, selection), [groups, selection]);
  const modifiers = useMemo(() => selectionToModifiers(groups, selection), [groups, selection]);
  const extraCents = modifiers.reduce((s, m) => s + m.priceCents, 0);

  const confirm = () => {
    if (missing.length > 0) {
      setShowMissing(true);
      return;
    }
    onConfirm({ modifiers: [...modifiers, ...(keepModifiers ?? [])], note: note.trim() });
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" data-testid="option-picker">
      <div className="bg-white rounded-md border border-line shadow-sh-3 w-[480px] max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-ink-200 flex items-center justify-between">
          <h2 className="font-arabic font-bold text-lg text-ink-900">{itemName}</h2>
          <button onClick={onCancel} className="w-8 h-8 rounded-lg hover:bg-surface-alt flex items-center justify-center text-ink-500" aria-label="إغلاق">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.id} className="space-y-2" data-testid="option-picker-group">
              <div className="flex items-center gap-2">
                <span className="font-arabic text-sm font-bold text-ink-700">{g.name}</span>
                {g.required && <span className="text-xs text-danger font-arabic">مطلوب</span>}
                {g.selection === "SINGLE" && <span className="text-xs text-ink-400 font-arabic">اختر واحداً</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.choices.map((c) => {
                  const on = (selection[g.id] ?? []).includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelection((s) => toggleChoice(g, s, c.id))}
                      className={`min-h-[44px] px-4 rounded-full font-arabic text-sm transition-colors ${on ? "bg-saffron-600 text-white" : "bg-surface-alt text-ink-700 hover:bg-ink-200"}`}
                      data-testid="option-choice"
                      aria-pressed={on}
                    >
                      {c.name}
                      {c.price_cents > 0 && <span className="ms-1 opacity-80">+{fmt(c.price_cents)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="space-y-1.5">
            <label className="font-arabic text-sm text-ink-500 block">ملاحظة للمطبخ</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={120}
              placeholder="مثال: حارّ، بدون ملح..."
              className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-arabic text-sm outline-none focus:border-saffron-600"
              data-testid="option-note"
            />
          </div>

          {showMissing && missing.length > 0 && (
            <p className="font-arabic text-sm text-danger" data-testid="option-missing">اختر من: {missing.join("، ")}</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3 items-center">
          <button onClick={onCancel} className="h-12 px-5 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">رجوع</button>
          <button onClick={confirm} className="flex-1 h-12 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-saffron-700" data-testid="option-confirm">
            {confirmLabel ?? "إضافة"}
            {extraCents > 0 && <span className="ms-2 opacity-90">(+{fmt(extraCents)})</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
