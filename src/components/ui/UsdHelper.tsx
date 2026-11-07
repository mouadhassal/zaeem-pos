import { useEffect, useRef, useState } from "react";
import { usePrefsStore } from "../../stores/prefsStore";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { toLatinDigits } from "../../lib/digits";

/**
 * A small "$" button for any price field: the owner buys from suppliers in US dollars, so he types the
 * dollar price here and the field gets its value in the shop's currency at the rate he set in the
 * preferences. Hidden until a rate is set. The dollar amount itself is not stored: the shop's books are
 * in the shop's currency, so the cost is what it cost today.
 */
export default function UsdHelper({ onConvert, label = "السعر بالدولار" }: { onConvert: (localMinor: number) => void; label?: string }) {
  const rate = usePrefsStore((s) => s.usdRate);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const away = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (rate <= 0) return null;

  const usd = Number(toLatinDigits(text).replace(/[,٬\s]/g, ""));
  const valid = text.trim() !== "" && Number.isFinite(usd) && usd > 0;
  const localMinor = valid ? parseMoneyInput(String(usd * rate)) : 0;
  const apply = () => {
    if (!valid) return;
    onConvert(localMinor);
    setText("");
    setOpen(false);
  };

  return (
    <div className="relative inline-block" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        data-testid="usd-helper-open"
        className="h-10 w-10 rounded-sm border-2 border-ink-200 text-sm font-bold text-ink-700 hover:border-saffron-500 hover:text-saffron-700"
      >
        $
      </button>
      {open && (
        <div className="absolute z-40 top-11 end-0 w-56 rounded-md border border-ink-200 bg-white shadow-lg p-3 space-y-2" dir="rtl" data-testid="usd-helper-box">
          <label className="block text-xs font-arabic text-ink-500">{label} (1$ = {formatMoney(parseMoneyInput(String(rate)))})</label>
          <input
            ref={inputRef}
            value={text}
            inputMode="decimal"
            dir="ltr"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") setOpen(false); }}
            data-testid="usd-helper-input"
            className="w-full h-10 rounded-sm border-2 border-ink-200 px-3 text-sm outline-none focus:border-saffron-600"
          />
          <div className="text-sm font-arabic text-ink-700 min-h-5" data-testid="usd-helper-result">{valid ? `= ${formatMoney(localMinor)}` : ""}</div>
          <button type="button" onClick={apply} disabled={!valid} data-testid="usd-helper-apply" className="w-full h-9 rounded-sm bg-saffron-600 text-white text-sm font-bold font-arabic disabled:opacity-40">تطبيق</button>
        </div>
      )}
    </div>
  );
}
