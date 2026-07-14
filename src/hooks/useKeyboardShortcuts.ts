import { useEffect } from "react";

type ShortcutMap = Record<string, () => void>;

export function useKeyboardShortcuts(map: ShortcutMap) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
