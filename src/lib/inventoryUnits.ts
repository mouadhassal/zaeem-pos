// Units of measure for ingredients. Mirrors src-tauri/src/inventory_ops.rs (`canonical_code`, the
// `units` table: g=1, kg=1000 | ml=1, l=1000 | piece=1). The server does the real conversion and
// refuses a unit of another kind; this only builds the pickers and previews.

export type UnitKind = "MASS" | "VOLUME" | "COUNT";

export interface UnitDef {
  code: string;
  name_ar: string;
  kind: UnitKind;
  factor: number;
}

export interface IngredientPack {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  stock_unit: string;
  name_ar: string;
  factor_to_stock_unit: number;
}

export const STANDARD_UNITS: UnitDef[] = [
  { code: "g", name_ar: "غرام", kind: "MASS", factor: 1 },
  { code: "kg", name_ar: "كيلوغرام", kind: "MASS", factor: 1000 },
  { code: "ml", name_ar: "مل", kind: "VOLUME", factor: 1 },
  { code: "l", name_ar: "لتر", kind: "VOLUME", factor: 1000 },
  { code: "piece", name_ar: "حبة", kind: "COUNT", factor: 1 },
];

export const KIND_LABEL: Record<UnitKind, string> = { MASS: "وزن", VOLUME: "حجم", COUNT: "عدد" };

/** Short list a waste entry must pick from (same as inventory_ops::WASTE_REASONS). */
export const WASTE_REASONS = ["تالف", "منتهي الصلاحية", "انسكاب", "أخرى"] as const;

const ALIASES: Record<string, string> = {};
for (const [code, words] of Object.entries({
  kg: ["kg", "كغ", "كغم", "كجم", "كيلو", "كيلوغرام", "كيلوجرام", "كلغ"],
  g: ["g", "gr", "gram", "غ", "غرام", "جرام", "جم", "غم"],
  l: ["l", "lt", "liter", "litre", "ل", "لتر", "ليتر"],
  ml: ["ml", "مل", "ملل", "ميلي", "مليلتر"],
  piece: ["piece", "pieces", "pcs", "pc", "unit", "قطعة", "حبة", "حبه", "قطع", "وحدة"],
})) {
  for (const w of words) ALIASES[w] = code;
}

/** The code of a standard unit for text people typed, or null when it is not obviously one. */
export function canonicalUnit(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim().toLowerCase().replace(/\.+$/, "");
  return ALIASES[t] ?? null;
}

function def(text: string | null | undefined): UnitDef | null {
  const code = canonicalUnit(text);
  return code ? STANDARD_UNITS.find((u) => u.code === code) ?? null : null;
}

/** What to show for a stored unit: the Arabic name of a standard unit, anything else as it is. */
export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return def(unit)?.name_ar ?? unit;
}

export function unitKind(unit: string | null | undefined): UnitKind | null {
  return def(unit)?.kind ?? null;
}

/** The units a recipe/purchase line of an ingredient kept in `stockUnit` may use: its own unit,
 *  the other standard units of the same kind, then its packs. `value` "" means the stock unit. */
export function unitChoices(stockUnit: string, packs: { name_ar: string; factor_to_stock_unit: number }[]): { value: string; label: string }[] {
  const own = def(stockUnit);
  const out: { value: string; label: string }[] = [{ value: "", label: unitLabel(stockUnit) }];
  if (own) {
    for (const u of STANDARD_UNITS) {
      if (u.kind === own.kind && u.code !== own.code) out.push({ value: u.code, label: u.name_ar });
    }
  }
  for (const p of packs) {
    out.push({ value: p.name_ar, label: `${p.name_ar} (${trimNum(p.factor_to_stock_unit)} ${unitLabel(stockUnit)})` });
  }
  return out;
}

/** Multiplier from `from` to `to` when both are standard units of one kind, else null. */
export function unitFactor(from: string, to: string): number | null {
  const f = def(from);
  const t = def(to);
  if (!f || !t) return from.trim() === to.trim() ? 1 : null;
  if (f.code === t.code) return 1;
  return f.kind === t.kind ? f.factor / t.factor : null;
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function trimNum(x: number): string {
  return String(round3(x));
}

/** The pack factor of a unit choice (a pack name), a standard-unit ratio, or 1 for the stock unit. */
export function choiceFactor(choice: string, stockUnit: string, packs: { name_ar: string; factor_to_stock_unit: number }[]): number | null {
  if (!choice) return 1;
  const pack = packs.find((p) => p.name_ar === choice);
  if (pack) return pack.factor_to_stock_unit;
  return unitFactor(choice, stockUnit);
}

/** On hand x average cost; a negative balance counts as 0 (same as the server). */
export function stockValue(onHand: number, avgCostCents: number): number {
  return Math.round(Math.max(onHand, 0) * avgCostCents);
}

/** actual / expected as a percentage with one decimal; 0 when nothing was expected. */
export function yieldPct(expected: number, actual: number): number {
  return expected > 0 ? Math.round((actual / expected) * 1000) / 10 : 0;
}

/** Cost of one batch from its lines: quantity (in the line's unit) converted to the component's unit x its cost. */
export function batchCost(
  lines: { quantity: number; unit: string; stockUnit: string; costCents: number; packs?: { name_ar: string; factor_to_stock_unit: number }[] }[],
): number {
  let total = 0;
  for (const l of lines) {
    const f = choiceFactor(l.unit, l.stockUnit, l.packs ?? []) ?? 0;
    total += l.quantity * f * l.costCents;
  }
  return Math.round(total);
}

/** "YYYY-MM-DD" .. "YYYY-MM-DD" (both days included, local time) as the [start, end) ISO instants the reports take. */
export function dayRangeIso(from: string, to: string): [string, string] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return [new Date(fy, fm - 1, fd).toISOString(), new Date(ty, tm - 1, td + 1).toISOString()];
}

/** Local "YYYY-MM-DD" of a date. */
export function ymd(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
