import { useMemo, useState } from "react";
import { IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import { useCurrency } from "../../hooks/useCurrency";
import { choiceKind, choiceShortName, missingRequired, selectionToModifiers, toggleChoice, type Modifier, type OptionGroup, type Selection } from "../../lib/itemOptions";
import { usePrefsStore } from "../../stores/prefsStore";

export interface PickerResult {
  modifiers: Modifier[];
  note: string;
  /** Only when `askQuantity` is on. */
  quantity: number;
  /** Only when `askReason` is on. */
  reason: string;
  /** Only when `needsPin` is on. */
  pin: string;
}

interface Props {
  itemName: string;
  groups: OptionGroup[];
  initialSelection?: Selection;
  initialNote?: string;
  /** Modifiers the line already has that no longer belong to any group; kept when confirming. */
  keepModifiers?: Modifier[];
  confirmLabel?: string;
  /** Editing a line already sent to the kitchen: change the quantity too. */
  askQuantity?: boolean;
  initialQuantity?: number;
  /** Editing a line already sent to the kitchen: say why (it is recorded and printed). */
  askReason?: boolean;
  /** The server wants a manager PIN for this change. */
  needsPin?: boolean;
  /** Message from a failed attempt (shown under the form). */
  error?: string | null;
  busy?: boolean;
  onConfirm: (result: PickerResult) => void;
  onCancel: () => void;
}

const REASONS = ["طلب العميل", "خطأ في الطلب", "خطأ في التحضير", "أخرى"];

/**
 * Shown when a cashier taps an item that has options ("without onion",
 * "extra cheese +2,000") and when they edit a line already in the cart. Also
 * carries a free-text note for the kitchen. For a line already sent to the
 * kitchen it also asks the new quantity and the reason. Prices shown here are
 * for the cashier's eyes only; the server re-prices every option from the menu.
 */
export default function OptionPickerModal({
  itemName, groups, initialSelection, initialNote, keepModifiers, confirmLabel,
  askQuantity, initialQuantity, askReason, needsPin, error, busy, onConfirm, onCancel,
}: Props) {
  const { fmt } = useCurrency();
  const [selection, setSelection] = useState<Selection>(initialSelection ?? {});
  const [note, setNote] = useState(initialNote ?? "");
  const [quantity, setQuantity] = useState(initialQuantity ?? 1);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [pin, setPin] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  // "table" layout: which side of the Without / With table is open.
  const layout = usePrefsStore((s) => s.optionsLayout);
  const [openKind, setOpenKind] = useState<"without" | "with" | null>(null);

  const missing = useMemo(() => missingRequired(groups, selection), [groups, selection]);
  const modifiers = useMemo(() => selectionToModifiers(groups, selection), [groups, selection]);
  const extraCents = modifiers.reduce((s, m) => s + m.priceCents, 0);
  const finalReason = reason === "أخرى" ? customReason.trim() : reason;
  const reasonMissing = !!askReason && !finalReason;
  const pinMissing = !!needsPin && !pin;

  const confirm = () => {
    if (missing.length > 0) {
      setShowMissing(true);
      return;
    }
    if (reasonMissing || pinMissing) return;
    onConfirm({ modifiers: [...modifiers, ...(keepModifiers ?? [])], note: note.trim(), quantity, reason: finalReason, pin });
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
          {askQuantity && (
            <div className="flex items-center gap-3">
              <span className="font-arabic text-sm font-bold text-ink-700">الكمية</span>
              <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="w-11 h-11 rounded-[9px] bg-surface-alt flex items-center justify-center" aria-label="إنقاص" data-testid="edit-qty-minus">
                <IconMinus className="w-4 h-4" />
              </button>
              <span className="tabular w-8 text-center font-bold" data-testid="edit-qty">{quantity}</span>
              <button type="button" onClick={() => setQuantity((q) => q + 1)} className="w-11 h-11 rounded-[9px] bg-accent text-white flex items-center justify-center" aria-label="زيادة" data-testid="edit-qty-plus">
                <IconPlus className="w-4 h-4" />
              </button>
            </div>
          )}

          {layout === "table" && (
            <WithoutWithTable groups={groups} selection={selection} openKind={openKind} onOpen={setOpenKind} onToggle={(g, id) => setSelection((s) => toggleChoice(g, s, id))} fmt={fmt} />
          )}

          {groups.map((g) => layout === "table" ? { ...g, choices: g.choices.filter((c) => choiceKind(c.name) === "other") } : g).filter((g) => g.choices.length > 0).map((g) => (
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

          {askReason && (
            <div className="space-y-2">
              <label className="font-arabic text-sm text-ink-500 block">سبب التعديل *</label>
              <div className="flex flex-wrap gap-2">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={`min-h-[44px] px-4 rounded-full font-arabic text-sm ${reason === r ? "bg-saffron-600 text-white" : "bg-surface-alt text-ink-700 hover:bg-ink-200"}`}
                    data-testid="edit-reason"
                  >
                    {r}
                  </button>
                ))}
              </div>
              {reason === "أخرى" && (
                <input
                  type="text"
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="اكتب السبب..."
                  className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-arabic text-sm outline-none focus:border-saffron-600"
                  data-testid="edit-custom-reason"
                />
              )}
            </div>
          )}

          {needsPin && (
            <div className="space-y-1.5">
              <label className="font-arabic text-sm text-ink-500 block">هذا التعديل يحتاج موافقة المدير: رمز المدير</label>
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="w-full h-12 rounded-sm border-2 border-ink-200 px-4 font-mono text-sm outline-none focus:border-saffron-600"
                data-testid="edit-pin"
                autoFocus
              />
            </div>
          )}

          {showMissing && missing.length > 0 && (
            <p className="font-arabic text-sm text-danger" data-testid="option-missing">اختر من: {missing.join("، ")}</p>
          )}
          {error && <p className="font-arabic text-sm text-danger" data-testid="option-error">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-ink-200 flex gap-3 items-center">
          <button onClick={onCancel} className="h-12 px-5 rounded-xl bg-surface-alt text-ink-900 font-arabic font-bold hover:bg-ink-200">رجوع</button>
          <button
            onClick={confirm}
            disabled={busy || reasonMissing || pinMissing}
            className="flex-1 h-12 rounded-xl bg-saffron-600 text-white font-arabic font-bold hover:bg-saffron-700 disabled:opacity-50"
            data-testid="option-confirm"
          >
            {busy ? "..." : (confirmLabel ?? "إضافة")}
            {extraCents > 0 && <span className="ms-2 opacity-90">(+{fmt(extraCents)})</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The options as a small table: two big buttons, "Without" and "With" (extra), and the one you tap opens
 * its own choices ("without" -> onion, tomato; "with" -> cheese, sauce). The same picks and prices as the
 * plain list, just not all on screen at once. Choices whose name does not start with without/with stay in the list.
 */
function WithoutWithTable({
  groups, selection, openKind, onOpen, onToggle, fmt,
}: {
  groups: OptionGroup[];
  selection: Selection;
  openKind: "without" | "with" | null;
  onOpen: (k: "without" | "with" | null) => void;
  onToggle: (g: OptionGroup, choiceId: string) => void;
  fmt: (cents: number) => string;
}) {
  const entries = groups.flatMap((g) => g.choices.map((c) => ({ g, c, kind: choiceKind(c.name) })));
  const of = (k: "without" | "with") => entries.filter((e) => e.kind === k);
  const picked = (k: "without" | "with") => of(k).filter((e) => (selection[e.g.id] ?? []).includes(e.c.id));
  if (of("without").length === 0 && of("with").length === 0) return null;
  const sides: { kind: "without" | "with"; label: string }[] = [
    { kind: "without", label: "بدون" },
    { kind: "with", label: "مع / زيادة" },
  ];
  return (
    <div className="space-y-3" data-testid="option-table">
      <div className="grid grid-cols-2 gap-2">
        {sides.map(({ kind, label }) => {
          const count = picked(kind).length;
          const active = openKind === kind;
          return (
            <button
              key={kind}
              type="button"
              disabled={of(kind).length === 0}
              onClick={() => onOpen(active ? null : kind)}
              aria-expanded={active}
              data-testid={`option-table-${kind}`}
              className={`min-h-[56px] rounded-md border-2 font-arabic text-base font-bold transition-colors disabled:opacity-40 ${active ? "border-saffron-600 bg-saffron-50 text-saffron-700" : "border-ink-200 text-ink-800 hover:border-saffron-400"}`}
            >
              {label}
              {count > 0 && <span className="ms-2 inline-flex min-w-6 h-6 px-1.5 rounded-full bg-saffron-600 text-white text-xs items-center justify-center">{count}</span>}
            </button>
          );
        })}
      </div>
      {openKind && (
        <div className="flex flex-wrap gap-2 rounded-md bg-surface-alt p-3" data-testid="option-table-choices">
          {of(openKind).map(({ g, c }) => {
            const on = (selection[g.id] ?? []).includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onToggle(g, c.id)}
                className={`min-h-[44px] px-4 rounded-full font-arabic text-sm transition-colors ${on ? "bg-saffron-600 text-white" : "bg-white text-ink-700 border border-ink-200 hover:bg-ink-100"}`}
                data-testid="option-choice"
                aria-pressed={on}
              >
                {choiceShortName(c.name)}
                {c.price_cents > 0 && <span className="ms-1 opacity-80">+{fmt(c.price_cents)}</span>}
              </button>
            );
          })}
        </div>
      )}
      {(picked("without").length > 0 || picked("with").length > 0) && (
        <p className="font-arabic text-xs text-ink-500" data-testid="option-table-summary">
          {[...picked("without"), ...picked("with")].map((e) => e.c.name).join("، ")}
        </p>
      )}
    </div>
  );
}
