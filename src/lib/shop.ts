// Shop helpers: reading a pasted / saved spreadsheet into import rows, turning a scanned
// barcode into "which product, how many pieces or how much weight", and the stock words the
// till shows. Pure functions, no invoke and no DOM -- unit-tested.

import { toLatinDigits } from "./digits";
import { gramsForAmount, parseDecimal, priceForGrams } from "./weight";

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

/** What the till's `import_products_v3` takes (src-tauri/src/stockroom.rs `ImportRow`). */
export interface ImportRow {
  row: number;
  name: string;
  barcode: string | null;
  price_cents: number;
  cost_cents: number | null;
  category: string | null;
  stock: number | null;
  min_stock: number | null;
  sold_by: "unit" | "weight" | null;
}

export interface ImportProblem {
  row: number;
  message: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  /** Lines of the file that could not become a row (they are shown, never silently dropped). */
  problems: ImportProblem[];
  /** The file has no column the till can recognise as the product name or the price. */
  missingColumns: string[];
  /** Header text -> what the till took it for, so the owner can see it understood the file. */
  recognised: { header: string; as: string }[];
}

/** Splits spreadsheet text into cells: commas, semicolons or tabs; quotes may hold the separator or a line break. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const firstLine = src.split("\n", 1)[0] ?? "";
  const counts = { "\t": 0, ";": 0, ",": 0 } as Record<string, number>;
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const delimiter = counts["\t"] > 0 ? "\t" : counts[";"] > counts[","] ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

type Field = "name" | "barcode" | "price" | "cost" | "category" | "stock" | "min_stock" | "sold_by";

const HEADERS: Record<Field, string[]> = {
  name: ["name", "product", "item", "الاسم", "اسم", "الصنف", "اسم الصنف", "المنتج", "اسم المنتج", "المادة", "اسم المادة"],
  barcode: ["barcode", "code", "ean", "sku", "الباركود", "باركود", "الرمز", "رمز"],
  price: ["price", "sell price", "selling price", "السعر", "سعر", "سعر البيع", "سعر المبيع", "المبيع"],
  cost: ["cost", "cost price", "buy price", "purchase price", "التكلفة", "تكلفة", "سعر التكلفة", "سعر الشراء", "الشراء", "التكلفه"],
  category: ["category", "group", "department", "الفئة", "فئة", "التصنيف", "القسم", "المجموعة"],
  stock: ["stock", "quantity", "qty", "on hand", "الكمية", "كمية", "المخزون", "الرصيد", "المتوفر"],
  min_stock: ["min", "min stock", "minimum", "reorder", "الحد الأدنى", "حد الطلب", "الحد الادنى", "أقل كمية"],
  sold_by: ["sold by", "sold_by", "unit", "type", "طريقة البيع", "الوحدة", "نوع البيع", "البيع"],
};

const FIELD_LABEL: Record<Field, string> = {
  name: "اسم الصنف", barcode: "الباركود", price: "سعر البيع", cost: "التكلفة", category: "الفئة", stock: "الكمية", min_stock: "الحد الأدنى", sold_by: "طريقة البيع",
};

function norm(s: string): string {
  return toLatinDigits(s).toLowerCase().replace(/[ـ]/g, "").replace(/[أإآ]/g, "ا").replace(/\s+/g, " ").trim();
}

const NORMALISED: Record<Field, Set<string>> = Object.fromEntries(
  (Object.keys(HEADERS) as Field[]).map((f) => [f, new Set(HEADERS[f].map(norm))]),
) as Record<Field, Set<string>>;

/** A money cell ("1,200", "١٢٠٠", "1 200") as whole units, or null when it is not a number. */
function money(cell: string, scale: number): number | null {
  const v = parseDecimal(toLatinDigits(cell).replace(/[٬,\s]/g, ""));
  return v === null ? null : Math.round(v * 10 ** scale);
}

