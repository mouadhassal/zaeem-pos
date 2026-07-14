import { useRef, useState, useEffect, useCallback } from "react";
import ProductCard from "./ProductCard";

interface MenuGridItem {
  id: string;
  name: string;
  price_cents: number;
  image_path: string | null;
  is_combo?: boolean;
  combo_original_price_cents?: number | null;
}

interface Props<T extends MenuGridItem> {
  items: T[];
  columns?: number;
  gap?: number;
  itemHeight?: number;
  onAdd: (item: T) => void;
  flashId?: string | null;
}

const OVERSCAN = 2;

export default function VirtualizedMenuGrid<T extends MenuGridItem>({
  items,
  columns = 4,
  gap = 12,
  itemHeight = 200,
  onAdd,
  flashId,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });

  const actualColumns = Math.max(1, columns);
  const rows = Math.ceil(items.length / actualColumns);
  const rowHeight = itemHeight + gap;

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const scrollTop = el.scrollTop;
    const clientHeight = el.clientHeight;

    const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const endRow = Math.min(
      rows,
      Math.ceil((scrollTop + clientHeight) / rowHeight) + OVERSCAN
    );

    setVisibleRange({
      start: startRow * actualColumns,
      end: Math.min(items.length, endRow * actualColumns),
    });
  }, [rowHeight, rows, actualColumns, items.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  const visibleItems = items.slice(visibleRange.start, visibleRange.end);
  const startRow = Math.floor(visibleRange.start / actualColumns);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 pb-4"
      style={{ willChange: "scroll-position" }}
    >
      <div
        className="relative"
        style={{ height: rows * rowHeight, willChange: "transform" }}
      >
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${actualColumns}, 1fr)`,
            gap: `${gap}px`,
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${startRow * rowHeight}px)`,
            willChange: "transform",
          }}
        >
          {visibleItems.map((item) => (
            <div
              key={item.id}
              className={flashId === item.id ? "cart-item-new" : ""}
              style={{ height: itemHeight }}
            >
              <ProductCard
                id={item.id}
                name={item.name}
                price={Number(item.price_cents)}
                {...(item.image_path ? { image: item.image_path } : {})}
                onAdd={() => onAdd(item)}
                isCombo={!!item.is_combo}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
