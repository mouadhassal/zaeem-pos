import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { routeKitchenItems } from "./kitchenRouting";
import { kitchenTicketRows, receiptRows, type KitchenTicketData, type ReceiptData, type ReceiptItem, type Row } from "./ticketLayout";

function token() {
  return useAuthStore.getState().token ?? "";
}

// 2026-08-10: receipts/kitchen tickets used to be sent as ESC/POS TEXT,
// which requires telling the printer which single-byte code page ("ESC t
// n") the following bytes are in. That numeric id is NOT standardized
// across manufacturers -- confirmed against Epson's own ESC/POS reference
// (id 19 is PC858/Euro on Epson hardware, unrelated to Arabic; other
// brands assign CP1256 to entirely different ids, e.g. Bixolon uses 40) --
// so an id that tested fine on one printer silently garbles Arabic on the
// next brand: ASCII (0x00-0x7F) is identical across every code page so it
// still prints fine, but the Arabic bytes (0x80-0xFF) get interpreted
// against whatever table that id actually maps to on THAT printer's
// firmware. Worse: even the CORRECT codepage id only encodes isolated
// Arabic letterforms -- ESC/POS text mode has no letter-joining/shaping
// support at all, so text-mode Arabic can never look properly connected
// regardless of which id is right.
//
// Both problems disappear by printing the receipt as a bitmap instead of
// characters: the webview's own canvas text renderer shapes and joins
// Arabic correctly (the same rendering engine that already draws this
// app's UI), and a raster image is just black/white dots -- `GS v 0` means
// the same thing on every ESC/POS-compatible printer ever made, no
// codepage negotiation, no per-brand id to get wrong.

/** 203dpi (8 dots/mm) is the near-universal thermal-printer resolution;
 * these are the standard printable dot widths for the two paper sizes
 * every ESC/POS printer on the market ships in -- a hardware constant, not
 * a brand-specific guess like the old codepage id was. */
function paperWidthDots(paperWidthMm: number): number {
  return paperWidthMm === 58 ? 384 : 576;
}

interface CanvasBuilder {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  y: number;
}

const ARABIC_FONT = "'Cairo','Noto Sans Arabic',sans-serif";

function newCanvasBuilder(widthDots: number, maxHeightDots = 4000): CanvasBuilder {
  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = maxHeightDots;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthDots, maxHeightDots);
  ctx.fillStyle = "#000";
  ctx.direction = "rtl";
  return { canvas, ctx, width: widthDots, y: 12 };
}

function drawLine(
  b: CanvasBuilder,
  text: string,
  opts: { size?: number; bold?: boolean; align?: "right" | "left" | "center" } = {}
) {
  const size = opts.size ?? 26;
  b.ctx.font = `${opts.bold ? "bold " : ""}${size}px ${ARABIC_FONT}`;
  b.ctx.textAlign = opts.align ?? "right";
  b.ctx.textBaseline = "top";
  b.ctx.direction = "rtl";
  const x = opts.align === "left" ? 12 : opts.align === "center" ? b.width / 2 : b.width - 12;
  b.ctx.fillText(text, x, b.y);
  b.y += Math.round(size * 1.5);
}

/** RTL label on the right, LTR value (numbers/prices) on the left -- the
 * standard receipt row shape, drawn as two independent text runs so the
 * numeric side never gets mirrored by `direction: rtl`. */
function drawTwoCol(
  b: CanvasBuilder,
  right: string,
  left: string,
  opts: { size?: number; bold?: boolean } = {}
) {
  const size = opts.size ?? 26;
  b.ctx.font = `${opts.bold ? "bold " : ""}${size}px ${ARABIC_FONT}`;
  b.ctx.textBaseline = "top";
  b.ctx.direction = "rtl";
  b.ctx.textAlign = "right";
  b.ctx.fillText(right, b.width - 12, b.y);
  b.ctx.direction = "ltr";
  b.ctx.textAlign = "left";
  b.ctx.fillText(left, 12, b.y);
  b.y += Math.round(size * 1.5);
}

function drawRule(b: CanvasBuilder, dashed = false) {
  b.ctx.strokeStyle = "#000";
  b.ctx.lineWidth = 2;
  b.ctx.beginPath();
  b.ctx.setLineDash(dashed ? [6, 6] : []);
  b.ctx.moveTo(8, b.y + 6);
  b.ctx.lineTo(b.width - 8, b.y + 6);
  b.ctx.stroke();
  b.ctx.setLineDash([]);
  b.y += 20;
}

