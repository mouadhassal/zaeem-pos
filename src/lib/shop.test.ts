import { describe, expect, it } from "vitest";
import { ean13Ok, formatQty, IMPORT_TEMPLATE, NO_SHOP_SETTINGS, parseCsv, readImport, resolveScan, stockWarning, type ScanItem, type ShopSettings } from "./shop";

describe("parseCsv", () => {
  it("reads commas, semicolons and tabs, quotes and a leading BOM", () => {
    expect(parseCsv("﻿a,b,c\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\r\n1\t2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('name,price\n"Cheese, white",90000\n"say ""hi""",1')).toEqual([["name", "price"], ["Cheese, white", "90000"], ['say "hi"', "1"]]);
  });
  it("drops empty lines", () => {
    expect(parseCsv("a,b\n\n,\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("readImport", () => {
  it("understands an Arabic header and Arabic digits, and the template itself", () => {
    const r = readImport("الاسم\tالباركود\tسعر البيع\tالتكلفة\tالفئة\tالكمية\tالحد الأدنى\tطريقة البيع\nبسكويت\t٦٠٠١\t١٥٠٠\t1,100\tحلويات\t٤٨\t١٢\tقطعة\nجبنة\t20001\t90000\t\tألبان\t12.5\t\tوزن", 0);
    expect(r.missingColumns).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.rows[0]).toEqual({ row: 2, name: "بسكويت", barcode: "6001", price_cents: 1500, cost_cents: 1100, category: "حلويات", stock: 48, min_stock: 12, sold_by: "unit" });
    expect(r.rows[1]).toMatchObject({ barcode: "20001", price_cents: 90000, cost_cents: null, stock: 12.5, min_stock: null, sold_by: "weight" });
    const t = readImport(IMPORT_TEMPLATE, 0);
    expect(t.problems).toEqual([]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[2]).toMatchObject({ name: "شاي", barcode: null, stock: null });
  });

  it("recognises English headers and applies the currency scale", () => {
    const r = readImport("Name,Barcode,Price,Cost,Qty\nSoap,111,2.50,1.20,10", 2);
    expect(r.rows[0]).toMatchObject({ name: "Soap", price_cents: 250, cost_cents: 120, stock: 10 });
    expect(r.recognised.map((x) => x.as)).toEqual(["اسم الصنف", "الباركود", "سعر البيع", "التكلفة", "الكمية"]);
  });

  it("says which required columns are missing instead of guessing", () => {
    expect(readImport("foo,bar\n1,2", 0).missingColumns).toEqual(["اسم الصنف", "سعر البيع"]);
    expect(readImport("", 0).missingColumns).toEqual(["اسم الصنف", "سعر البيع"]);
    expect(readImport("الاسم\nx", 0).missingColumns).toEqual(["سعر البيع"]);
  });

  it("lists each bad line with its row number and the reason, and keeps the good ones", () => {
    const r = readImport("الاسم,السعر,الكمية,طريقة البيع\nA,100,5,\n,100,,\nB,abc,,\nC,100,-2,\nD,100,,لتر\nE,200,3,وزن", 0);
    expect(r.rows.map((x) => x.name)).toEqual(["A", "E"]);
    expect(r.problems.map((p) => p.row)).toEqual([3, 4, 5, 6]);
    expect(r.problems[0].message).toContain("اسم");
    expect(r.problems[1].message).toContain("السعر");
    expect(r.problems[2].message).toContain("الكمية");
    expect(r.problems[3].message).toContain("طريقة البيع");
  });

  it("never changes a barcode (leading zeros stay)", () => {
    expect(readImport("الاسم,الباركود,السعر\nX,0012345,10", 0).rows[0].barcode).toBe("0012345");
  });
});

describe("barcodes", () => {
  it("checks EAN-13", () => {
    expect(ean13Ok("4006381333931")).toBe(true);
    expect(ean13Ok("4006381333932")).toBe(false);
    expect(ean13Ok("12345")).toBe(false);
  });

  const items: ScanItem[] = [
    { id: "p1", name: "Biscuits", price_cents: 500, barcode: "6001", sold_by: "unit", track_stock: true, stock_quantity: 3, extra_barcodes: [{ barcode: "CARTON-12", units: 12 }] },
    { id: "p2", name: "Cheese", price_cents: 90000, barcode: "00123", sold_by: "weight", track_stock: true, stock_quantity: 0.4 },
    { id: "p3", name: "Tea", price_cents: 1200, barcode: null, sold_by: "unit" },
  ];
  const scale: ShopSettings = { ...NO_SHOP_SETTINGS, scale_prefix: "2", scale_plu_digits: 6, scale_value_digits: 5, scale_value_kind: "WEIGHT_G" };
  const label = (plu: string, value: string, prefix = "2") => {
    const body = `${prefix}${plu}${value}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
    return body + String((10 - (sum % 10)) % 10);
  };

  it("finds a product by its main barcode or an extra one with its pieces", () => {
    expect(resolveScan(items, "6001", NO_SHOP_SETTINGS)).toMatchObject({ kind: "item", units: 1 });
    expect(resolveScan(items, "CARTON-12", NO_SHOP_SETTINGS)).toMatchObject({ kind: "item", units: 12 });
    expect(resolveScan(items, "٦٠٠١", NO_SHOP_SETTINGS)).toMatchObject({ kind: "item" });
    expect(resolveScan(items, "nope", NO_SHOP_SETTINGS)).toEqual({ kind: "none" });
    expect(resolveScan(items, "  ", NO_SHOP_SETTINGS)).toEqual({ kind: "none" });
  });

  it("reads a scale's label by weight", () => {
    const r = resolveScan(items, label("000123", "00750"), scale);
    expect(r).toMatchObject({ kind: "weighed", grams: 750, lineCents: 67500 });
    expect(r.kind === "weighed" && r.item.id).toBe("p2");
  });

  it("reads a scale's label by price: the weight is what that amount buys", () => {
    const priced: ShopSettings = { ...scale, scale_value_kind: "PRICE" };
    const r = resolveScan(items, label("000123", "45000"), priced);
    expect(r).toMatchObject({ kind: "weighed", grams: 500, lineCents: 45000, exactAmountCents: 45000 });
  });

  it("ignores scale labels when the scale is off, the check digit is wrong, or the product is not weighed", () => {
    expect(resolveScan(items, label("000123", "00750"), NO_SHOP_SETTINGS)).toEqual({ kind: "none" });
    const bad = label("000123", "00750").slice(0, 12) + "9";
    expect(resolveScan(items, bad, scale)).toEqual({ kind: "none" });
    expect(resolveScan(items, label("009999", "00750"), scale)).toEqual({ kind: "none" });
    expect(resolveScan(items, label("000123", "00000"), scale)).toEqual({ kind: "none" });
  });

  it("a product's own barcode always beats the scale reading", () => {
    const own: ScanItem[] = [{ id: "x", name: "Own", price_cents: 100, barcode: "2000000000008", sold_by: "unit" }];
    expect(resolveScan(own, "2000000000008", scale)).toMatchObject({ kind: "item", units: 1 });
  });
});

describe("stockWarning", () => {
  const items: ScanItem[] = [
    { id: "p1", name: "Biscuits", price_cents: 500, barcode: "6001", sold_by: "unit", track_stock: true, stock_quantity: 3, extra_barcodes: [{ barcode: "CARTON-12", units: 12 }] },
    { id: "p3", name: "Tea", price_cents: 1200, barcode: "6003", sold_by: "unit" },
    { id: "p4", name: "Soap", price_cents: 800, barcode: "6004", sold_by: "unit", track_stock: true, stock_quantity: 0 },
  ];
  it("warns only for a tracked product the stock does not cover", () => {
    expect(stockWarning(resolveScan(items, "6001", NO_SHOP_SETTINGS), NO_SHOP_SETTINGS)).toBeNull();
    expect(stockWarning(resolveScan(items, "CARTON-12", NO_SHOP_SETTINGS), NO_SHOP_SETTINGS)).toContain("المتوفر 3 فقط");
    expect(stockWarning(resolveScan(items, "6003", NO_SHOP_SETTINGS), NO_SHOP_SETTINGS)).toBeNull();
    expect(stockWarning(resolveScan(items, "6004", NO_SHOP_SETTINGS), NO_SHOP_SETTINGS)).toContain("نفد");
    expect(stockWarning({ kind: "none" }, NO_SHOP_SETTINGS)).toBeNull();
  });
  it("says the sale will be refused when the owner chose that", () => {
    const strict = { ...NO_SHOP_SETTINGS, block_sale_when_empty: true };
    expect(stockWarning(resolveScan(items, "6004", strict), strict)).toContain("لن يُسمح");
  });
  it("formats quantities", () => {
    expect(formatQty(12)).toBe("12");
    expect(formatQty(2.75)).toBe("2.75");
    expect(formatQty(0.1 + 0.2)).toBe("0.3");
  });
});
