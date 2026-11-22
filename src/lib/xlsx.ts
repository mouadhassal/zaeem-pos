// A small .xlsx writer with no dependencies: an Excel file is a zip of a few XML files, and a zip may
// hold its files uncompressed ("stored"), so all this needs is the CRC-32 the zip format asks for.
// Sheets are right-to-left (Arabic opens the right way round), text is written as inline strings (UTF-8),
// numbers as real numbers so Excel can sum and sort them.

export type Cell = string | number | null | undefined;

export interface Sheet {
  /** The tab's name; Excel allows 31 characters and none of  [ ] : * ? / \ . */
  name: string;
  headers: string[];
  rows: Cell[][];
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Escapes text for XML and drops the control characters XML 1.0 cannot hold. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A valid, unique sheet name. */
export function sheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` ${i++}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function cellXml(ref: string, value: Cell, style: number): string {
  if (value === null || value === undefined || value === "") return style ? `<c r="${ref}" s="${style}"/>` : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    const s = style || (Number.isInteger(value) ? 2 : 0);
    return `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlText(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const all: Cell[][] = [sheet.headers, ...sheet.rows];
  const widths = sheet.headers.map((_, c) => {
    let w = 8;
    for (const row of all) {
      const v = row[c];
      const len = v === null || v === undefined ? 0 : typeof v === "number" ? String(v).length + 2 : [...String(v)].length;
      w = Math.max(w, len + 2);
    }
    return Math.min(w, 60);
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = all
    .map((row, r) => {
      const cells = sheet.headers.map((_, c) => cellXml(`${columnName(c)}${r + 1}`, row[c], r === 0 ? 1 : 0)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`
  );
}

const STYLES_XML =
  XML_HEAD +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs></styleSheet>";

const encoder = new TextEncoder();

interface Entry {
  name: string;
  data: Uint8Array;
}

function u16(v: DataView, o: number, n: number) {
  v.setUint16(o, n, true);
}
function u32(v: DataView, o: number, n: number) {
  v.setUint32(o, n >>> 0, true);
}

/** A zip with every file stored uncompressed. */
export function zipStored(entries: Entry[]): Uint8Array {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = encoder.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x0800); // names are UTF-8
    u16(lv, 8, 0); // stored
    u16(lv, 10, DOS_TIME);
    u16(lv, 12, DOS_DATE);
    u32(lv, 14, crc);
    u32(lv, 18, e.data.length);
    u32(lv, 22, e.data.length);
    u16(lv, 26, name.length);
    u16(lv, 28, 0);
    local.set(name, 30);
    parts.push(local, e.data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0);
    u16(cv, 12, DOS_TIME);
    u16(cv, 14, DOS_DATE);
    u32(cv, 16, crc);
    u32(cv, 20, e.data.length);
    u32(cv, 24, e.data.length);
    u16(cv, 28, name.length);
    u32(cv, 42, offset);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, cdSize);
  u32(ev, 16, offset);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The bytes of an .xlsx file with one tab per sheet. */
export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: "Sheet", headers: [], rows: [] }];
  const used = new Set<string>();
  const named = list.map((s) => ({ ...s, name: sheetName(s.name, used) }));
  const n = named.length;
  const entries: Entry[] = [
    {
      name: "[Content_Types].xml",
      data: encoder.encode(
        XML_HEAD +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
          "</Types>",
      ),
    },
    {
      name: "_rels/.rels",
      data: encoder.encode(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: encoder.encode(
        XML_HEAD +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<bookViews><workbookView rightToLeft="1"/></bookViews><sheets>' +
          named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
          "</sheets></workbook>",
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: encoder.encode(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
          `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    { name: "xl/styles.xml", data: encoder.encode(STYLES_XML) },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: encoder.encode(sheetXml(s)) })),
  ];
  return zipStored(entries);
}