/** Crops the (generously oversized) working canvas down to the content
 * actually drawn -- avoids a two-pass layout just to learn the height. */
function finalizeCanvas(b: CanvasBuilder): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = b.width;
  out.height = b.y;
  out.getContext("2d")!.drawImage(b.canvas, 0, 0, b.width, b.y, 0, 0, b.width, b.y);
  return out;
}

interface PackedImage {
  width: number;
  height: number;
  widthBytes: number;
  /** Rows of `widthBytes` bytes, MSB first, 1 = black dot. */
  bitmap: Uint8Array;
}

/** Thresholds a canvas to 1 bit per dot. */
function packCanvas(canvas: HTMLCanvasElement): PackedImage {
  const { width, height } = canvas;
  const img = canvas.getContext("2d")!.getImageData(0, 0, width, height);
  const widthBytes = Math.ceil(width / 8);

  const bitmap = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = img.data[idx], g = img.data[idx + 1], bch = img.data[idx + 2], a = img.data[idx + 3];
      const luminance = r * 0.299 + g * 0.587 + bch * 0.114;
      if (a > 128 && luminance < 200) {
        bitmap[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { width, height, widthBytes, bitmap };
}

/** ESC/POS `GS v 0` raster-image command bytes, chunked into <=255-row
 * strips so no single command exceeds a conservative, universally-safe
 * printer buffer size. */
function rasterBytes({ height, widthBytes, bitmap }: PackedImage): number[] {
  const out: number[] = [];
  const GS = 0x1d;
  const MAX_ROWS = 255;
  for (let rowStart = 0; rowStart < height; rowStart += MAX_ROWS) {
    const rows = Math.min(MAX_ROWS, height - rowStart);
    out.push(GS, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff);
    const start = rowStart * widthBytes;
    for (let i = 0; i < rows * widthBytes; i++) out.push(bitmap[start + i]);
  }
  return out;
}

/** ESC/POS `ESC * 33` (24-dot double density) bit-image bytes: the older
 * column format nearly every ESC/POS printer supports, for firmware that
 * doesn't know `GS v 0`. One 24-dot band per line, line spacing 24. */
function bitImageBytes({ width, height, widthBytes, bitmap }: PackedImage): number[] {
  const ESC = 0x1b;
  const out: number[] = [ESC, 0x33, 24];
  const dot = (x: number, y: number) => y < height && (bitmap[y * widthBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  for (let band = 0; band < height; band += 24) {
    out.push(ESC, 0x2a, 33, width & 0xff, (width >> 8) & 0xff);
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) if (dot(x, band + k * 8 + bit)) b |= 0x80 >> bit;
        out.push(b);
      }
    }
    out.push(0x0a);
  }
  out.push(ESC, 0x32); // default line spacing
  return out;
}

/** Plain-text line in the printer's own font, printed before the image on
 * a test print: if this line is readable but the image is not, the printer
 * needs another print mode; if both are garbage, it is not an ESC/POS
 * printer (pick "Windows driver"). */
function asciiLine(text: string): number[] {
  return [...Array.from(text, (ch) => ch.charCodeAt(0) & 0x7f), 0x0a];
}

// Receipt / kitchen-ticket content and its types live in ticketLayout.ts.
export type { ReceiptData, ReceiptItem, KitchenTicketData };

interface PrinterRowV3 {
  id: string;
  name: string;
  printer_type: "RECEIPT" | "KITCHEN" | "LABEL";
  interface: "USB" | "NETWORK" | "BLUETOOTH";
  vendor_id: string | null;
  product_id: string | null;
  drawer_pulse_ms: number;
  is_primary: number;
  is_secondary: number;
  is_active: number;
  paper_width_mm: number;
  ip_address: string | null;
  port: number;
  code_page: number;
  system_printer_name: string | null;
  /** 'raster' (GS v 0) | 'bitimage' (ESC *) | 'driver' (Windows driver). */
  print_mode?: PrintMode;
}

/** A real, OS-installed printer (winspool/CUPS via the Rust `printers` crate). */
export interface SystemPrinter {
  systemName: string;
  name: string;
  isDefault: boolean;
}

/**
 * 2026-07-26 printer audit fix: replaces the old WebUSB-based discovery,
 * which silently found nothing in the real desktop app -- Tauri's
 * embedded webview has no WebUSB implementation at all, so
 * `navigator.usb` was always undefined at runtime. This calls the real
 * Rust-side OS print spooler instead (see `print.rs`), which is how a USB
 * thermal printer actually needs to be reached going forward: pick one
 * from this list in Settings, not a WebUSB device chooser.
 */
// Virtual queues (PDF, XPS, OneNote, Fax) are never a receipt printer --
// picking one by mistake was an easy way to get "printing" that isn't.
const VIRTUAL_PRINTER = /pdf|xps|onenote|fax|send to|anydesk/i;

export async function listSystemPrinters(): Promise<SystemPrinter[]> {
  const all = await invoke<SystemPrinter[]>("list_system_printers_v3");
  return all.filter((p) => !VIRTUAL_PRINTER.test(p.name) && !VIRTUAL_PRINTER.test(p.systemName));
}

interface ChainConfigV3 {
  chain_name: string;
  currency: string;
  default_paper_width: number;
}

interface PrinterConfig {
  id: string;
  name: string;
  printerType: "RECEIPT" | "KITCHEN" | "LABEL";
  interface: "USB" | "NETWORK" | "BLUETOOTH";
  vendorId?: string;
  productId?: string;
  ipAddress?: string;
  port: number;
  paperWidthMm: number;
  drawerPulseMs: number;
  isPrimary: number;
  isSecondary: number;
  /** Real OS print-queue name -- what a USB printer is actually reached by now. */
  systemPrinterName?: string;
}

/** How the rendered receipt image reaches the paper (per printer, Settings):
 *  raster   = ESC/POS `GS v 0` (default, most thermal printers)
 *  bitimage = ESC/POS `ESC *` 24-dot columns (older/cheaper firmware that
 *             prints `GS v 0` as garbage characters)
 *  driver   = the printer's own Windows driver draws the image (any printer
 *             with a working driver; no cut/drawer commands). */
export type PrintMode = "raster" | "bitimage" | "driver";

const KNOWN_PRINTERS = [
  { vendorId: "0x0416", productId: "0x5011", name: "Epson TM-T88V" },
  { vendorId: "0x0416", productId: "0x5020", name: "Epson TM-T88VI" },
  { vendorId: "0x1504", productId: "0x0006", name: "XPrinter XP-80" },
  { vendorId: "0x1504", productId: "0x0005", name: "XPrinter XP-58" },
  { vendorId: "0x1504", productId: "0x0008", name: "XPrinter XP-76" },
  { vendorId: "0x1fc9", productId: "0x2016", name: "GPrinter GP-80250" },
  { vendorId: "0x1fc9", productId: "0x2013", name: "GPrinter GP-5890" },
  { vendorId: "0x19f5", productId: "0x0101", name: "Bixolon SRP-350" },
  { vendorId: "0x19f5", productId: "0x0102", name: "Bixolon SRP-330" },
];

export async function discoverPrinters(): Promise<PrinterConfig[]> {
  const results: PrinterConfig[] = [];

  if (typeof navigator !== "undefined" && "usb" in navigator) {
    try {
      const devices = await (navigator as any).usb.getDevices();
      for (const device of devices) {
        const vid = device.vendorId.toString(16).padStart(4, "0");
        const pid = device.productId.toString(16).padStart(4, "0");
        const vidPid = `0x${vid}`;
        const known = KNOWN_PRINTERS.find(
          (k) => k.vendorId.toLowerCase() === vidPid.toLowerCase()
        );
        if (known) {
          results.push({
            id: crypto.randomUUID(),
            name: known.name,
            printerType: "RECEIPT",
            interface: "USB",
            vendorId: vidPid,
            productId: `0x${pid}`,
            port: 0,
            paperWidthMm: 80,
            drawerPulseMs: 200,
            isPrimary: results.length === 0 ? 1 : 0,
            isSecondary: 0,
          });
        }
      }
    } catch {
      // USB API not available or no devices
    }
  }

  return results;
}

/** Bare ESC/POS command buffer -- init, cut, drawer-kick, and raw raster
 * bytes. No text/codepage handling here anymore (see the module doc
 * comment above); receipts and kitchen tickets are rendered as images. */
function createEscPosCommandBuffer(): {
  writeCommand: (...bytes: number[]) => void;
  writeBytes: (bytes: number[]) => void;
  cut: () => void;
  openDrawer: (pulseMs: number) => void;
  getBuffer: () => Uint8Array;
} {
  const ESC = 0x1b;
  const GS = 0x1d;
  const bytes: number[] = [ESC, 0x40]; // init

  return {
    writeCommand: (...cmds: number[]) => {
      for (const c of cmds) bytes.push(c);
    },
    writeBytes: (data: number[]) => {
      for (const b of data) bytes.push(b);
    },
    cut: () => {
      bytes.push(GS, 0x56, 0x00);
    },
    openDrawer: (pulseMs: number) => {
      const t = pulseMs <= 100 ? 0 : pulseMs <= 200 ? 1 : pulseMs <= 300 ? 2 : 3;
      bytes.push(ESC, 0x70, t, 0x19, 0x32);
    },
    getBuffer: () => new Uint8Array(bytes),
  };
}

/** Draws content rows (see ticketLayout.ts) onto a fresh canvas for the given paper. */
function drawRows(rows: readonly Row[], paperWidthMm: number): HTMLCanvasElement {
  const b = newCanvasBuilder(paperWidthDots(paperWidthMm));
  for (const r of rows) {
    if (r.t === "line") drawLine(b, r.text, { ...(r.size ? { size: r.size } : {}), ...(r.bold ? { bold: true } : {}), ...(r.align ? { align: r.align } : {}) });
    else if (r.t === "two") drawTwoCol(b, r.right, r.left, { ...(r.size ? { size: r.size } : {}), ...(r.bold ? { bold: true } : {}) });
    else if (r.t === "rule") drawRule(b, !!r.dashed);
    else b.y += r.h;
  }
  return finalizeCanvas(b);
}

function renderReceiptCanvas(data: ReceiptData, paperWidthMm: number): HTMLCanvasElement {
  return drawRows(receiptRows(data), paperWidthMm);
}

function renderKitchenTicketCanvas(data: KitchenTicketData, paperWidthMm: number): HTMLCanvasElement {
  return drawRows(kitchenTicketRows(data), paperWidthMm);
}

export async function printToDevice(data: Uint8Array, printer: PrinterConfig): Promise<void> {
  // 2026-07-26 printer audit fix: this used to call browser WebUSB
  // (navigator.usb), which Tauri's embedded webview does not implement --
  // it silently never worked (no error, no paper, `.bin` file quietly
  // downloaded instead). Real USB printing now goes through the OS print
  // spooler via a Rust command (see print.rs), sending the exact same
  // ESC/POS bytes as a RAW job straight to the device's own driver queue.
  if (printer.interface === "USB") {
    if (!printer.systemPrinterName) {
      throw new Error("لم يتم اختيار طابعة من قائمة النظام لهذا الجهاز -- اذهب إلى الإعدادات واختر الطابعة الفعلية");
    }
    await invoke("print_raw_bytes_v3", { printerName: printer.systemPrinterName, data: Array.from(data) });
    return;
  }

  // 2026-09-23 fix: this used to `fetch` an HTTP POST to IP:port. LAN
  // thermal printers speak raw TCP (port 9100), not HTTP -- the POST's
  // CORS preflight was never answered, so kitchen tickets never arrived.
  // Raw socket write now happens in Rust (print.rs).
  if (printer.interface === "NETWORK" && printer.ipAddress) {
    await invoke("print_network_raw_v3", { ipAddress: printer.ipAddress, port: printer.port || 9100, data: Array.from(data) });
    return;
  }

  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `print-${Date.now()}.bin`;
  a.click();
  URL.revokeObjectURL(url);
}

function rowToConfig(p: PrinterRowV3, printerType: PrinterConfig["printerType"]): PrinterConfig {
  return {
    id: p.id,
    name: p.name,
    printerType,
    interface: p.interface,
    ...(p.vendor_id ? { vendorId: p.vendor_id } : {}),
    ...(p.ip_address ? { ipAddress: p.ip_address } : {}),
    port: p.port,
    paperWidthMm: p.paper_width_mm,
    drawerPulseMs: p.drawer_pulse_ms,
    isPrimary: p.is_primary,
    isSecondary: p.is_secondary,
    ...(p.system_printer_name ? { systemPrinterName: p.system_printer_name } : {}),
  };
}

/** Sends one rendered receipt/ticket image to one printer in that
 * printer's print mode. `bell` rings a kitchen printer; `testLine` adds the
 * plain-text diagnostic line (ESC/POS modes only). */
async function printCanvasTo(
  canvas: HTMLCanvasElement,
  p: PrinterRowV3,
  printerType: PrinterConfig["printerType"],
  paperWidthMm: number,
  opts: { bell?: boolean; testLine?: string } = {}
): Promise<void> {
  // The driver mode draws through Windows GDI; on macOS/Linux fall back to
  // direct ESC/POS (CUPS raw queue).
  const onWindows = navigator.userAgent.includes("Windows");
  const mode: PrintMode = p.print_mode === "driver" && !onWindows ? "raster" : p.print_mode ?? "raster";
  const packed = packCanvas(canvas);

  if (mode === "driver") {
    if (p.interface !== "USB" || !p.system_printer_name) {
      throw new Error("وضع \"تعريف ويندوز\" يعمل فقط مع طابعة مثبتة على هذا الجهاز -- اختر الطابعة من القائمة");
    }
    await invoke("print_image_driver_v3", {
      printerName: p.system_printer_name,
      width: packed.width,
      height: packed.height,
      bitmap: Array.from(packed.bitmap),
      paperWidthMm,
    });
    return;
  }

  const buf = createEscPosCommandBuffer();
  if (opts.testLine) buf.writeBytes(asciiLine(opts.testLine));
  buf.writeBytes(mode === "bitimage" ? bitImageBytes(packed) : rasterBytes(packed));
  // 2026-08-10 audit fix (kept): no unconditional drawer-kick on receipts --
  // PaymentModal.tsx opens the drawer explicitly, and only for CASH.
  if (opts.bell) for (let i = 0; i < 3; i++) buf.writeCommand(0x07); // kitchen bell
  buf.cut();
  await printToDevice(buf.getBuffer(), rowToConfig(p, printerType));
}

export async function printReceipt(data: ReceiptData): Promise<void> {
  const allPrinters = await invoke<PrinterRowV3[]>("list_active_printers_v3", { sessionToken: token() });
  const printers = allPrinters
    .filter((p) => p.printer_type === "RECEIPT")
    .sort((a, b) => (b.is_primary - a.is_primary) || (b.is_secondary - a.is_secondary));

  const chain = await invoke<ChainConfigV3>("get_chain_config_v3", { sessionToken: token() });
  const defaultPaperWidth = chain?.default_paper_width ?? 80;

  let lastError: string | null = null;
  for (const printerPartial of printers.slice(0, 2)) {
    const p = printerPartial;
    try {
      const width = p.paper_width_mm ?? defaultPaperWidth;
      await printCanvasTo(renderReceiptCanvas(data, width), p, "RECEIPT", width);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Print failed";
    }
  }

  if (lastError) {
    const event = new CustomEvent("print-failed", {
      detail: { receipt: data, error: lastError },
    });
    window.dispatchEvent(event);
    throw new Error("فشلت الطباعة");
  }
}

async function sendKitchenTicketToPrinter(
  data: KitchenTicketData,
  p: any,
  defaultPaperWidthK: number
): Promise<void> {
  const width = p.paper_width_mm ?? defaultPaperWidthK;
  await printCanvasTo(renderKitchenTicketCanvas(data, width), p, "KITCHEN", width, { bell: true });
}

export async function printKitchenTicket(data: KitchenTicketData): Promise<void> {
  const allPrinters = await invoke<PrinterRowV3[]>("list_active_printers_v3", { sessionToken: token() });
  const printers = allPrinters.filter((p) => p.printer_type === "KITCHEN");

  const chainK = await invoke<ChainConfigV3>("get_chain_config_v3", { sessionToken: token() });
  const defaultPaperWidthK = chainK?.default_paper_width ?? 80;

  if (printers.length === 0) {
    window.dispatchEvent(
      new CustomEvent("kitchen-offline", { detail: data })
    );
    throw new Error("طابعة المطبخ غير متصلة");
  }

  // 2026-09-14 audit fix: this used to consider the WHOLE call a success as
  // soon as ANY kitchen printer succeeded (a single `anyPrinted` flag and a
  // single `lastError` that the last failure overwrote) -- so a business
  // with two kitchen stations (grill + bar) where one is offline/jammed got
  // zero error, zero retry-queue entry, zero toast for that one station; it
  // just silently never got its ticket. Unlike printReceipt's single-ticket
  // failover (2 candidates, first success wins), every KITCHEN printer here
  // is an independent station that needs its own physical copy, so each
  // printer's outcome is now tracked and surfaced individually.
  let anyPrinted = false;
  const failedPrinters: { id: string; name: string; error: string; ticket: KitchenTicketData }[] = [];

  // Station printing (Migration AD): each kitchen printer with categories
  // gets only its items. If the routing data can't be read, fall back to the
  // old behaviour (every printer gets the whole ticket) rather than lose it.
  type Router = (items: KitchenTicketData["items"]) => Map<string, KitchenTicketData["items"]>;
  let route: Router | null = null;
  const stationIds = new Set<string>();
  try {
    const [links, menu] = await Promise.all([
      invoke<{ printer_id: string; category_id: string }[]>("list_printer_categories_v3", { sessionToken: token() }),
      invoke<{ id: string; category_id: string }[]>("list_menu_items_v3", { sessionToken: token() }),
    ]);
    if (links.length > 0) {
      const byPrinter = new Map<string, string[]>();
      for (const l of links) byPrinter.set(l.printer_id, [...(byPrinter.get(l.printer_id) ?? []), l.category_id]);
      const categoryByItem = new Map(menu.map((m) => [m.id, m.category_id]));
      const routePrinters = printers.map((p) => ({ id: p.id, categoryIds: byPrinter.get(p.id) ?? [] }));
      route = (list) => routeKitchenItems(list, routePrinters, (menuItemId) => (menuItemId ? categoryByItem.get(menuItemId) : undefined));
      for (const [id, cats] of byPrinter) if (cats.length > 0) stationIds.add(id);
    }
  } catch {
    route = null;
  }

  // Each station's share of this ticket. An EDIT carries two lists (the lines
  // as they were and as they are now); both are routed so the station that
  // made the old line sees its replacement.
  const routedNew = route ? route(data.items) : null;
  const routedOld = route && data.replaces ? route(data.replaces) : null;
  const shares: { p: any; items: KitchenTicketData["items"]; replaces?: KitchenTicketData["items"] }[] = [];
  for (const printerPartial of printers) {
    const p = printerPartial as any;
    const items = (routedNew ? routedNew.get(p.id) : data.items) ?? [];
    const replaces = data.replaces ? (routedOld ? routedOld.get(p.id) : data.replaces) ?? [] : undefined;
    if (items.length === 0 && (replaces?.length ?? 0) === 0) continue; // nothing for this station: no empty ticket
    shares.push({ p, items, ...(replaces ? { replaces } : {}) });
  }
  // When the order is split across stations, every station slip says so:
  // which station it is, and what the other stations got. A printer with no
  // categories (pass / expo) already prints everything and is left out.
  const stationShares = shares.filter((sh) => stationIds.has(sh.p.id));
  const split = stationShares.length > 1;
  const count = (list: KitchenTicketData["items"]) => list.reduce((n, i) => n + i.quantity, 0);

  for (const share of shares) {
    const { p, items } = share;
    const stationIdx = stationShares.indexOf(share);
    const ticket: KitchenTicketData = {
      ...data,
      items,
      ...(share.replaces ? { replaces: share.replaces } : {}),
      ...(stationIds.has(p.id) ? { station: p.name } : {}),
      ...(split && stationIdx >= 0
        ? {
            stationNo: stationIdx + 1,
            stationOf: stationShares.length,
            alsoSentTo: stationShares
              .filter((o) => o !== share)
              .map((o) => ({ name: o.p.name as string, count: count(o.items.length > 0 ? o.items : o.replaces ?? []) })),
          }
        : {}),
    };
    try {
      await sendKitchenTicketToPrinter(ticket, p, defaultPaperWidthK);
      anyPrinted = true;
    } catch (err) {
      failedPrinters.push({
        id: p.id,
        name: p.name,
        error: err instanceof Error ? err.message : "Kitchen print failed",
        ticket,
      });
    }
  }

  for (const failed of failedPrinters) {
    // Queue a retry scoped to THIS printer only, carrying that printer's own
    // share of the items -- retrying the whole ticket against every kitchen
    // printer again would re-send a duplicate copy to the station(s) that
    // already got it fine.
    queuePrintJob(failed.ticket, "kitchen", failed.id);
    window.dispatchEvent(
      new CustomEvent("kitchen-print-failed", {
        detail: {
          tableName: data.tableName,
          orderNumber: data.orderNumber,
          printerName: failed.name,
          error: failed.error,
        },
      })
    );
  }

  if (!anyPrinted) {
    window.dispatchEvent(
      new CustomEvent("kitchen-offline", { detail: data })
    );
    throw new Error(failedPrinters[0]?.error ?? "فشلت طباعة المطبخ");
  }
}

export async function openCashDrawer(pulseMs: number = 200): Promise<void> {
  const allPrinters = await invoke<PrinterRowV3[]>("list_active_printers_v3", { sessionToken: token() });
  const printer = allPrinters.find((p) => p.printer_type === "RECEIPT" && p.is_primary === 1);

  if (!printer) return;
  const pr = printer as any;

  const buf = createEscPosCommandBuffer();
  buf.openDrawer(pulseMs ?? pr.drawer_pulse_ms ?? 200);

  await printToDevice(buf.getBuffer(), {
    id: pr.id,
    name: pr.name,
    printerType: "RECEIPT",
    interface: pr.interface,
    vendorId: pr.vendor_id,
    ipAddress: pr.ip_address,
    port: pr.port,
    paperWidthMm: pr.paper_width_mm,
    drawerPulseMs: pr.drawer_pulse_ms,
    isPrimary: pr.is_primary,
    isSecondary: pr.is_secondary,
    systemPrinterName: pr.system_printer_name ?? undefined,
  });
}

// 2026-09-14 audit fix: every value below used to be interpolated straight
// into the HTML string with no escaping, and OnScreenReceiptModal.tsx
// renders the result via dangerouslySetInnerHTML -- so a menu item/modifier
// name (only length-validated in menu/page.tsx, not character-restricted)
// containing e.g. `</td><script>...` would inject real markup into this
// modal's DOM. The app's CSP (script-src 'self', no unsafe-inline) blocks
// this from executing as script today, but that's a config detail this fix
// shouldn't depend on staying exactly as-is forever -- escape every
// interpolated value instead so the HTML itself can't be broken out of.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateOnScreenReceiptHTML(data: ReceiptData): string {
  // Same rows the printer draws, so the screen copy can never differ from the paper one.
  const px = (size?: number) => Math.round((size ?? 26) * 0.55);
  const body = receiptRows(data)
    .map((r) => {
      if (r.t === "line") {
        return `<div style="text-align:${r.align ?? "right"};font-size:${px(r.size)}px;${r.bold ? "font-weight:bold;" : ""}">${escapeHtml(r.text)}</div>`;
      }
      if (r.t === "two") {
        return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:${px(r.size)}px;${r.bold ? "font-weight:bold;" : ""}"><span>${escapeHtml(r.right)}</span><span dir="ltr">${escapeHtml(r.left)}</span></div>`;
      }
      if (r.t === "rule") return `<hr style="border:0;border-top:1px ${r.dashed ? "dashed" : "solid"} #999;margin:6px 0"/>`;
      return `<div style="height:${Math.round(r.h / 2)}px"></div>`;
    })
    .join("");
  return `<div dir="rtl" style="font-family:'Arabic Typesetting',Arial,sans-serif;padding:24px;max-width:340px;margin:0 auto;direction:rtl">${body}</div>`;
}

