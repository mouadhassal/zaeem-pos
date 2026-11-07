/**
 * In-app notifications: what the bell shows. Pure functions turn what the till already knows (stock
 * levels, the open shift) into a short list of things worth looking at; the store polls and filters by
 * the owner's switches (preferences). Nothing here is sent anywhere.
 */

export type NotificationKind = "low-stock-product" | "low-stock-ingredient" | "long-shift" | "market-receipts" | "market-links";

export interface AppNotification {
  /** Stable, so a dismissed one stays dismissed: kind + what it is about + the day. */
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  /** The screen to open when the notification is tapped (an app view id). */
  view: string;
}

export interface LowProduct { menu_item_id: string; name: string; quantity: number; min_quantity: number; sold_by?: string }
export interface LowIngredient { id: string; name: string; unit: string; current_stock: number; min_stock: number }

const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** Products whose tracked stock fell to or below their alert level. Out-of-stock ones come first. */
export function lowProductNotifications(rows: readonly LowProduct[], day: string, max = 8): AppNotification[] {
  const sorted = [...rows].sort((a, b) => a.quantity - b.quantity);
  const out = sorted.slice(0, max).map<AppNotification>((r) => ({
    id: `low-stock-product:${r.menu_item_id}:${day}`,
    kind: "low-stock-product",
    title: r.quantity <= 0 ? `${r.name} نفد` : `${r.name} أوشك على النفاد`,
    detail: `المتبقي ${num(r.quantity)}${r.sold_by === "weight" ? " كغ" : ""} (التنبيه عند ${num(r.min_quantity)})`,
    view: "stockroom",
  }));
  if (sorted.length > max) {
    out.push({
      id: `low-stock-product:more:${day}`,
      kind: "low-stock-product",
      title: `و${sorted.length - max} منتجات أخرى أوشكت على النفاد`,
      detail: "افتح مخزون المنتجات لرؤية القائمة كاملة",
      view: "stockroom",
    });
  }
  return out;
}

/** Kitchen ingredients at or below their minimum. */
export function lowIngredientNotifications(rows: readonly LowIngredient[], day: string, max = 8): AppNotification[] {
  const sorted = [...rows].sort((a, b) => a.current_stock - b.current_stock);
  const out = sorted.slice(0, max).map<AppNotification>((r) => ({
    id: `low-stock-ingredient:${r.id}:${day}`,
    kind: "low-stock-ingredient",
    title: r.current_stock <= 0 ? `${r.name} نفدت` : `${r.name} أوشكت على النفاد`,
    detail: `المتبقي ${num(r.current_stock)} ${r.unit} (الحد الأدنى ${num(r.min_stock)})`,
    view: "inventory",
  }));
  if (sorted.length > max) {
    out.push({
      id: `low-stock-ingredient:more:${day}`,
      kind: "low-stock-ingredient",
      title: `و${sorted.length - max} مواد أخرى أوشكت على النفاد`,
      detail: "افتح المخزون لرؤية القائمة كاملة",
      view: "inventory",
    });
  }
  return out;
}

/** A shift open longer than `hours` (forgotten at closing time). */
export function longShiftNotification(openedAtIso: string | null | undefined, nowMs: number, day: string, hours = 14): AppNotification | null {
  if (!openedAtIso) return null;
  const opened = Date.parse(openedAtIso);
  if (!Number.isFinite(opened)) return null;
  const open = (nowMs - opened) / 3_600_000;
  if (open < hours) return null;
  return {
    id: `long-shift:${openedAtIso}:${day}`,
    kind: "long-shift",
    title: "وردية مفتوحة منذ وقت طويل",
    detail: `مفتوحة منذ ${Math.floor(open)} ساعة. هل نسيت إغلاقها؟`,
    view: "shift",
  };
}

/** Goods that arrived from a supplier and need the owner to match them with the stock. */
export function marketReceiptsNotification(count: number, day: string): AppNotification | null {
  if (count <= 0) return null;
  return {
    id: `market-receipts:${count}:${day}`,
    kind: "market-receipts",
    title: count === 1 ? "وصلت طلبية من السوق" : `وصلت ${count} طلبيات من السوق`,
    detail: "تحتاج مراجعتك لتُضاف إلى المخزون",
    view: "inventory",
  };
}

/** A supplier's customer orders held back because a product is not linked to a POS product yet. */
export function marketLinksNotification(count: number, day: string): AppNotification | null {
  if (count <= 0) return null;
  return {
    id: `market-links:${count}:${day}`,
    kind: "market-links",
    title: count === 1 ? "طلبية من عميل بانتظار ربط منتجاتها" : `${count} طلبيات عملاء بانتظار ربط منتجاتها`,
    detail: "اربط منتجات السوق بمنتجاتك لتُخصم من المخزون تلقائياً",
    view: "stockroom",
  };
}

/** The ones the user has not dismissed. */
export function visibleNotifications(all: readonly AppNotification[], dismissed: readonly string[]): AppNotification[] {
  const gone = new Set(dismissed);
  return all.filter((n) => !gone.has(n.id));
}
