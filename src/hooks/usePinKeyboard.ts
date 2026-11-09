import { useEffect, useRef } from "react";

/** The digit a key press stands for, or null. Accepts the top row, the numpad and Arabic-Indic digits. */
export function pinKeyDigit(key: string): string | null {
  if (/^[0-9]$/.test(key)) return key;
  const arabic = "٠١٢٣٤٥٦٧٨٩".indexOf(key);
  if (key.length === 1 && arabic >= 0) return String(arabic);
  const persian = "۰۱۲۳۴۵۶۷۸۹".indexOf(key);
  if (key.length === 1 && persian >= 0) return String(persian);
  return null;
}

/**
 * Lets the PIN pad be typed on a physical keyboard as well as clicked: digits enter, Backspace removes.
 * The handlers are read through a ref, so the pad can pass fresh closures every render.
 */
export function usePinKeyboard(active: boolean, onDigit: (d: string) => void, onBackspace: () => void): void {
  const latest = useRef({ onDigit, onBackspace });
  latest.current = { onDigit, onBackspace };

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // A real text box on the page owns its own typing.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const digit = pinKeyDigit(e.key);
      if (digit !== null) {
        e.preventDefault();
        latest.current.onDigit(digit);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        latest.current.onBackspace();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);
}