/** Test print from a printer's own card in Settings. Prints a sample
 * receipt to THAT printer (not whichever receipt printer is primary), in
 * its print mode, preceded by a plain-text line (see asciiLine). */
export async function testPrint(printerId?: string): Promise<void> {
  const cfg = await invoke<ChainConfigV3>("get_chain_config_v3", { sessionToken: token() });
  // 2026-08-21 vocabulary-leak audit fix: this used to hardcode
  // tableName/orderType to a restaurant dine-in order unconditionally --
  // a has_tables=false business (coffee counter, retail shop) hitting the
  // real "test print" button in Settings would see a fake "طاولة 1" line
  // on their own test receipt, the exact leak the rest of printer.ts was
  // already fixed to avoid for real orders (see renderReceiptCanvas's own
  // 2026-08-13 fix comment). Reads business mode the same way
  // orderService.ts already does for the real print paths.
  const mode = await invoke<{ has_tables: boolean }>("get_business_mode_v3", { sessionToken: token() }).catch(() => ({ has_tables: true }));
  const receiptCfg = await invoke<{ branch_name?: string }>("get_receipt_config_v3", { sessionToken: token() }).catch(() => null);
  const sample: ReceiptData = {
    chainName: cfg?.chain_name ?? "منشأة التجربة",
    branchName: receiptCfg?.branch_name || "",
    currency: cfg?.currency ?? "SYP",
    orderNumber: "TEST-001",
    tableName: mode.has_tables ? "طاولة 1" : "",
    orderType: mode.has_tables ? "DINE_IN" : "TAKEAWAY",
    // New-lira sized (100 old SYP = 1 new since 2026).
    items: [{ name: "برجر", quantity: 1, priceCents: 250 }],
    subtotalCents: 250,
    taxCents: 0,
    secondaryTaxCents: 0,
    serviceChargeCents: 0,
    discountCents: 0,
    savingsCents: 0,
    totalCents: 250,
    paymentMethod: "CASH",
    changeCents: 50,
  };
  if (!printerId) {
    await printReceipt(sample);
    return;
  }
  const all = await invoke<PrinterRowV3[]>("list_printers_v3", { sessionToken: token() });
  const p = all.find((x) => x.id === printerId);
  if (!p) throw new Error("الطابعة غير موجودة");
  const width = p.paper_width_mm ?? cfg?.default_paper_width ?? 80;
  if (p.printer_type === "KITCHEN") {
    const [links, cats] = await Promise.all([
      invoke<{ printer_id: string; category_id: string }[]>("list_printer_categories_v3", { sessionToken: token() }),
      invoke<{ id: string; name: string }[]>("list_categories_v3", { sessionToken: token() }),
    ]);
    const mine = links.filter((l) => l.printer_id === p.id).map((l) => cats.find((c) => c.id === l.category_id)?.name).filter((n): n is string => !!n);
    const ticket: KitchenTicketData = {
      tableName: "",
      orderNumber: "TEST-001",
      orderType: "TAKEAWAY",
      items: [{ name: mine.length ? mine.join("، ") : "كل الأقسام", quantity: 1 }],
      ...(mine.length ? { station: p.name } : {}),
    };
    await printCanvasTo(renderKitchenTicketCanvas(ticket, width), p, "KITCHEN", width, { bell: true });
    return;
  }
  await printCanvasTo(renderReceiptCanvas(sample, width), p, p.printer_type, width, {
    testLine: `WENZDES TEST ${p.print_mode ?? "raster"} 1234567890`,
  });
}

