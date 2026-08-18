import { useEffect, useRef, useState } from "react";
import { IconCalendar, IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

interface DatePickerProps {
  value: string; // ISO "YYYY-MM-DD", "" allowed for empty
  onChange: (value: string) => void;
  minYear?: number;
  maxYear?: number;
  className?: string;
  placeholder?: string;
  dir?: "ltr" | "rtl";
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function isoToDate(iso: string): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateToDisplay(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Parses "dd/mm/yyyy", "d/m/yyyy" or a raw ISO "yyyy-mm-dd" string into a Date. */
function parseDisplay(text: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) return d;
    return null;
  }

  const dmyMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3]);
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) return d;
    return null;
  }

  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export default function DatePicker({
  value,
  onChange,
  minYear,
  maxYear,
  className = "",
  placeholder = "dd/mm/yyyy",
  dir = "ltr",
}: DatePickerProps) {
  const selectedDate = isoToDate(value);
  const today = new Date();

  const [text, setText] = useState<string>(selectedDate ? dateToDisplay(selectedDate) : "");
  const [isOpen, setIsOpen] = useState(false);
  const [isYearPickerOpen, setIsYearPickerOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<number>(selectedDate ? selectedDate.getMonth() : today.getMonth());
  const [viewYear, setViewYear] = useState<number>(selectedDate ? selectedDate.getFullYear() : today.getFullYear());

  const containerRef = useRef<HTMLDivElement>(null);

  const resolvedMinYear = minYear ?? today.getFullYear() - 5;
  const resolvedMaxYear = maxYear ?? today.getFullYear() + 1;

  // Keep the display text in sync when the external value changes (e.g. selecting via calendar,
  // or the parent resetting the field) without clobbering in-progress typing.
  useEffect(() => {
    const d = isoToDate(value);
    setText(d ? dateToDisplay(d) : "");
    setViewMonth(d ? d.getMonth() : today.getMonth());
    setViewYear(d ? d.getFullYear() : today.getFullYear());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!isOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsYearPickerOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (isYearPickerOpen) {
          setIsYearPickerOpen(false);
        } else {
          setIsOpen(false);
        }
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, isYearPickerOpen]);

  function commitText(raw: string) {
    if (!raw.trim()) {
      onChange("");
      setText("");
      return;
    }
    const parsed = parseDisplay(raw);
    if (parsed) {
      onChange(dateToIso(parsed));
      setText(dateToDisplay(parsed));
      setViewMonth(parsed.getMonth());
      setViewYear(parsed.getFullYear());
    } else {
      // revert to last valid value
      const d = isoToDate(value);
      setText(d ? dateToDisplay(d) : "");
    }
  }

  function selectDay(day: number) {
    const d = new Date(viewYear, viewMonth, day);
    onChange(dateToIso(d));
    setText(dateToDisplay(d));
    setIsOpen(false);
    setIsYearPickerOpen(false);
  }

  function goPrevMonth() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function goNextMonth() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  const totalDays = daysInMonth(viewYear, viewMonth);
  const leadingBlanks = firstWeekdayOfMonth(viewYear, viewMonth);
  const dayCells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];

  const years: number[] = [];
  for (let y = resolvedMaxYear; y >= resolvedMinYear; y--) years.push(y);

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString("en-US", { month: "long" });

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        dir={dir}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commitText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitText((e.target as HTMLInputElement).value);
          }
        }}
        onFocus={() => setIsOpen(true)}
        className={
          className ||
          "w-full h-10 px-4 pl-10 rounded-sm bg-white border border-ink-200 text-ink-900 font-mono text-sm outline-none focus:border-saffron-500"
        }
      />
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-saffron-600"
        tabIndex={-1}
      >
        <IconCalendar className="w-4 h-4" />
      </button>

      {isOpen && (
        <div
          dir="ltr"
          className="absolute z-50 mt-1 w-64 bg-white border-2 border-ink-200 rounded-sm shadow-xl p-3"
          style={{ top: "100%" }}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={goPrevMonth}
              className="p-1 rounded-sm hover:bg-ink-50 text-ink-500"
            >
              <IconChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setIsYearPickerOpen((o) => !o)}
              className="text-sm font-semibold text-ink-900 hover:text-saffron-600 px-2"
            >
              {monthLabel} {viewYear}
            </button>
            <button
              type="button"
              onClick={goNextMonth}
              className="p-1 rounded-sm hover:bg-ink-50 text-ink-500"
            >
              <IconChevronRight className="w-4 h-4" />
            </button>
          </div>

          {isYearPickerOpen ? (
            <div className="grid grid-cols-4 gap-1 max-h-48 overflow-y-auto">
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => {
                    setViewYear(y);
                    setIsYearPickerOpen(false);
                  }}
                  className={`text-xs py-1.5 rounded-sm ${
                    y === viewYear
                      ? "bg-saffron-500 text-white"
                      : "text-ink-700 hover:bg-ink-50"
                  }`}
                >
                  {y}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-7 gap-1 mb-1">
                {WEEKDAYS.map((wd) => (
                  <div key={wd} className="text-[10px] text-center text-ink-400 font-medium">
                    {wd}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {dayCells.map((day, idx) => {
                  if (day === null) return <div key={`blank-${idx}`} />;
                  const isSelected =
                    !!selectedDate &&
                    selectedDate.getFullYear() === viewYear &&
                    selectedDate.getMonth() === viewMonth &&
                    selectedDate.getDate() === day;
                  const isToday =
                    today.getFullYear() === viewYear &&
                    today.getMonth() === viewMonth &&
                    today.getDate() === day;
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => selectDay(day)}
                      className={`text-xs py-1.5 rounded-sm ${
                        isSelected
                          ? "bg-saffron-500 text-white"
                          : isToday
                            ? "border border-saffron-400 text-ink-900"
                            : "text-ink-700 hover:bg-ink-50"
                      }`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
