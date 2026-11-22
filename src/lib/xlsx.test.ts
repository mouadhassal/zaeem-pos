import { describe, expect, it } from "vitest";
import { buildXlsx, columnName, crc32, sheetName, xmlText } from "./xlsx";

/** Reads back the files of a stored zip, checking each CRC on the way. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    files[name] = new TextDecoder().decode(data);
    at += 46 + nameLen;
  }
  return files;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("helpers", () => {
  it("escapes XML and drops control characters", () => {
    expect(xmlText('a<b>&"c')).toBe("a&lt;b&gt;&amp;&quot;c");
    expect(xmlText("x\u0001y")).toBe("xy");
  });
  it("names columns like a spreadsheet", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(27)).toBe("AB");
  });
  it("makes sheet names Excel accepts and unique", () => {
    const used = new Set<string>();
    expect(sheetName("المبيعات / الساعة: [1]", used)).toBe("المبيعات الساعة 1");
    expect(sheetName("المبيعات الساعة 1", used)).toBe("المبيعات الساعة 1 2");
    expect(sheetName("", used)).toBe("Sheet");
    expect(sheetName("x".repeat(40), used).length).toBe(31);
  });
});

describe("buildXlsx", () => {
  const bytes = buildXlsx([
    { name: "المبيعات", headers: ["الصنف", "الكمية", "السعر"], rows: [["برغر <كبير>", 3, 4500.5], ["كولا & شاي", 12, null], ["=1+1", 0, 10]] },
    { name: "الزبائن", headers: ["الاسم"], rows: [["سعاد"]] },
  ]);
  const files = unzip(bytes);

  it("is a zip with the parts Excel needs", () => {
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("is right to left, with the Arabic sheet names", () => {
    expect(files["xl/worksheets/sheet1.xml"]).toContain('rightToLeft="1"');
    expect(files["xl/workbook.xml"]).toContain('<sheet name="المبيعات" sheetId="1" r:id="rId1"/>');
    expect(files["xl/workbook.xml"]).toContain('<sheet name="الزبائن" sheetId="2" r:id="rId2"/>');
  });

  it("writes numbers as numbers, text as escaped inline text, and never a formula", () => {
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<c r="B2" s="2"><v>3</v></c>');
    expect(sheet).toContain('<c r="C2"><v>4500.5</v></c>');
    expect(sheet).toContain("برغر &lt;كبير&gt;");
    expect(sheet).toContain("كولا &amp; شاي");
    expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t xml:space="preserve">=1+1</t></is></c>');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
  });

  it("copes with no sheets and empty tables", () => {
    expect(Object.keys(unzip(buildXlsx([]))).length).toBe(6);
    expect(unzip(buildXlsx([{ name: "x", headers: ["a"], rows: [] }]))["xl/worksheets/sheet1.xml"]).toContain('<row r="1">');
  });
});