function soldBy(cell: string): "unit" | "weight" | null | "bad" {
  const v = norm(cell);
  if (v === "") return null;
  if (["weight", "kg", "kilo", "وزن", "كيلو", "كغ", "كيلوغرام", "بالوزن"].includes(v)) return "weight";
  if (["unit", "piece", "pcs", "قطعة", "حبة", "قطع", "عدد", "بالقطعة"].includes(v)) return "unit";
  return "bad";
}

/**
 * Reads the spreadsheet text. The first line is the header (Arabic or English names are
 * recognised); every later line is a product. Prices and costs are in the currency's units
 * and become minor units with `scale` (0 for SYP).
 */
export function readImport(text: string, scale: number): ParsedImport {
  const table = parseCsv(text);
  const result: ParsedImport = { rows: [], problems: [], missingColumns: [], recognised: [] };
  if (table.length === 0) {
    result.missingColumns = [FIELD_LABEL.name, FIELD_LABEL.price];
    return result;
  }
  const header = table[0];
  const col: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    const key = norm(h);
    for (const f of Object.keys(NORMALISED) as Field[]) {
      if (col[f] === undefined && NORMALISED[f].has(key)) {
        col[f] = i;
        result.recognised.push({ header: h.trim(), as: FIELD_LABEL[f] });
      }
    }
  });
  if (col.name === undefined) result.missingColumns.push(FIELD_LABEL.name);
  if (col.price === undefined) result.missingColumns.push(FIELD_LABEL.price);
  if (result.missingColumns.length > 0) return result;

  const cell = (r: string[], f: Field): string => (col[f] === undefined ? "" : (r[col[f] as number] ?? "").trim());
  table.slice(1).forEach((r, idx) => {
    const rowNo = idx + 2;
    const name = cell(r, "name");
    if (name === "") {
      result.problems.push({ row: rowNo, message: "اسم الصنف فارغ" });
      return;
    }
    const price = money(cell(r, "price"), scale);
    if (price === null || price < 0) {
      result.problems.push({ row: rowNo, message: `السعر غير صالح: «${cell(r, "price")}»` });
      return;
    }
    const costText = cell(r, "cost");
    const cost = costText === "" ? null : money(costText, scale);
    if (costText !== "" && (cost === null || cost < 0)) {
      result.problems.push({ row: rowNo, message: `التكلفة غير صالحة: «${costText}»` });
      return;
    }
    const stockText = cell(r, "stock");
    const stock = stockText === "" ? null : parseDecimal(stockText);
    if (stockText !== "" && (stock === null || stock < 0)) {
      result.problems.push({ row: rowNo, message: `الكمية غير صالحة: «${stockText}»` });
      return;
    }
    const minText = cell(r, "min_stock");
    const min = minText === "" ? null : parseDecimal(minText);
    if (minText !== "" && (min === null || min < 0)) {
      result.problems.push({ row: rowNo, message: `الحد الأدنى غير صالح: «${minText}»` });
      return;
    }
    const sb = soldBy(cell(r, "sold_by"));
    if (sb === "bad") {
      result.problems.push({ row: rowNo, message: `طريقة البيع: اكتب قطعة أو وزن (وجدت «${cell(r, "sold_by")}»)` });
      return;
    }
    // Barcodes lose their leading zeros when a spreadsheet saves them as numbers: kept as typed, never altered here.
    const barcode = toLatinDigits(cell(r, "barcode")).replace(/\s+/g, "");
    result.rows.push({ row: rowNo, name, barcode: barcode === "" ? null : barcode, price_cents: price, cost_cents: cost, category: cell(r, "category") || null, stock, min_stock: min, sold_by: sb });
  });
  return result;
}

/** The header and three example lines, tab separated: pastes straight into Excel. */
export const IMPORT_TEMPLATE = [
  ["اسم الصنف", "الباركود", "سعر البيع", "التكلفة", "الفئة", "الكمية", "الحد الأدنى", "طريقة البيع"].join("\t"),
  ["بسكويت", "6281001234567", "1500", "1100", "حلويات ومسليات", "48", "12", "قطعة"].join("\t"),
  ["جبنة بيضاء", "20001", "90000", "65000", "ألبان", "12.5", "3", "وزن"].join("\t"),
  ["شاي", "", "12000", "", "مشروبات", "", "", ""].join("\t"),
].join("\n");

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

