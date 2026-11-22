// The "Excel" button of every report table: the same rows as the PDF, written as an .xlsx and saved the
// same way the PDF is (the bytes go to `export_pdf_v3`, which writes them to the Downloads folder).
import { invoke } from "./invoke";
import { buildXlsx, type Cell } from "./xlsx";
import { showSavedToast } from "./pdfExport";
import { formatMoney } from "./money";

export interface ReportTable {
  title: string;
  headers: string[];
  rows: Cell[][];
  /** Columns that hold money: a PDF shows them in the currency's format, Excel keeps them as plain numbers. */
  moneyCols?: number[];
}

/** The rows of a table as the text a PDF prints. */
export function pdfRows(t: ReportTable, fmt: (n: number) => string = formatMoney): string[][] {
  const money = new Set(t.moneyCols ?? []);
  return t.rows.map((r) => r.map((c, i) => (c === null || c === undefined ? "" : typeof c === "number" && money.has(i) ? fmt(c) : String(c))));
}

/** Writes the tables as one .xlsx (one tab per table) and tells the user where it went. */
export async function exportTablesToExcel(filename: string, tables: ReportTable[], sessionToken: string): Promise<void> {
  const bytes = buildXlsx(tables.map((t) => ({ name: t.title, headers: t.headers, rows: t.rows })));
  const saved = await invoke<string>("export_pdf_v3", {
    sessionToken,
    filename: filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`,
    bytes: Array.from(bytes),
  });
  showSavedToast(saved);
}
