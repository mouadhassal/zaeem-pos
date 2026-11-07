/**
 * Per-till preferences: how the till looks and which questions it asks.
 *
 * Every restaurant works differently (one wants a reason for each cancelled
 * item, another has no time for it), so each of these is a switch or a size
 * the owner picks in Settings > التفضيلات والتصميم. They are screen/behaviour
 * choices of one device, not shop data, so they live in this device's
 * localStorage (same as the products-per-row tiles).
 *
 * Pure functions here; the zustand store in stores/prefsStore.ts persists.
 */

export type OrderPanelSize = "comfortable" | "compact" | "tiny";
export type DeliveryCardSize = "large" | "medium" | "small";
export type PriceEditMode = "off" | "manager" | "everyone";
/** "list": every option as a button; "table": two big buttons, Without and With, each opening its own list. */
export type OptionsLayout = "list" | "table";

export const PICKUP_CHOICE_MINUTES = [0, 10, 15, 20, 30, 45, 60, 90] as const;
export const QUANTITY_STEPS = [0, 2, 3, 5, 10] as const;

export interface Prefs {
  /** How tall the order lines in the side panel are. */
  orderPanelSize: OrderPanelSize;
  /** How big each order card is on the delivery page. */
  deliveryCardSize: DeliveryCardSize;
  /** Pickup quick choices in minutes; 0 = "now, straight to the kitchen". */
  pickupChoices: number[];
  /** Ask for the customer's name on a pickup order. Off: "زبون" is used. */
  pickupNameRequired: boolean;
  /** How the options of an item (without onion, extra cheese) are shown. */
  optionsLayout: OptionsLayout;
  /** An extra "+N" button on every order line; 0 = hidden. */
  quantityStep: number;
  /** Tap the quantity to type it (10 burgers: type 10). */
  quantityTyping: boolean;
  /** Ask why when an item is removed from the order. */
  askVoidReason: boolean;
  /** Ask why when a whole order is cancelled. */
  askCancelOrderReason: boolean;
  /** Ask "are you sure" before cancelling a whole order. */
  confirmCancelOrder: boolean;
  /** Who may change the price of a line on the order. */
  priceEdit: PriceEditMode;
  /** The bill shows a generic word for drinks instead of the drink's name. */
  drinkLabelOn: boolean;
  drinkLabel: string;
  /** Names of the menu categories whose items print as the generic drink word. */
  drinkCategories: string[];
  /** A reprinted bill says "نسخة" (copy) at the top. */
  reprintCopyMark: boolean;
  /** Local-currency amount that equals 1 US dollar (0 = dollar entry off). */
  usdRate: number;
  /** This shop is a supplier (a shop that also sells through the marketplace): the market link is front and centre. */
  supplierMode: boolean;
  /** Goods bought on the marketplace go into the stock by themselves when every line is certain. */
  marketAutoReceive: boolean;
  /** A supplier's accepted marketplace orders leave the POS stock by themselves when every product is linked. */
  marketAutoApply: boolean;
  /** Notify when a stock-tracked product is running low. */
  notifyLowStock: boolean;
  /** Notify when a shift has been open for a long time. */
  notifyLongShift: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  orderPanelSize: "comfortable",
  deliveryCardSize: "large",
  pickupChoices: [0, 15, 20, 30, 45, 60],
  pickupNameRequired: true,
  optionsLayout: "list",
  quantityStep: 0,
  quantityTyping: true,
  askVoidReason: true,
  askCancelOrderReason: true,
  confirmCancelOrder: true,
  priceEdit: "manager",
  drinkLabelOn: false,
  drinkLabel: "مشروب",
  drinkCategories: [],
  reprintCopyMark: true,
  usdRate: 0,
  supplierMode: false,
  marketAutoReceive: true,
  marketAutoApply: true,
  notifyLowStock: true,
  notifyLongShift: true,
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Reads whatever was stored (possibly old, partial or hand-edited) into a valid Prefs. */
export function normalizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const choices = Array.isArray(r.pickupChoices)
    ? [...new Set(r.pickupChoices.filter((m): m is number => typeof m === "number" && (PICKUP_CHOICE_MINUTES as readonly number[]).includes(m)))].sort((a, b) => a - b)
    : DEFAULT_PREFS.pickupChoices;
  const step = typeof r.quantityStep === "number" && (QUANTITY_STEPS as readonly number[]).includes(r.quantityStep) ? r.quantityStep : DEFAULT_PREFS.quantityStep;
  const rate = typeof r.usdRate === "number" && Number.isFinite(r.usdRate) && r.usdRate > 0 ? r.usdRate : 0;
  const label = typeof r.drinkLabel === "string" && r.drinkLabel.trim() ? r.drinkLabel.trim().slice(0, 30) : DEFAULT_PREFS.drinkLabel;
  return {
    orderPanelSize: oneOf(r.orderPanelSize, ["comfortable", "compact", "tiny"], DEFAULT_PREFS.orderPanelSize),
    deliveryCardSize: oneOf(r.deliveryCardSize, ["large", "medium", "small"], DEFAULT_PREFS.deliveryCardSize),
    pickupChoices: choices,
    pickupNameRequired: bool(r.pickupNameRequired, DEFAULT_PREFS.pickupNameRequired),
    optionsLayout: oneOf(r.optionsLayout, ["list", "table"], DEFAULT_PREFS.optionsLayout),
    quantityStep: step,
    quantityTyping: bool(r.quantityTyping, DEFAULT_PREFS.quantityTyping),
    askVoidReason: bool(r.askVoidReason, DEFAULT_PREFS.askVoidReason),
    askCancelOrderReason: bool(r.askCancelOrderReason, DEFAULT_PREFS.askCancelOrderReason),
    confirmCancelOrder: bool(r.confirmCancelOrder, DEFAULT_PREFS.confirmCancelOrder),
    priceEdit: oneOf(r.priceEdit, ["off", "manager", "everyone"], DEFAULT_PREFS.priceEdit),
    drinkLabelOn: bool(r.drinkLabelOn, DEFAULT_PREFS.drinkLabelOn),
    drinkLabel: label,
    drinkCategories: Array.isArray(r.drinkCategories) ? r.drinkCategories.filter((c): c is string => typeof c === "string") : [],
    reprintCopyMark: bool(r.reprintCopyMark, DEFAULT_PREFS.reprintCopyMark),
    usdRate: rate,
    supplierMode: bool(r.supplierMode, DEFAULT_PREFS.supplierMode),
    marketAutoReceive: bool(r.marketAutoReceive, DEFAULT_PREFS.marketAutoReceive),
    marketAutoApply: bool(r.marketAutoApply, DEFAULT_PREFS.marketAutoApply),
    notifyLowStock: bool(r.notifyLowStock, DEFAULT_PREFS.notifyLowStock),
    notifyLongShift: bool(r.notifyLongShift, DEFAULT_PREFS.notifyLongShift),
  };
}

/** Label of a pickup quick choice. */
export function pickupChoiceLabel(minutes: number): string {
  return minutes === 0 ? "فوراً" : `بعد ${minutes} د`;
}

/**
 * Typed text -> a quantity. Accepts Arabic-Indic digits; 1..999 whole units
 * (the cart never goes below one: removing a line is a different button).
 */
export function parseTypedQuantity(text: string): number | null {
  const ascii = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .trim();
  if (!/^\d{1,3}$/.test(ascii)) return null;
  const n = Number(ascii);
  return n >= 1 ? n : null;
}

/** Dollars typed -> local-currency minor units, using the owner's rate. */
export function usdToLocalMinor(usd: number, rate: number, minorPerMajor: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round(usd * rate * minorPerMajor);
}

/** What a bill line is called: the generic drink word for chosen categories, else the real name. */
export function billItemName(name: string, categoryName: string, prefs: Pick<Prefs, "drinkLabelOn" | "drinkLabel" | "drinkCategories">): string {
  if (!prefs.drinkLabelOn) return name;
  return prefs.drinkCategories.includes(categoryName) ? prefs.drinkLabel : name;
}
