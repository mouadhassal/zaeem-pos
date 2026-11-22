import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BILL_FOOTER,
  DEFAULT_TEMPLATE_CONFIG,
  kitchenTicketRows,
  parseTemplateConfig,
  receiptRows,
  rowsText,
  type TemplateConfig,
} from "./ticketLayout";
import { SAMPLE_NOW, SAMPLE_RECEIPTS, SAMPLE_TICKETS } from "./ticketLayout.samples";

const GOLDEN_PATH = fileURLToPath(new URL("./ticketLayout.golden.json", import.meta.url));
// Git on Windows may check the file out with CRLF; compare content, not line endings.
const GOLDEN_TEXT = readFileSync(GOLDEN_PATH, "utf8").replace(/\r\n/g, "\n");

const render = (template?: TemplateConfig) =>
  JSON.stringify(
    { receipts: SAMPLE_RECEIPTS.map((r) => receiptRows(r, SAMPLE_NOW, template)), tickets: SAMPLE_TICKETS.map((t) => kitchenTicketRows(t, SAMPLE_NOW, template)) },
    null,
    1,
  );

describe("a printer with no template prints exactly as before templates existed", () => {
  it("no template = the rows of the layout before templates (byte for byte)", () => {
    expect(render()).toBe(GOLDEN_TEXT);
  });

  it("the default template config changes nothing", () => {
    expect(render(DEFAULT_TEMPLATE_CONFIG)).toBe(GOLDEN_TEXT);
    expect(render(parseTemplateConfig({}))).toBe(GOLDEN_TEXT);
    expect(render(parseTemplateConfig(null))).toBe(GOLDEN_TEXT);
    expect(render(parseTemplateConfig("garbage"))).toBe(GOLDEN_TEXT);
  });

  it("writing the usual thank-you lines out as a footer prints the same bill", () => {
    const explicit = parseTemplateConfig({ footer_lines: DEFAULT_BILL_FOOTER });
    const withFooter = SAMPLE_RECEIPTS.map((r) => JSON.stringify(receiptRows(r, SAMPLE_NOW, explicit)));
    const plain = SAMPLE_RECEIPTS.map((r) => JSON.stringify(receiptRows(r, SAMPLE_NOW)));
    expect(withFooter).toEqual(plain);
  });
});

const text = (rows: ReturnType<typeof receiptRows>) => rowsText(rows).join("\n");
const bill = SAMPLE_RECEIPTS[0]!;
const slip = SAMPLE_TICKETS[0]!;

describe("receipt templates", () => {
  it("adds header lines under the shop name and replaces the footer", () => {
    const t = parseTemplateConfig({ header_lines: ["هاتف 011-000", "  "], footer_lines: ["نراكم قريباً"] });
    const lines = rowsText(receiptRows(bill, SAMPLE_NOW, t));
    expect(lines[0]).toBe(bill.chainName);
    expect(lines).toContain("هاتف 011-000");
    expect(lines.indexOf("هاتف 011-000")).toBeLessThan(lines.indexOf("رقم الطلب"));
    expect(lines).toContain("نراكم قريباً");
    expect(lines).not.toContain("شكراً لزيارتكم");
  });

  it("an empty footer list means no footer at all", () => {
    const lines = rowsText(receiptRows(bill, SAMPLE_NOW, parseTemplateConfig({ footer_lines: [] })));
    expect(lines).not.toContain("شكراً لزيارتكم");
  });

  it("hides what the owner switched off, and nothing else", () => {
    const off = parseTemplateConfig({ show_order_number: false, show_table: false, show_cashier: false, show_customer: false, show_tax_line: false, show_item_notes: false });
    const delivery = SAMPLE_RECEIPTS[1]!;
    const t = text(receiptRows(delivery, SAMPLE_NOW, off));
    for (const gone of ["رقم الطلب", "الكاشير", "العميل", "الهاتف", "العنوان", "ضريبة", "ملاحظة"]) expect(t).not.toContain(gone);
    expect(t).toContain("الإجمالي");
    expect(t).toContain("2 × شاورما دجاج");
    const full = text(receiptRows(delivery, SAMPLE_NOW));
    for (const kept of ["رقم الطلب", "الكاشير", "العميل", "الهاتف", "العنوان", "الضريبة", "ملاحظة"]) expect(full).toContain(kept);
    expect(text(receiptRows(bill, SAMPLE_NOW, off))).not.toContain("طاولة");
  });

  it("scales every size with the font choice and leaves the layout alone", () => {
    const sizes = (font: "small" | "normal" | "large") =>
      receiptRows(bill, SAMPLE_NOW, parseTemplateConfig({ font_size: font })).flatMap((r) => (r.t === "line" || r.t === "two" ? [r.size ?? 26] : []));
    const normal = sizes("normal");
    expect(sizes("small").every((s, i) => s < normal[i]!)).toBe(true);
    expect(sizes("large").every((s, i) => s > normal[i]!)).toBe(true);
    expect(sizes("small")).toHaveLength(normal.length);
  });

  it("kitchen slip: switches, header and footer", () => {
    const t = parseTemplateConfig({ header_lines: ["مطبخ رئيسي"], footer_lines: ["--"], show_order_number: false, show_table: false, show_cashier: false, show_customer: false, show_item_notes: false });
    const lines = text(kitchenTicketRows(slip, SAMPLE_NOW, t));
    expect(lines).toContain("مطبخ رئيسي");
    expect(lines).toContain("--");
    for (const gone of ["رقم الطلب", "طاولة", "الكاشير", "العميل", "ملاحظة"]) expect(lines).not.toContain(gone);
    expect(lines).toContain("◂ بدون بصل");
    const plain = text(kitchenTicketRows(slip, SAMPLE_NOW));
    expect(plain).toContain("ملاحظة: حار");
    expect(plain).not.toContain("--");
  });

  it("reads a stored config defensively", () => {
    expect(parseTemplateConfig({ copies: 9 }).copies).toBe(3);
    expect(parseTemplateConfig({ copies: 0 }).copies).toBe(1);
    expect(parseTemplateConfig({ copies: "2" }).copies).toBe(1);
    expect(parseTemplateConfig({ font_size: "huge" }).font_size).toBe("normal");
    expect(parseTemplateConfig({ show_tax_line: "no" }).show_tax_line).toBe(true);
    expect(parseTemplateConfig({ header_lines: [1, " x "] }).header_lines).toEqual(["x"]);
  });
});
