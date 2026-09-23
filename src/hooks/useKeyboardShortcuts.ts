import { useEffect } from "react";

type ShortcutMap = Record<string, () => void>;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useKeyboardShortcuts(map: ShortcutMap) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      // Real function keys only (e.key "F1".."F9"). This used to map the
      // DIGIT keys 0-9 to "F0"-"F9" (and real F-keys never matched at all),
      // so a USB barcode scanner -- which is a keyboard -- typing a code
      // containing "1" fired F1 = Pay mid-scan whenever the cart had items,
      // and the rest of the barcode landed in the cash-received field.
      if (/^F[0-9]$/.test(e.key)) {
        const action = map[e.key];
        if (action) {
          e.preventDefault();
          action();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [map]);
}