// `printerId` (kitchen jobs only) scopes a retry to the ONE printer that
// actually failed -- see printKitchenTicket's per-printer tracking above.
// Left undefined for a receipt job, or an older kitchen job queued before
// this fix that has no specific printer to target.
export function queuePrintJob(
  data: ReceiptData | KitchenTicketData,
  type: "receipt" | "kitchen",
  printerId?: string
): void {
  const jobs = JSON.parse(localStorage.getItem("printQueue") ?? "[]");
  jobs.push({ data, type, printerId, timestamp: Date.now() });
  localStorage.setItem("printQueue", JSON.stringify(jobs));
}

export function getPrintQueue(): { data: any; type: string; printerId?: string; timestamp: number }[] {
  return JSON.parse(localStorage.getItem("printQueue") ?? "[]");
}

export function clearPrintQueue(): void {
  localStorage.removeItem("printQueue");
}

// Retries a kitchen ticket against exactly one printer (by id) instead of
// every KITCHEN-type printer -- used for a queued job that named the
// specific station that failed, so a retry doesn't re-send a duplicate
// copy to stations that already printed it fine the first time.
async function retryKitchenTicketToPrinter(data: KitchenTicketData, printerId: string): Promise<void> {
  const allPrinters = await invoke<PrinterRowV3[]>("list_active_printers_v3", { sessionToken: token() });
  const printer = allPrinters.find((p) => p.id === printerId && p.printer_type === "KITCHEN");
  if (!printer) throw new Error("طابعة المطبخ غير موجودة");

  const chainK = await invoke<ChainConfigV3>("get_chain_config_v3", { sessionToken: token() });
  const defaultPaperWidthK = chainK?.default_paper_width ?? 80;

  await sendKitchenTicketToPrinter(data, printer as any, defaultPaperWidthK);
}

export async function retryPrintQueue(): Promise<void> {
  const jobs = getPrintQueue();
  if (jobs.length === 0) return;

  const remaining: typeof jobs = [];
  for (const job of jobs) {
    try {
      if (job.type === "receipt") {
        await printReceipt(job.data as ReceiptData);
      } else if (job.printerId) {
        await retryKitchenTicketToPrinter(job.data as KitchenTicketData, job.printerId);
      } else {
        await printKitchenTicket(job.data as KitchenTicketData);
      }
    } catch {
      remaining.push(job);
    }
  }

  if (remaining.length > 0) {
    localStorage.setItem("printQueue", JSON.stringify(remaining));
  } else {
    clearPrintQueue();
  }
}
