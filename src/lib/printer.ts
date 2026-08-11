import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";

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

/** Converts a canvas to ESC/POS `GS v 0` raster-image command bytes:
 * threshold to 1bpp (MSB-first, 1 = black dot), chunked into <=255-row
 * strips so no single command exceeds a conservative, universally-safe
 * printer buffer size. */
function canvasToEscPosRaster(canvas: HTMLCanvasElement): number[] {
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

export interface ReceiptItem {
  name: string;
  quantity: number;
  priceCents: number;
  modifiers?: { name: string; priceCents: number }[];
  comboId?: string;
}

export interface ReceiptData {
  chainName: string;
  branchName: string;
  orderNumber: string;
  tableName: string;
  orderType: string;
  items: ReceiptItem[];
  subtotalCents: number;
  taxCents: number;
  secondaryTaxCents: number;
  serviceChargeCents: number;
  discountCents: number;
  savingsCents: number;
  totalCents: number;
  paymentMethod: string;
  changeCents: number;
  currency?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
}

export interface KitchenTicketData {
  tableName: string;
  orderNumber: string;
  orderType: string;
  items: { name: string; quantity: number; notes?: string; modifiers?: string[] }[];
  scheduledAt?: string;
}

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
export async function listSystemPrinters(): Promise<SystemPrinter[]> {
  return invoke<SystemPrinter[]>("list_system_printers_v3");
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

function renderReceiptCanvas(data: ReceiptData, paperWidthMm: number): HTMLCanvasElement {
  const W = paperWidthDots(paperWidthMm);
  const b = newCanvasBuilder(W);
  const currency = data.currency ?? "SAR";
  const fmt = (c: number) => new Intl.NumberFormat("ar-SA", { style: "currency", currency }).format(c / 100);

  drawLine(b, data.chainName, { size: 42, bold: true, align: "center" });
  drawLine(b, data.branchName, { size: 24, align: "center" });
  b.y += 6;
  drawRule(b);

  drawTwoCol(b, "التاريخ", new Date().toLocaleDateString("ar-SA"));
  drawTwoCol(b, "الوقت", new Date().toLocaleTimeString("ar-SA"));
  drawTwoCol(b, "رقم الطلب", data.orderNumber);
  drawTwoCol(b, "طاولة", data.tableName);

  const typeLabels: Record<string, string> = {
    DINE_IN: "داخلي", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين",
  };
  drawTwoCol(b, "النوع", typeLabels[data.orderType] ?? data.orderType);

  if (data.customerName) drawTwoCol(b, "العميل", data.customerName);
  if (data.deliveryAddress) drawTwoCol(b, "العنوان", data.deliveryAddress);

  drawRule(b);

  for (const item of data.items) {
    drawTwoCol(b, `${item.quantity} × ${item.name}`, fmt(item.priceCents * item.quantity), { bold: true });
    if (item.modifiers) {
      for (const mod of item.modifiers) {
        drawTwoCol(b, `  + ${mod.name}`, fmt(mod.priceCents), { size: 20 });
      }
    }
  }

  drawRule(b);
  drawTwoCol(b, "المجموع الفرعي", fmt(data.subtotalCents));
  if (data.serviceChargeCents > 0) drawTwoCol(b, "خدمة", fmt(data.serviceChargeCents));
  drawTwoCol(b, "الضريبة", fmt(data.taxCents));
  if (data.secondaryTaxCents > 0) drawTwoCol(b, "ضريبة إضافية", fmt(data.secondaryTaxCents));
  if (data.discountCents > 0) drawTwoCol(b, "الخصم", `-${fmt(data.discountCents)}`);
  if (data.savingsCents > 0) drawTwoCol(b, "وفرتم", fmt(data.savingsCents), { bold: true });

  drawRule(b);
  drawTwoCol(b, "الإجمالي", fmt(data.totalCents), { size: 34, bold: true });
  drawRule(b);

  if (data.changeCents > 0) drawTwoCol(b, "الباقي", fmt(data.changeCents));

  b.y += 10;
  drawLine(b, "شكراً لزيارتكم", { align: "center", size: 26 });
  drawLine(b, "نتمنى لكم يوماً سعيداً", { align: "center", size: 22 });
  b.y += 24;

  return finalizeCanvas(b);
}

function renderKitchenTicketCanvas(data: KitchenTicketData, paperWidthMm: number): HTMLCanvasElement {
  const W = paperWidthDots(paperWidthMm);
  const b = newCanvasBuilder(W);

  drawLine(b, "*** المطبخ ***", { size: 38, bold: true, align: "center" });
  b.y += 6;
  drawRule(b);

  const typeLabels: Record<string, string> = {
    DINE_IN: "داخلي", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين",
  };
  drawTwoCol(b, "طاولة", data.tableName);
  drawTwoCol(b, "رقم", data.orderNumber);
  drawTwoCol(b, "النوع", typeLabels[data.orderType] ?? data.orderType);
  drawTwoCol(b, "التاريخ", new Date().toLocaleDateString("ar-SA"));
  drawTwoCol(b, "الوقت", new Date().toLocaleTimeString("ar-SA"));

  if (data.scheduledAt) {
    drawTwoCol(b, "مجدول", new Date(data.scheduledAt).toLocaleTimeString("ar-SA"), { bold: true });
  }

  drawRule(b);

  for (const item of data.items) {
    drawLine(b, `${item.quantity} × ${item.name}`, { bold: true, size: 28 });
    if (item.modifiers) {
      for (const mod of item.modifiers) {
        drawLine(b, `  + ${mod}`, { size: 22 });
      }
    }
    if (item.notes) {
      drawLine(b, `  ملاحظة: ${item.notes}`, { size: 22 });
    }
    b.y += 6;
  }

  drawRule(b);
  b.y += 16;

  return finalizeCanvas(b);
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

  if (printer.interface === "NETWORK" && printer.ipAddress) {
    try {
      const resp = await fetch(`http://${printer.ipAddress}:${printer.port}`, {
        method: "POST",
        body: data.buffer as ArrayBuffer,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!resp.ok) throw new Error(`Network printer returned ${resp.status}`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network printer error";
      throw new Error(msg);
    }
  }

  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `print-${Date.now()}.bin`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildReceiptJob(data: ReceiptData, paperWidthMm: number): Uint8Array {
  const canvas = renderReceiptCanvas(data, paperWidthMm);
  const buf = createEscPosCommandBuffer();
  buf.writeBytes(canvasToEscPosRaster(canvas));
  // 2026-08-10 audit fix (kept from the text-mode version): no
  // unconditional drawer-kick here -- PaymentModal.tsx already opens the
  // drawer explicitly, but only for CASH. The drawer is the caller's
  // decision, not baked into every receipt.
  buf.cut();
  return buf.getBuffer();
}

function buildKitchenTicketJob(data: KitchenTicketData, paperWidthMm: number): Uint8Array {
  const canvas = renderKitchenTicketCanvas(data, paperWidthMm);
  const buf = createEscPosCommandBuffer();
  buf.writeBytes(canvasToEscPosRaster(canvas));
  for (let i = 0; i < 3; i++) buf.writeCommand(0x07); // kitchen bell, a raw control byte -- unaffected by any codepage
  buf.cut();
  return buf.getBuffer();
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
    const p = printerPartial as any;
    try {
      const buf = buildReceiptJob(data, p.paper_width_mm ?? defaultPaperWidth);
      await printToDevice(buf, {
        id: p.id,
        name: p.name,
        printerType: "RECEIPT",
        interface: p.interface,
        vendorId: p.vendor_id,
        ipAddress: p.ip_address,
        port: p.port,
        paperWidthMm: p.paper_width_mm,
        drawerPulseMs: p.drawer_pulse_ms,
        isPrimary: p.is_primary,
        isSecondary: p.is_secondary,
        systemPrinterName: p.system_printer_name ?? undefined,
      });
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

export async function printKitchenTicket(data: KitchenTicketData): Promise<void> {
  const allPrinters = await invoke<PrinterRowV3[]>("list_active_printers_v3", { sessionToken: token() });
  const printers = allPrinters.filter((p) => p.printer_type === "KITCHEN");

  const chainK = await invoke<ChainConfigV3>("get_chain_config_v3", { sessionToken: token() });
  const defaultPaperWidthK = chainK?.default_paper_width ?? 80;

  let anyPrinted = false;
  let lastError: string | null = null;

  if (printers.length === 0) {
    window.dispatchEvent(
      new CustomEvent("kitchen-offline", { detail: data })
    );
    throw new Error("طابعة المطبخ غير متصلة");
  }

  for (const printerPartial of printers) {
    const p = printerPartial as any;
    try {
      const buf = buildKitchenTicketJob(data, p.paper_width_mm ?? defaultPaperWidthK);
      await printToDevice(buf, {
        id: p.id,
        name: p.name,
        printerType: "KITCHEN",
        interface: p.interface,
        vendorId: p.vendor_id,
        ipAddress: p.ip_address,
        port: p.port,
        paperWidthMm: p.paper_width_mm,
        drawerPulseMs: p.drawer_pulse_ms,
        isPrimary: p.is_primary,
        isSecondary: p.is_secondary,
        systemPrinterName: p.system_printer_name ?? undefined,
      });
      anyPrinted = true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Kitchen print failed";
    }
  }

  if (!anyPrinted) {
    window.dispatchEvent(
      new CustomEvent("kitchen-offline", { detail: data })
    );
    throw new Error(lastError ?? "فشلت طباعة المطبخ");
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

export function generateOnScreenReceiptHTML(data: ReceiptData): string {
  const currency = data.currency ?? "SAR";
  const fmtCent = (c: number) =>
    new Intl.NumberFormat("ar-SA", { style: "currency", currency }).format(c / 100);

  let itemsHtml = "";
  for (const item of data.items) {
    itemsHtml += `<tr><td>${item.quantity}× ${item.name}</td><td style="text-align:left">${fmtCent(item.priceCents * item.quantity)}</td></tr>`;
    if (item.modifiers) {
      for (const mod of item.modifiers) {
        itemsHtml += `<tr style="color:#999"><td style="padding-right:16px">+ ${mod.name}</td><td style="text-align:left">${fmtCent(mod.priceCents)}</td></tr>`;
      }
    }
  }

  return `
    <div dir="rtl" style="font-family:'Arabic Typesetting',Arial,sans-serif;padding:24px;max-width:320px;margin:0 auto;direction:rtl">
      <h2 style="text-align:center;margin:0">${data.chainName}</h2>
      <p style="text-align:center;color:#666;margin:4px 0">${data.branchName}</p>
      <hr/>
      <table style="width:100%;font-size:14px">
        <tr><td>التاريخ</td><td style="text-align:left">${new Date().toLocaleDateString("ar-SA")}</td></tr>
        <tr><td>الوقت</td><td style="text-align:left">${new Date().toLocaleTimeString("ar-SA")}</td></tr>
        <tr><td>رقم الطلب</td><td style="text-align:left">${data.orderNumber}</td></tr>
        <tr><td>طاولة</td><td style="text-align:left">${data.tableName}</td></tr>
      </table>
      <hr/>
      <table style="width:100%;font-size:14px">
        <thead><tr style="font-weight:bold"><th style="text-align:right">الصنف</th><th style="text-align:left">السعر</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <hr/>
      <table style="width:100%;font-size:14px">
        <tr><td>المجموع الفرعي</td><td style="text-align:left">${fmtCent(data.subtotalCents)}</td></tr>
        <tr><td>الضريبة</td><td style="text-align:left">${fmtCent(data.taxCents)}</td></tr>
        ${data.discountCents > 0 ? `<tr><td>الخصم</td><td style="text-align:left;color:red">-${fmtCent(data.discountCents)}</td></tr>` : ""}
        <tr style="font-weight:bold;font-size:18px"><td>الإجمالي</td><td style="text-align:left">${fmtCent(data.totalCents)}</td></tr>
      </table>
      <hr/>
      <p style="text-align:center;font-size:16px">شكراً لزيارتكم</p>
    </div>
  `;
}

export async function testPrint(): Promise<void> {
  const cfg = await invoke<ChainConfigV3>("get_chain_config_v3", { sessionToken: token() });
  await printReceipt({
    chainName: cfg?.chain_name ?? "مطعم التجربة",
    branchName: "الفرع الرئيسي",
    currency: cfg?.currency ?? "SAR",
    orderNumber: "TEST-001",
    tableName: "طاولة 1",
    orderType: "DINE_IN",
    items: [{ name: "برجر", quantity: 1, priceCents: 2500 }],
    subtotalCents: 2500,
    taxCents: 375,
    secondaryTaxCents: 0,
    serviceChargeCents: 0,
    discountCents: 0,
    savingsCents: 0,
    totalCents: 2875,
    paymentMethod: "CASH",
    changeCents: 125,
  });
}

export function queuePrintJob(data: ReceiptData | KitchenTicketData, type: "receipt" | "kitchen"): void {
  const jobs = JSON.parse(localStorage.getItem("printQueue") ?? "[]");
  jobs.push({ data, type, timestamp: Date.now() });
  localStorage.setItem("printQueue", JSON.stringify(jobs));
}

export function getPrintQueue(): { data: any; type: string; timestamp: number }[] {
  return JSON.parse(localStorage.getItem("printQueue") ?? "[]");
}

export function clearPrintQueue(): void {
  localStorage.removeItem("printQueue");
}

export async function retryPrintQueue(): Promise<void> {
  const jobs = getPrintQueue();
  if (jobs.length === 0) return;

  const remaining: typeof jobs = [];
  for (const job of jobs) {
    try {
      if (job.type === "receipt") {
        await printReceipt(job.data as ReceiptData);
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
