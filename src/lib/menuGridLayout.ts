/**
 * How many item cards the POS screen puts in one row, and how big each card
 * is drawn at that count.
 *
 * "Auto" (0) is the original grid: as many 180px-minimum cards as fit. An
 * owner with 60-70 items can instead pick a fixed count per row; the cards
 * then shrink to fit it, down to a floor that still leaves a usable tap
 * target -- a narrow screen shows fewer than asked rather than unreadable
 * cards.
 */

export const PRODUCTS_PER_ROW_AUTO = 0;
export const PRODUCTS_PER_ROW_CHOICES = [4, 5, 6, 7, 8, 9, 10] as const;

/** Narrowest card ever drawn; below this the name and price stop fitting. */
export const MIN_CARD_WIDTH_PX = 88;

export type CardDensity = "regular" | "compact" | "mini";

export interface MenuGridLayout {
  /** null = auto-fill (the original 180px-minimum grid). */
  columns: number | null;
  gapPx: number;
  density: CardDensity;
  glyphHeightPx: number;
  iconSizePx: number;
}

export const AUTO_LAYOUT: MenuGridLayout = {
  columns: null,
  gapPx: 12,
  density: "regular",
  glyphHeightPx: 90,
  iconSizePx: 24,
};

/** Accepts only a value the settings picker can produce; anything else is auto. */
export function normalizeProductsPerRow(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && (PRODUCTS_PER_ROW_CHOICES as readonly number[]).includes(n)
    ? n
    : PRODUCTS_PER_ROW_AUTO;
}

export function menuGridLayout(perRow: number, containerWidthPx: number): MenuGridLayout {
  if (perRow <= 0 || containerWidthPx <= 0) return AUTO_LAYOUT;

  const gapPx = perRow >= 7 ? 8 : 12;
  const fits = Math.max(1, Math.floor((containerWidthPx + gapPx) / (MIN_CARD_WIDTH_PX + gapPx)));
  const columns = Math.min(perRow, fits);
  const cardWidthPx = (containerWidthPx - gapPx * (columns - 1)) / columns;

  // Widths at which a 6-digit price and the in-cart stepper still share one
  // row: "- qty +" (regular), "qty -" (compact). Mini cards move the stepper
  // onto the picture and keep the row for the price alone.
  const density: CardDensity = cardWidthPx >= 175 ? "regular" : cardWidthPx >= 125 ? "compact" : "mini";
  // Regular cards keep the original 90px picture, so a count that already
  // fits at full size looks exactly like the auto grid did.
  const glyphHeightPx = Math.min(90, Math.max(50, Math.round(cardWidthPx * 0.55)));
  const iconSizePx = Math.min(24, Math.max(16, Math.round(cardWidthPx * 0.15)));

  return { columns, gapPx, density, glyphHeightPx, iconSizePx };
}
