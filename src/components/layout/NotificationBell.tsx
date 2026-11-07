import { useCallback, useEffect, useRef, useState } from "react";
import { IconBell as Bell, IconX } from "@tabler/icons-react";
import { invoke } from "../../lib/invoke";
import { navigateTo } from "../../lib/appNav";
import { useAuthStore } from "../../stores/authStore";
import { usePrefsStore } from "../../stores/prefsStore";
import { useMarketStore } from "../../stores/marketStore";
import {
  longShiftNotification, lowIngredientNotifications, lowProductNotifications, marketLinksNotification, marketReceiptsNotification, visibleNotifications,
  type AppNotification, type LowIngredient, type LowProduct,
} from "../../lib/notifications";

const POLL_MS = 120_000;
const DISMISSED_KEY = "zaeem_pos_dismissed_notifications";

function readDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(-300) : [];
  } catch {
    return [];
  }
}

/**
 * The bell in the top bar: things worth a look (a product running out, a shift left open). It asks the
 * till what it already knows every two minutes; a source that the person is not allowed to read, or that
 * the owner turned off in the preferences, is simply skipped. Tap one to open its screen; the cross hides it for today.
 */
export default function NotificationBell() {
  const token = useAuthStore((s) => s.token);
  const notifyLowStock = usePrefsStore((s) => s.notifyLowStock);
  const notifyLongShift = usePrefsStore((s) => s.notifyLongShift);
  const [all, setAll] = useState<AppNotification[]>([]);
  const market = useMarketStore((s) => s.status);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!token) { setAll([]); return; }
    const day = new Date().toLocaleDateString("en-CA");
    const found: AppNotification[] = [];
    if (notifyLowStock) {
      await invoke<LowProduct[]>("list_product_stock_v3", { sessionToken: token, search: null, onlyLow: true, includeUntracked: false })
        .then((rows) => found.push(...lowProductNotifications(rows, day)))
        .catch(() => { /* not allowed or not a shop: no product alerts */ });
      await invoke<LowIngredient[]>("list_low_stock_ingredients_v3", { sessionToken: token })
        .then((rows) => found.push(...lowIngredientNotifications(rows, day)))
        .catch(() => { /* same */ });
    }
    if (notifyLongShift) {
      await invoke<{ opened_at: string } | null>("get_active_shift_v3", { sessionToken: token })
        .then((shift) => {
          const n = longShiftNotification(shift?.opened_at, Date.now(), day);
          if (n) found.push(n);
        })
        .catch(() => { /* no shift */ });
    }
    setAll(found);
  }, [token, notifyLowStock, notifyLongShift]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [open]);

  const dismiss = (id: string) => {
    const next = [...dismissed, id].slice(-300);
    setDismissed(next);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* storage blocked: hidden until restart */ }
  };

  const day = new Date().toLocaleDateString("en-CA");
  const marketNotes = [marketReceiptsNotification(market.receiptsToReview, day), marketLinksNotification(market.ordersNeedLinks, day)].filter((n): n is AppNotification => n !== null);
  const shown = visibleNotifications([...marketNotes, ...all], dismissed);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); if (!open) void refresh(); }}
        aria-label={shown.length > 0 ? `${shown.length} تنبيهات` : "التنبيهات"}
        aria-expanded={open}
        data-testid="notification-bell"
        className="relative w-9 h-9 rounded-[10px] flex items-center justify-center text-text-muted hover:bg-surface-alt transition-colors"
      >
        <Bell className="w-[18px] h-[18px]" />
        {shown.length > 0 && (
          <span className="absolute -top-0.5 -end-0.5 min-w-4 h-4 px-1 rounded-full bg-danger text-white text-[10px] leading-4 text-center font-bold" data-testid="notification-count">
            {shown.length > 9 ? "9+" : shown.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-11 end-0 w-80 max-h-[70vh] overflow-y-auto rounded-md border border-line bg-surface shadow-lg z-50" dir="rtl" data-testid="notification-list">
          <div className="px-4 py-2.5 border-b border-line text-sm font-bold font-arabic text-text">التنبيهات</div>
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-muted font-arabic text-center" data-testid="notification-empty">لا شيء يحتاج انتباهك الآن ✓</p>
          ) : (
            <ul>
              {shown.map((n) => (
                <li key={n.id} className="flex items-start gap-2 px-4 py-3 border-b border-line last:border-b-0" data-testid="notification-item">
                  <button
                    type="button"
                    onClick={() => { setOpen(false); navigateTo(n.view); }}
                    className="flex-1 text-start"
                  >
                    <span className="block text-sm font-bold font-arabic text-text">{n.title}</span>
                    <span className="block text-xs font-arabic text-text-muted mt-0.5">{n.detail}</span>
                  </button>
                  <button type="button" onClick={() => dismiss(n.id)} aria-label="إخفاء" className="w-7 h-7 rounded-md hover:bg-surface-alt flex items-center justify-center text-text-muted shrink-0">
                    <IconX className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
