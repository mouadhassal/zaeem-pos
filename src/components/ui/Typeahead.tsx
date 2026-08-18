import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconSearch as Search } from "@tabler/icons-react";

interface BaseProps<T> {
  value: string;
  onChange: (v: string) => void;
  onSelect: (item: T) => void;
  getKey: (item: T) => string;
  renderItem: (item: T, active: boolean) => ReactNode;
  placeholder?: string;
  /** Minimum characters in the query before showing suggestions. Default: 1 (in-memory) / 2 (fetch). */
  minChars?: number;
  className?: string;
  autoFocus?: boolean;
  /** Passed through to the underlying `<input dir=...>`, e.g. "ltr" for phone numbers. */
  dir?: "ltr" | "rtl";
  /** Message shown when the query is non-empty but nothing matched. */
  emptyMessage?: string;
}

interface InMemoryProps<T> extends BaseProps<T> {
  items: T[];
  filterItem: (item: T, query: string) => boolean;
  fetchSuggestions?: undefined;
}

interface FetchProps<T> extends BaseProps<T> {
  items?: undefined;
  filterItem?: undefined;
  fetchSuggestions: (query: string) => Promise<T[]>;
}

export type TypeaheadProps<T> = InMemoryProps<T> | FetchProps<T>;

const DEBOUNCE_MS = 300;

/**
 * Generic search-with-dropdown-suggestions input. Two mutually exclusive
 * modes:
 *  - in-memory: pass `items` + `filterItem`, suggestions recompute
 *    synchronously on every keystroke (no network round trip).
 *  - fetch: pass `fetchSuggestions`, debounced 300ms (same timing precedent
 *    as PaymentModal's old inline debtor-lookup effect), cancelled on
 *    unmount/re-trigger via `clearTimeout`.
 *
 * Keyboard: ArrowDown/ArrowUp move the highlighted row (clamped), Enter
 * selects the highlighted row, Escape closes the dropdown without touching
 * the input text. Click-outside (via a `mousedown` listener on `document`)
 * also closes it.
 */
export default function Typeahead<T>(props: TypeaheadProps<T>) {
  const {
    value, onChange, onSelect, getKey, renderItem, placeholder, className, autoFocus, emptyMessage, dir,
  } = props;
  const isFetchMode = typeof props.fetchSuggestions === "function";
  const minChars = props.minChars ?? (isFetchMode ? 2 : 1);

  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<T[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [loading, setLoading] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);

  // In-memory mode: synchronous recompute, no debounce.
  useEffect(() => {
    if (isFetchMode) return;
    const q = value.trim();
    if (q.length < minChars) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const next = props.items.filter((item) => props.filterItem(item, q));
    setSuggestions(next);
    setHighlightIndex(next.length > 0 ? 0 : -1);
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isFetchMode, props.items, props.filterItem, minChars]);

  // Fetch mode: debounced.
  useEffect(() => {
    if (!isFetchMode) return;
    const q = value.trim();
    if (q.length < minChars) {
      setSuggestions([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      props
        .fetchSuggestions(q)
        .then((rows) => {
          setSuggestions(rows);
          setHighlightIndex(rows.length > 0 ? 0 : -1);
          setOpen(true);
        })
        .catch(() => {
          setSuggestions([]);
          setOpen(true);
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isFetchMode, minChars]);

  // Click-outside closes the dropdown (does not clear the input).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectItem = (item: T) => {
    onSelect(item);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
        e.preventDefault();
        selectItem(suggestions[highlightIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showEmpty = open && !loading && value.trim().length >= minChars && suggestions.length === 0;

  return (
    <div className={`relative ${className ?? ""}`} ref={wrapperRef}>
      <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "بحث..."}
        autoFocus={autoFocus}
        dir={dir}
        className="w-full h-10 bg-ink-50 border-2 border-ink-200 rounded-sm pr-10 pl-3 text-sm text-ink-800 placeholder-ink-400 focus:outline-none focus:border-accent transition-colors"
      />
      {open && (loading || suggestions.length > 0 || showEmpty) && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-ink-200 rounded-sm shadow-sh-3 max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-sm font-arabic text-ink-400">...جارٍ البحث</div>
          )}
          {!loading &&
            suggestions.map((item, i) => (
              <div
                key={getKey(item)}
                onMouseDown={(e) => {
                  // mousedown (not click) so this fires before the
                  // document-level click-outside `mousedown` handler would
                  // otherwise close the dropdown first.
                  e.preventDefault();
                  selectItem(item);
                }}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`px-3 py-2 text-sm font-arabic cursor-pointer transition-colors ${
                  i === highlightIndex ? "bg-saffron-50" : "hover:bg-saffron-50"
                }`}
              >
                {renderItem(item, i === highlightIndex)}
              </div>
            ))}
          {!loading && showEmpty && (
            <div className="px-3 py-2 text-sm font-arabic text-ink-400">
              {emptyMessage ?? "لا توجد نتائج"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
