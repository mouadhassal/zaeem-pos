import { IconMinus as Minus, IconPlus as Plus, IconX as X, IconPencil as Pencil, IconGift as Gift } from "@tabler/icons-react";
import { getCategoryStyle } from "./CategoryConfig";
import { useMenuItemPhoto } from "../../hooks/useMenuItemPhoto";
import { useAuthStore } from "../../stores/authStore";
import { formatAmount } from "../../lib/money";

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
  /** "On the house": shown with its real value struck through and not charged. */
  comped?: boolean;
  compReason?: string;
  currencySymbol: string;
  onEdit?: ((id: string) => void) | undefined;
  onGift?: ((id: string) => void) | undefined;
  onIncrement?: ((id: string) => void) | undefined;
  onDecrement?: ((id: string) => void) | undefined;
  onVoid?: ((id: string) => void) | undefined;
}

export default function OrderLine({
  id, menuItemId, hasPhoto, categoryName, name, quantity, unitPriceCents, currencySymbol,
  modifiers = [], notes, comped, compReason, onEdit, onGift,
  onIncrement, onDecrement, onVoid,
}: Props) {
  const style = getCategoryStyle(categoryName);
  const Icon = style.icon;
  const unitWithOptions = unitPriceCents + modifiers.reduce((sum, m) => sum + m.priceCents, 0);
  const lineTotal = unitWithOptions * quantity;
  const token = useAuthStore((s) => s.token);
  const photoUrl = useMenuItemPhoto(menuItemId ?? id, !!hasPhoto, token);

  // Currency-scale-aware -- was raw cents.toLocaleString(), which silently
  // assumed scale 0 (see lib/money.ts's formatAmount doc comment).
  const fmt = formatAmount;

  return (
    // Two rows, not one packed row: thumbnail(34)+name+steppers(72)+total(68)+void(32)
    // all on one line doesn't fit the 226px fixed panel -- it was overlapping.
    <div className="group flex items-start gap-2 py-2" data-testid="order-line">
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
          <p className="text-sm text-text truncate" data-testid="order-line-name">{name}</p>
          <span className="tabular text-sm font-medium text-text shrink-0 flex items-baseline gap-1">
            {comped ? (
              <>
                <span dir="ltr" className="line-through text-text-muted">{fmt(lineTotal)}</span>
                <span className="text-xs text-accent-text font-medium">ضيافة</span>
              </>
            ) : (
              <>
                <span dir="ltr">{fmt(lineTotal)}</span>
                <span className="text-xs text-text-muted">{currencySymbol}</span>
              </>
            )}
          </span>
        </div>
        {(modifiers.length > 0 || notes || (comped && compReason)) && (
          <div className="text-xs text-text-muted leading-snug space-y-0.5" data-testid="order-line-details">
            {modifiers.length > 0 && (
              <p>{modifiers.map((m) => (m.priceCents > 0 ? `${m.name} +${fmt(m.priceCents)}` : m.name)).join("، ")}</p>
            )}
            {notes && <p className="italic">«{notes}»</p>}
            {comped && compReason && <p className="text-accent-text">{compReason}</p>}
          </div>
        )}
        <div className="flex items-center justify-between gap-1">
          <span className="tabular text-xs text-text-muted flex items-baseline gap-1">
            <span dir="ltr">{fmt(unitWithOptions)}</span>
            <span>{currencySymbol}</span>
            <span>× {quantity}</span>
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {(onIncrement || onDecrement) && (
              <>
                <button
                  type="button"
                  onClick={() => onDecrement?.(id)}
                  aria-label="إنقاص الكمية"
                  className="w-7 h-7 rounded-[7px] bg-surface-alt text-text-2 flex items-center justify-center hover:bg-line transition-[background-color] active:scale-95"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="tabular text-sm text-text w-4 text-center">{quantity}</span>
                {/* Color discipline: this is the one allowed non-logo/nav/pay
                 * accent spot -- the "+" of an item already in the cart. */}
                <button
                  type="button"
                  onClick={() => onIncrement?.(id)}
                  aria-label="زيادة الكمية"
                  className="w-7 h-7 rounded-[7px] bg-accent text-white flex items-center justify-center hover:opacity-90 transition-[opacity,transform] active:scale-95"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(id)}
                aria-label="تعديل الخيارات والملاحظة"
                className="w-7 h-7 rounded-[7px] text-text-muted flex items-center justify-center hover:bg-surface-alt hover:text-text transition-[background-color,color] active:scale-95"
                data-testid="order-line-edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {onGift && (
              <button
                type="button"
                onClick={() => onGift(id)}
                aria-label="ضيافة"
                className={`w-7 h-7 rounded-[7px] flex items-center justify-center hover:bg-surface-alt transition-[background-color,color] active:scale-95 ${comped ? "text-accent-text" : "text-text-muted hover:text-text"}`}
                data-testid="order-line-gift"
              >
                <Gift className="w-3.5 h-3.5" />
              </button>
            )}
            {onVoid && (
              <button
                type="button"
                onClick={() => onVoid(id)}
                aria-label="إلغاء الصنف"
                data-testid="order-line-void"
                className="w-7 h-7 rounded-[7px] text-text-muted flex items-center justify-center hover:bg-surface-alt hover:text-danger transition-[background-color,color] active:scale-95"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
