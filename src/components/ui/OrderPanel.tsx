import type { ReactNode } from "react";
import OrderLine from "./OrderLine";

interface LineItem {
  id: string;
  name: string;
  categoryName: string;
  quantity: number;
  unitPriceCents: number;
}

interface Props {
  orderNumber: string;
  lines: LineItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  currencySymbol: string;
  usdTotal?: string;
  children?: ReactNode;
  toolbar?: ReactNode;
  onIncrementLine?: (id: string) => void;
  onDecrementLine?: (id: string) => void;
  onVoidLine?: (id: string) => void;
}

export default function OrderPanel({
  orderNumber, lines, subtotalCents, discountCents,
  totalCents, currencySymbol, usdTotal, children, toolbar,
  onIncrementLine, onDecrementLine, onVoidLine,
}: Props) {
  const fmt = (c: number) =>
    (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <div
      className="bg-surface rounded-[14px] shadow-sh-3 flex flex-col overflow-hidden"
      style={{ margin: "0 16px 16px 0" }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-medium text-text">الطلبية</span>
        <span className="tabular text-xs px-2 py-0.5 rounded-[7px] bg-surface-alt text-text-muted">
          #{orderNumber}
        </span>
      </div>

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

      <div className="px-4 py-3 border-t border-dashed border-line space-y-1">
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
        <div className="flex justify-between items-baseline pt-2 border-t border-line">
          <span className="text-base font-medium text-text">الإجمالي</span>
          <div className="flex items-baseline gap-1.5" style={{ letterSpacing: "-0.02em" }}>
            <span className="tabular text-[44px] font-medium text-text leading-none" dir="ltr">
              {fmt(totalCents)}
            </span>
            <span className="text-sm font-medium text-text-2">{currencySymbol}</span>
          </div>
        </div>
        {usdTotal && (
          <div className="tabular text-[11px] text-text-muted text-left" dir="ltr">≈ {usdTotal} USD</div>
        )}
      </div>

      {toolbar && (
        <div className="px-4 pt-1 pb-2">
          {toolbar}
        </div>
      )}

      {children && (
        <div className="px-4 pb-4 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}
