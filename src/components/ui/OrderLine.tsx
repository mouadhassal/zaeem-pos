import { useEffect, useRef, useState } from "react";
import { IconMinus as Minus, IconPlus as Plus, IconX as X, IconPencil as Pencil, IconGift as Gift, IconTag as Tag } from "@tabler/icons-react";
import { getCategoryStyle } from "./CategoryConfig";
import { useMenuItemPhoto } from "../../hooks/useMenuItemPhoto";
import { useAuthStore } from "../../stores/authStore";
import { usePrefsStore } from "../../stores/prefsStore";
import { formatAmount } from "../../lib/money";
import { parseTypedQuantity } from "../../lib/prefs";

interface Props {
  id: string;
  menuItemId?: string;
  hasPhoto?: boolean;
  categoryName: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  /** Options picked for this line ("without onion", "extra cheese"); their prices are part of the line total. */
  modifiers?: { name: string; priceCents: number }[];
  notes?: string;
  /** Sold by weight: the portion in grams. Such a line has no quantity stepper; its weight is changed in the weight dialog. */
  weightGrams?: number;
  pricePerKgCents?: number;
  /** "On the house": shown with its real value struck through and not charged. */
  comped?: boolean;
  compReason?: string;
  /** A special price: how much cheaper each unit is than the menu price. */
  cutPerUnitCents?: number;
  currencySymbol: string;
  onEdit?: ((id: string) => void) | undefined;
  onGift?: ((id: string) => void) | undefined;
  onIncrement?: ((id: string) => void) | undefined;
  onDecrement?: ((id: string) => void) | undefined;
  onVoid?: ((id: string) => void) | undefined;
  /** Typed quantity ("10"), and the extra "+N" button: both call this with the new total. */
  onSetQuantity?: ((id: string, quantity: number) => void) | undefined;
  /** Opens the special-price dialog for this line. */
  onEditPrice?: ((id: string) => void) | undefined;
}

/** The quantity between - and +, tappable to type a number, with an optional +N button. */
function QuantityControl({
  id, quantity, size, onIncrement, onDecrement, onSetQuantity,
}: {
  id: string;
  quantity: number;
  size: "normal" | "small";
  onIncrement?: ((id: string) => void) | undefined;
  onDecrement?: ((id: string) => void) | undefined;
  onSetQuantity?: ((id: string, quantity: number) => void) | undefined;
}) {
  const step = usePrefsStore((s) => s.quantityStep);
  const typing = usePrefsStore((s) => s.quantityTyping);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const btn = size === "small" ? "w-7 h-7 rounded-[7px]" : "w-8 h-8 rounded-[8px]";
  const icon = size === "small" ? "w-3.5 h-3.5" : "w-4 h-4";

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const n = parseTypedQuantity(text);
    if (n !== null && n !== quantity) onSetQuantity?.(id, n);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={() => onDecrement?.(id)}
        aria-label="إنقاص الكمية"
        className={`${btn} bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-[background-color] active:scale-95`}
      >
        <Minus className={icon} />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          value={text}
          inputMode="numeric"
          dir="ltr"
          data-testid="order-line-qty-input"
          aria-label="الكمية"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="tabular w-11 h-8 text-center text-sm font-medium rounded-[7px] border-2 border-accent bg-surface outline-none"
        />
      ) : onSetQuantity && typing ? (
        <button
          type="button"
          data-testid="order-line-qty"
          onClick={() => { setText(String(quantity)); setEditing(true); }}
          aria-label={`الكمية ${quantity}، اضغط لكتابة رقم`}
          className="tabular text-sm font-medium text-text min-w-7 h-8 px-1 text-center rounded-[7px] hover:bg-surface-alt"
        >
          {quantity}
        </button>
      ) : (
        <span className="tabular text-sm font-medium text-text w-6 text-center">{quantity}</span>
      )}
      {/* Color discipline: this is the one allowed non-logo/nav/pay
       * accent spot -- the "+" of an item already in the cart. */}
      <button
        type="button"
        onClick={() => onIncrement?.(id)}
        aria-label="زيادة الكمية"
        className={`${btn} bg-accent text-white flex items-center justify-center hover:opacity-90 transition-[opacity,transform] active:scale-95`}
      >
        <Plus className={icon} />
      </button>
      {step > 0 && onSetQuantity && (
        <button
          type="button"
          data-testid="order-line-step"
          onClick={() => onSetQuantity(id, quantity + step)}
          aria-label={`زيادة ${step}`}
          className={`${size === "small" ? "h-7" : "h-8"} px-2 rounded-[8px] bg-accent-soft text-accent-text text-xs font-bold tabular hover:brightness-95 transition-[filter,transform] active:scale-95`}
        >
          +{step}
        </button>
      )}
    </div>
  );
}

