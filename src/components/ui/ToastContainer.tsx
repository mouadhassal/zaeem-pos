import { useToastStore } from "../../stores/toastStore";

// Renders whatever's in toastStore -- mounted once in App.tsx (like
// SessionExpiredOverlay) so it overlays every view. Visually mirrors
// pos/page.tsx's existing successMsg/dbError banners (fixed top-center,
// colored pill, white text) rather than inventing a new look.
export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="text-white px-6 py-3 rounded-[12px] shadow-sh-3 text-sm font-medium pointer-events-auto"
          style={{ backgroundColor: t.kind === "error" ? "var(--danger)" : "var(--ok)" }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
