import { useCallback, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  categories?: { id: number; name: string }[];
  active?: string | null;
  onChange?: (cat: string | null) => void;
}

export default function CategoryDock({ categories = [], active = null, onChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const showScroll = categories.length > 8;

  const scroll = useCallback((dir: "left" | "right") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: dir === "left" ? -200 : 200, behavior: "smooth" });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight") scroll("right");
      else if (e.key === "ArrowLeft") scroll("left");
    },
    [scroll]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollBy({ left: e.deltaY, behavior: "smooth" });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (categories.length === 0 && !onChange) return null;

  return (
    <div className="relative" onKeyDown={handleKeyDown} dir="rtl">
      {showScroll && (
        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-7 h-7 flex items-center justify-center bg-white border border-ink-200 rounded-sm shadow-sm text-ink-500 hover:text-ink-700"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
      <div
        ref={scrollRef}
        className="flex gap-1.5 overflow-x-auto no-scrollbar px-4 py-2.5 scroll-smooth"
      >
        {onChange && (
          <button
            onClick={() => onChange(null)}
            className={`shrink-0 px-3.5 py-1.5 rounded-sm text-sm font-medium transition-colors ${
              active === null
                ? "bg-saffron-600 text-white"
                : "bg-white text-ink-600 border border-ink-200 hover:bg-ink-50 hover:text-ink-700"
            }`}
          >
            الكل
          </button>
        )}
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onChange?.(cat.name)}
            className={`shrink-0 px-3.5 py-1.5 rounded-sm text-sm font-medium transition-colors whitespace-nowrap ${
              active === cat.name
                ? "bg-saffron-600 text-white"
                : "bg-white text-ink-600 border border-ink-200 hover:bg-ink-50 hover:text-ink-700"
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>
      {showScroll && (
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-7 h-7 flex items-center justify-center bg-white border border-ink-200 rounded-sm shadow-sm text-ink-500 hover:text-ink-700"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
