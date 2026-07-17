import type { ReactNode } from "react";
import { IconPencil } from "@tabler/icons-react";
import OrderLine from "./OrderLine";

interface LineItem {
  id: string;
  menuItemId?: string;
  hasPhoto?: boolean;
  name: string;
  categoryName: string;
  quantity: number;
  unitPriceCents: number;
}

interface Props {
  tableLabel: string;
  lines: LineItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  currencySymbol: string;
  usdTotal?: string | undefined;
  onEditOrder?: (() => void) | undefined;
  children?: ReactNode;
  toolbar?: ReactNode;
  onIncrementLine?: (id: string) => void;
  onDecrementLine?: (id: string) => void;
  onVoidLine?: (id: string) => void;
}

export default function OrderPanel({
  tableLabel, lines, subtotalCents, discountCents,
  totalCents, currencySymbol, usdTotal, onEditOrder, children, toolbar,
  onIncrementLine, onDecrementLine, onVoidLine,
}: Props) {
  const fmt = (c: number) =>
    (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    // Full-height pinned column -- no floating margin, no card radius/shadow.
    // The left border is the only separation from the canvas.
    <div className="h-full w-full bg-surface border-l border-line flex flex-col overflow-hidden">
      {/* TOP: table header, fixed */}
      <div className="h-14 shrink-0 flex items-center justify-between gap-2 px-4 border-b border-line">
        <span className="text-sm font-medium text-text truncate">{tableLabel}</span>
        {onEditOrder && (
          <button
            type="button"
            onClick={onEditOrder}
            aria-label="تعديل الطلب"
            className="w-8 h-8 rounded-[9px] flex items-center justify-center text-text-muted hover:bg-surface-alt transition-colors shrink-0"
          >
            <IconPencil className="w-4 h-4" stroke={1.75} />
          </button>
        )}
      </div>

      {/* MIDDLE: order lines, scrolls internally */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-0.5">
        {lines.map((line) => (
          <OrderLine
            key={line.id}
            {...line}
            currencySymbol={currencySymbol}
            onIncrement={onIncrementLine}
            onDecrement={onDecrementLine}
            onVoid={onVoidLine}
          />
        ))}
        {lines.length === 0 && (
          <div className="text-sm text-text-muted text-center py-8">
            ما في أصناف بعد. اختر طاولة لتبدأ.
          </div>
        )}
      </div>

      {/* BOTTOM: anchored footer -- subtle tint marks it as the "receipt" zone */}
      <div className="shrink-0 bg-panel-footer border-t border-line px-4 pt-3 pb-4 space-y-2">
        {toolbar}

        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-text-2">المجموع الفرعي</span>
            <span className="tabular text-text flex items-baseline gap-1">
              <span dir="ltr">{fmt(subtotalCents)}</span>
              <span className="text-text-muted text-xs">{currencySymbol}</span>
            </span>
          </div>
          {discountCents > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-text-2">الخصم</span>
              <span className="tabular text-danger flex items-baseline gap-1">
                <span dir="ltr">−{fmt(discountCents)}</span>
                <span className="text-xs">{currencySymbol}</span>
              </span>
            </div>
          )}
          <div className="pt-2 border-t border-dashed border-line">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text">الإجمالي</span>
              {usdTotal && (
                <span className="tabular text-[11px] text-text-muted" dir="ltr">≈ {usdTotal} USD</span>
              )}
            </div>
            <div className="flex items-baseline justify-end gap-1.5" style={{ letterSpacing: "-0.02em" }}>
              <span className="tabular text-[26px] font-medium text-text leading-none" dir="ltr">
                {fmt(totalCents)}
              </span>
              <span className="text-sm font-medium text-text-2">{currencySymbol}</span>
            </div>
          </div>
        </div>

        {children && <div className="space-y-2 pt-1">{children}</div>}
      </div>
    </div>
  );
}