export default function OrderLine({
  id, menuItemId, hasPhoto, categoryName, name, quantity, unitPriceCents, currencySymbol,
  modifiers = [], notes, comped, compReason, weightGrams, pricePerKgCents, cutPerUnitCents, onEdit, onGift,
  onIncrement, onDecrement, onVoid, onSetQuantity, onEditPrice,
}: Props) {
  const style = getCategoryStyle(categoryName);
  const Icon = style.icon;
  const size = usePrefsStore((s) => s.orderPanelSize);
  const unitWithOptions = unitPriceCents + modifiers.reduce((sum, m) => sum + m.priceCents, 0);
  const lineTotal = unitWithOptions * quantity;
  const cutTotal = (cutPerUnitCents ?? 0) * quantity;
  const token = useAuthStore((s) => s.token);
  const photoUrl = useMenuItemPhoto(menuItemId ?? id, !!hasPhoto && size === "comfortable", token);

  // Currency-scale-aware -- was raw cents.toLocaleString(), which silently
  // assumed scale 0 (see lib/money.ts's formatAmount doc comment).
  const fmt = formatAmount;

  const hasStepper = !weightGrams && !!(onIncrement || onDecrement);
  const details = (modifiers.length > 0 || notes || (comped && compReason) || cutTotal > 0) && (
    <div className="text-xs text-text-muted leading-snug space-y-0.5" data-testid="order-line-details">
      {modifiers.length > 0 && (
        <p>{modifiers.map((m) => (m.priceCents > 0 ? `${m.name} +${fmt(m.priceCents)}` : m.name)).join("، ")}</p>
      )}
      {notes && <p className="italic">«{notes}»</p>}
      {comped && compReason && <p className="text-accent-text">{compReason}</p>}
      {cutTotal > 0 && !comped && (
        <p className="text-accent-text" data-testid="order-line-cut">سعر خاص: {fmt(unitWithOptions - (cutPerUnitCents ?? 0))} {currencySymbol} للواحد</p>
      )}
    </div>
  );
  const totalLabel = (
    <span className="tabular text-sm font-medium text-text shrink-0 flex items-baseline gap-1">
      {comped ? (
        <>
          <span dir="ltr" className="line-through text-text-muted">{fmt(lineTotal)}</span>
          <span className="text-xs text-accent-text font-medium">ضيافة</span>
        </>
      ) : cutTotal > 0 ? (
        <>
          <span dir="ltr" className="line-through text-text-muted text-xs">{fmt(lineTotal)}</span>
          <span dir="ltr">{fmt(lineTotal - cutTotal)}</span>
          <span className="text-xs text-text-muted">{currencySymbol}</span>
        </>
      ) : (
        <>
          <span dir="ltr">{fmt(lineTotal)}</span>
          <span className="text-xs text-text-muted">{currencySymbol}</span>
        </>
      )}
    </span>
  );

  // Compact and tiny: the actions are small icons on the same row as the
  // stepper (labels cost a whole extra row per line, which is what pushed a
  // 10-item order off the screen).
  if (size !== "comfortable") {
    const tiny = size === "tiny";
    const iconBtn = "w-7 h-7 rounded-[7px] flex items-center justify-center transition-[background-color,color] active:scale-95";
    return (
      <div className={`border-b border-line last:border-b-0 ${tiny ? "py-1" : "py-1.5"}`} data-testid="order-line" data-size={size}>
        <div className="flex items-center gap-1.5">
          <p className={`flex-1 min-w-0 font-medium text-text ${tiny ? "text-xs truncate" : "text-sm break-words"}`} data-testid="order-line-name">{name}</p>
          {tiny && hasStepper && (
            <QuantityControl id={id} quantity={quantity} size="small" onIncrement={onIncrement} onDecrement={onDecrement} onSetQuantity={onSetQuantity} />
          )}
          {totalLabel}
        </div>
        {details}
        <div className="flex items-center justify-between gap-1 mt-0.5">
          {!tiny && (
            <>
              <span className="tabular text-xs text-text-muted flex items-baseline gap-1 min-w-0">
                {weightGrams ? (
                  pricePerKgCents ? <><span dir="ltr">{fmt(pricePerKgCents)}</span><span>{currencySymbol} / كغ</span></> : null
                ) : quantity > 1 || !hasStepper ? (
                  <><span dir="ltr">{fmt(unitWithOptions)}</span><span>× {quantity}</span></>
                ) : null}
              </span>
              {hasStepper && (
                <QuantityControl id={id} quantity={quantity} size="small" onIncrement={onIncrement} onDecrement={onDecrement} onSetQuantity={onSetQuantity} />
              )}
            </>
          )}
          <div className={`flex items-center gap-0.5 ${tiny ? "ms-auto" : ""}`}>
            {onEdit && (
              <button type="button" onClick={() => onEdit(id)} aria-label={weightGrams ? "الوزن" : "إضافات"} title={weightGrams ? "الوزن" : "إضافات"} data-testid="order-line-edit" className={`${iconBtn} bg-surface-alt text-text-2 hover:bg-line`}>
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {onEditPrice && (
              <button type="button" onClick={() => onEditPrice(id)} aria-label="السعر" title="سعر خاص" data-testid="order-line-price" className={`${iconBtn} ${cutTotal > 0 ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-2 hover:bg-line"}`}>
                <Tag className="w-3.5 h-3.5" />
              </button>
            )}
            {onGift && (
              <button type="button" onClick={() => onGift(id)} aria-label={comped ? "إلغاء ضيافة" : "ضيافة"} title={comped ? "إلغاء ضيافة" : "ضيافة"} data-testid="order-line-gift" className={`${iconBtn} ${comped ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-2 hover:bg-line"}`}>
                <Gift className="w-3.5 h-3.5" />
              </button>
            )}
            {onVoid && (
              <button type="button" onClick={() => onVoid(id)} aria-label="حذف" title="حذف" data-testid="order-line-void" className={`${iconBtn} bg-surface-alt text-text-2 hover:bg-danger-100 hover:text-danger-600`}>
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    // Two rows, not one packed row: thumbnail(34)+name+steppers(72)+total(68)+void(32)
    // all on one line doesn't fit the 226px fixed panel -- it was overlapping.
    <div className="group flex items-start gap-2 py-3 border-b border-line last:border-b-0" data-testid="order-line" data-size="comfortable">
      {photoUrl ? (
        <img
          src={photoUrl}
          alt=""
          className="w-[34px] h-[34px] rounded-[9px] shrink-0 object-cover mt-0.5"
        />
      ) : (
        <div
          className="w-[34px] h-[34px] rounded-[9px] shrink-0 flex items-center justify-center mt-0.5"
          style={{ backgroundColor: style.wash }}
        >
          <Icon size={16} stroke={1.75} color={style.glyphColor} style={{ opacity: 0.7 }} />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-1">
          <p className="text-sm font-medium text-text min-w-0 break-words" data-testid="order-line-name">{name}</p>
          {totalLabel}
        </div>
        {details}
        <div className="flex items-center justify-between gap-2">
          <span className="tabular text-xs text-text-muted flex items-baseline gap-1 min-w-0">
            {weightGrams ? (
              pricePerKgCents ? (
                <>
                  <span dir="ltr">{fmt(pricePerKgCents)}</span>
                  <span>{currencySymbol} / كغ</span>
                </>
              ) : null
            ) : (quantity > 1 || !(onIncrement || onDecrement)) && (
              <>
                <span dir="ltr">{fmt(unitWithOptions)}</span>
                <span>{currencySymbol}</span>
                <span>× {quantity}</span>
              </>
            )}
          </span>
          {hasStepper && (
            <QuantityControl id={id} quantity={quantity} size="normal" onIncrement={onIncrement} onDecrement={onDecrement} onSetQuantity={onSetQuantity} />
          )}
        </div>
        {/* Labelled actions on their own wrapping row: icon-only buttons were
            not discoverable, and a single packed row overflowed the panel
            sideways. These wrap instead of ever scrolling. */}
        {(onEdit || onGift || onVoid) && (
          <div className="grid grid-cols-3 gap-1.5 pt-0.5">
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(id)}
                className="h-9 px-1 rounded-[8px] justify-center bg-surface-alt text-text-2 text-xs font-medium flex items-center gap-1 hover:bg-line transition-[background-color] active:scale-95"
                data-testid="order-line-edit"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>{weightGrams ? "الوزن" : "إضافات"}</span>
              </button>
            )}
            {onGift && (
              <button
                type="button"
                onClick={() => onGift(id)}
                className={`h-9 px-1 rounded-[8px] justify-center text-xs font-medium flex items-center gap-1 transition-[background-color] active:scale-95 ${comped ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-2 hover:bg-line"}`}
                data-testid="order-line-gift"
              >
                <Gift className="w-3.5 h-3.5" />
                <span>{comped ? "إلغاء ضيافة" : "ضيافة"}</span>
              </button>
            )}
            {onVoid && (
              <button
                type="button"
                onClick={() => onVoid(id)}
                data-testid="order-line-void"
                className="h-9 px-1 rounded-[8px] justify-center bg-surface-alt text-text-2 text-xs font-medium flex items-center gap-1 hover:bg-danger-100 hover:text-danger-600 transition-[background-color,color] active:scale-95"
              >
                <X className="w-3.5 h-3.5" />
                <span>حذف</span>
              </button>
            )}
          </div>
        )}
        {onEditPrice && (
          <button
            type="button"
            onClick={() => onEditPrice(id)}
            className={`h-8 px-1 rounded-[8px] justify-center text-xs font-medium flex items-center gap-1 transition-[background-color] active:scale-95 ${cutTotal > 0 ? "bg-accent-soft text-accent-text" : "bg-surface-alt text-text-2 hover:bg-line"}`}
            data-testid="order-line-price"
          >
            <Tag className="w-3.5 h-3.5" />
            <span>{cutTotal > 0 ? "تعديل السعر الخاص" : "سعر خاص"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
