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
      // Digit-row keys 0-9 double as "F0"-"F9" shortcuts here -- but
      // without this guard that meant every digit typed into a real text
      // field (customer phone, loyalty card number, cash-received amount,
      // etc.) also fired whatever action happened to be mapped to that
      // digit, fighting the user's typing instead of letting it through.
      if (isTypingTarget(e.target)) return;
      const key = e.key.toUpperCase();
      const fKey = `F${key}`;
      if (fKey.startsWith("F") && !isNaN(Number(key))) {
        const action = map[`F${key}`];
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
