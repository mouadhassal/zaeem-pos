import { useMemo } from "react";
import { useToastStore } from "../stores/toastStore";

// Thin convenience wrapper over toastStore -- `const toast = useToast();
// toast.success("تم الحفظ ✓"); toast.error(\`تعذر الحفظ: ${msg}\`);` -- see
// toastStore.ts for why this exists (item 3 of the 2026-09-14 QA audit).
//
// The returned object is stable between renders (it only changes if the
// store's `show` does), so it is safe in a hook dependency list -- a fresh
// object every render made `useCallback(..., [toast])` + `useEffect` reload
// a screen's data on every single render.
export function useToast() {
  const show = useToastStore((s) => s.show);
  return useMemo(
    () => ({
      success: (message: string, durationMs?: number) => show(message, "success", durationMs),
      error: (message: string, durationMs?: number) => show(message, "error", durationMs),
    }),
    [show],
  );
}
