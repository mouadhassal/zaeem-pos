// Items sold by weight ("give me 10,000 of shawarma", "285 g of kibbeh").
//
// A weighed item's menu price is the price of ONE KILOGRAM. The till rings up a
// portion by weight (grams) or by the amount the customer asked for; the Rust
// side (src-tauri/src/weighing.rs) re-prices every line and refuses an amount
// that does not belong to its weight, so nothing here is trusted for money. The
// rounding below is the same as Rust's so the two always agree.

export const MAX_GRAMS = 50_000;

/** Price of `grams` at `pricePerKgCents` per kilogram, half rounded up. */
export function priceForGrams(pricePerKgCents: number, grams: number): number {
  return Math.floor((pricePerKgCents * grams + 500) / 1000);
}

/** The whole gram that `amountCents` buys, half rounded up. 0 when there is no price or amount. */
export function gramsForAmount(pricePerKgCents: number, amountCents: number): number {
  if (pricePerKgCents <= 0 || amountCents <= 0) return 0;
  return Math.floor((amountCents * 2000 + pricePerKgCents) / (2 * pricePerKgCents));
}

/** "285 غ" / "1 كغ" / "1.25 كغ". */
export function formatWeight(grams: number): string {
  if (grams < 1000) return `${grams} غ`;
  if (grams % 1000 === 0) return `${grams / 1000} كغ`;
  return `${(grams / 1000).toFixed(3).replace(/0+$/, "")} كغ`;
}

/** The name as a slip or receipt prints it: "شاورما — 285 غ". Piece lines are untouched. */
export function nameWithWeight(name: string, weightGrams: number | null | undefined): string {
  return weightGrams ? `${name} — ${formatWeight(weightGrams)}` : name;
}

/** Arabic-Indic and Persian digits, and the Arabic decimal/comma marks, to plain ASCII. */
function asciiNumber(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,،]/g, ".")
    .trim();
}

/** What the cashier typed as a decimal number, or null when it is not one. */
export function parseDecimal(text: string): number | null {
  const t = asciiNumber(text);
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Kilograms typed by the cashier ("0.285") as whole grams. Null when not a number. */
export function gramsFromKgText(text: string): number | null {
  const kg = parseDecimal(text);
  return kg === null ? null : Math.round(kg * 1000);
}

/** Currency units typed by the cashier as minor units (cents) at the given scale (0 for SYP). */
export function amountFromText(text: string, scale: number): number | null {
  const v = parseDecimal(text);
  return v === null ? null : Math.round(v * 10 ** scale);
}

export type WeighMode = "amount" | "weight";

export interface WeighResult {
  grams: number;
  lineCents: number;
  /** Set when the customer asked for an exact amount: the server will charge exactly this. */
  exactAmountCents?: number;
}

/**
 * Turns what the cashier typed into a weighed portion, or an Arabic reason it
 * cannot be sold. `scale` is the currency's decimals (0 for SYP).
 */
export function resolveWeighing(
  mode: WeighMode,
  text: string,
  pricePerKgCents: number,
  scale: number
): { ok: true; value: WeighResult } | { ok: false; reason: string } {
  if (pricePerKgCents <= 0) return { ok: false, reason: "لا يوجد سعر للكيلو لهذا الصنف" };
  if (mode === "weight") {
    const grams = gramsFromKgText(text);
    if (grams === null) return { ok: false, reason: "اكتب الوزن بالكيلو، مثلاً 0.285" };
    if (grams <= 0) return { ok: false, reason: "الوزن يجب أن يكون أكبر من صفر" };
    if (grams > MAX_GRAMS) return { ok: false, reason: `الوزن كبير جداً (الحد ${MAX_GRAMS / 1000} كغ)` };
    return { ok: true, value: { grams, lineCents: priceForGrams(pricePerKgCents, grams) } };
  }
  const amount = amountFromText(text, scale);
  if (amount === null) return { ok: false, reason: "اكتب المبلغ الذي طلبه الزبون" };
  if (amount <= 0) return { ok: false, reason: "المبلغ يجب أن يكون أكبر من صفر" };
  const grams = gramsForAmount(pricePerKgCents, amount);
  if (grams <= 0) return { ok: false, reason: "المبلغ صغير جداً: لا يكفي لغرام واحد" };
  if (grams > MAX_GRAMS) return { ok: false, reason: `المبلغ كبير جداً (الحد ${MAX_GRAMS / 1000} كغ)` };
  return { ok: true, value: { grams, lineCents: amount, exactAmountCents: amount } };
}
