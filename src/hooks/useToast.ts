import { useToastStore } from "../stores/toastStore";

// Thin convenience wrapper over toastStore -- `const toast = useToast();
// toast.success("تم الحفظ ✓"); toast.error(\`تعذر الحفظ: ${msg}\`);` -- see
// toastStore.ts for why this exists (item 3 of the 2026-09-14 QA audit).
export function useToast() {
  const show = useToastStore((s) => s.show);
  return {
    success: (message: string, durationMs?: number) => show(message, "success", durationMs),
    error: (message: string, durationMs?: number) => show(message, "error", durationMs),
  };
}