/** The shop settings the till needs (they come with the business mode). */
export interface ShopSettings {
  scale_prefix: string;
  scale_plu_digits: number;
  scale_value_digits: number;
  scale_value_kind: "WEIGHT_G" | "PRICE";
  block_sale_when_empty: boolean;
}

export const NO_SHOP_SETTINGS: ShopSettings = { scale_prefix: "", scale_plu_digits: 6, scale_value_digits: 5, scale_value_kind: "WEIGHT_G", block_sale_when_empty: false };

export interface ScanItem {
  id: string;
  name: string;
  price_cents: number;
  barcode: string | null;
  sold_by: "unit" | "weight";
  track_stock?: boolean;
  stock_quantity?: number | null;
  extra_barcodes?: { barcode: string; units: number }[];
}

export type ScanResult<T extends ScanItem = ScanItem> =
  | { kind: "item"; item: T; units: number }
  | { kind: "weighed"; item: T; grams: number; lineCents: number; exactAmountCents?: number }
  | { kind: "none" };

/** Whether the 13 digits are a well-formed EAN-13 (the last digit checks the first twelve). */
export function ean13Ok(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

const stripZeros = (s: string) => s.replace(/^0+/, "");

/**
 * What a scanned code is. A product's own barcode (main or extra) always wins; only a code that is
 * no product's barcode is read as a scale's label (prefix + item code + weight or price).
 */
export function resolveScan<T extends ScanItem>(items: T[], rawCode: string, settings: ShopSettings, scale = 0): ScanResult<T> {
  const code = toLatinDigits(rawCode).trim();
  if (code === "") return { kind: "none" };
  const byMain = items.find((i) => i.barcode === code);
  if (byMain) return { kind: "item", item: byMain, units: 1 };
  for (const i of items) {
    const extra = i.extra_barcodes?.find((b) => b.barcode === code);
    if (extra) return { kind: "item", item: i, units: extra.units };
  }
  const prefix = settings.scale_prefix;
  if (prefix === "" || code.length !== 13 || !code.startsWith(prefix) || !ean13Ok(code)) return { kind: "none" };
  const pluStart = prefix.length;
  const valueStart = pluStart + settings.scale_plu_digits;
  const valueEnd = valueStart + settings.scale_value_digits;
  if (valueEnd > 12) return { kind: "none" };
  const plu = stripZeros(code.slice(pluStart, valueStart));
  const value = Number(code.slice(valueStart, valueEnd));
  if (plu === "" || !Number.isFinite(value) || value <= 0) return { kind: "none" };
  const item = items.find((i) => i.sold_by === "weight" && i.barcode !== null && stripZeros(i.barcode) === plu);
  if (!item) return { kind: "none" };
  if (settings.scale_value_kind === "WEIGHT_G") {
    return { kind: "weighed", item, grams: value, lineCents: priceForGrams(item.price_cents, value) };
  }
  // The scale printed the amount to charge: the weight is what that amount buys.
  void scale;
  const grams = gramsForAmount(item.price_cents, value);
  return grams > 0 ? { kind: "weighed", item, grams, lineCents: value, exactAmountCents: value } : { kind: "none" };
}

/** A kilo or piece figure for display: 12, 2.75. */
export function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000);
}

/** The line to show the cashier when a tracked product's stock does not cover what was just scanned (null when it does). */
export function stockWarning(result: ScanResult, settings: ShopSettings): string | null {
  if (result.kind === "none") return null;
  const item = result.item;
  if (!item.track_stock || item.stock_quantity === undefined || item.stock_quantity === null) return null;
  const need = result.kind === "item" ? result.units : result.grams / 1000;
  if (item.stock_quantity >= need) return null;
  const left = item.stock_quantity <= 0 ? "نفد من المخزون" : `المتوفر ${formatQty(item.stock_quantity)} فقط`;
  return settings.block_sale_when_empty ? `«${item.name}»: ${left}. لن يُسمح بإتمام البيع` : `«${item.name}»: ${left}`;
}
