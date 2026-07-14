import { getDb } from "../db";

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
  codePage: string;
  drawerPulseMs: number;
  isPrimary: number;
  isSecondary: number;
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
            codePage: "CP864",
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

export function createEscPosBuffer(codePage: string, _paperWidthMm: number): {
  write: (text?: string) => void;
  writeCommand: (...bytes: number[]) => void;
  setBold: (on: boolean) => void;
  setFontSize: (w: number, h: number) => void;
  setAlign: (align: 0 | 1 | 2) => void;
  setCodePage: (cp: string) => void;
  cut: () => void;
  openDrawer: (pulseMs: number) => void;
  getBuffer: () => Uint8Array;
} {
  const ESC = 0x1b;
  const GS = 0x1d;
  const bytes: number[] = [];

  const writer = {
    write: (text?: string) => {
      if (!text) return;
      const encoder = new TextEncoder();
      const encoded = encoder.encode(text);
      for (const b of encoded) bytes.push(b);
    },
    writeCommand: (...cmds: number[]) => {
      for (const c of cmds) bytes.push(c);
    },
    setBold: (on: boolean) => {
      bytes.push(ESC, 0x45, on ? 1 : 0);
    },
    setFontSize: (w: number, h: number) => {
      bytes.push(GS, 0x21, ((w - 1) << 4) | (h - 1));
    },
    setAlign: (align: 0 | 1 | 2) => {
      bytes.push(ESC, 0x61, align);
    },
    setCodePage: (cp: string) => {
      const pageTable: Record<string, number> = {
        CP437: 0, CP850: 2, CP860: 3, CP863: 4, CP865: 5,
        CP864: 17, CP1256: 19, CP1252: 255,
      };
      const page = pageTable[cp] ?? 17;
      bytes.push(ESC, 0x74, page);
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

  writer.writeCommand(ESC, 0x40);
  writer.setCodePage(codePage);
  return writer;
}

function generateEscPosReceipt(data: ReceiptData, config: { codePage: string; paperWidthMm: number }): Uint8Array {
  const pw = config.paperWidthMm === 58 ? 32 : 48;
  const p = createEscPosBuffer(config.codePage, config.paperWidthMm);
  const currency = data.currency ?? "SAR";

  p.setAlign(1);
  p.setFontSize(2, 2);
  p.setBold(true);
  p.write(data.chainName + "\n");
  p.setFontSize(1, 1);
  p.setBold(false);
  p.write(data.branchName + "\n");
  p.setAlign(0);
  p.write("=".repeat(pw) + "\n");
  p.setAlign(1);
  p.write(`التاريخ: ${new Date().toLocaleDateString("ar-SA")}\n`);
  p.write(`الوقت: ${new Date().toLocaleTimeString("ar-SA")}\n`);
  p.write(`رقم الطلب: ${data.orderNumber}\n`);
  p.write(`طاولة: ${data.tableName}\n`);

  const typeLabels: Record<string, string> = {
    DINE_IN: "داخلي", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين",
  };
  p.write(`النوع: ${typeLabels[data.orderType] ?? data.orderType}\n`);

  if (data.customerName) {
    p.write(`العميل: ${data.customerName}\n`);
  }
  if (data.deliveryAddress) {
    p.write(`العنوان: ${data.deliveryAddress}\n`);
  }

  p.setAlign(0);
  p.write("=".repeat(pw) + "\n");

  const colWidth = Math.floor((pw - 4) / 2);

  p.setBold(true);
  p.setFontSize(1, 1);
  const header = "الصنف".padEnd(colWidth) + "الكمية".padEnd(6) + "السعر".padStart(colWidth);
  p.write(header + "\n");
  p.setBold(false);
  p.write("-".repeat(pw) + "\n");

  for (const item of data.items) {
    const name = item.name.slice(0, colWidth - 2);
    const qty = String(item.quantity);
    const price = new Intl.NumberFormat("ar-SA", {
      style: "currency", currency,
    }).format((item.priceCents * item.quantity) / 100);
    p.write(`${name} ${" ".repeat(colWidth - name.length)}`);
    p.write(`${qty}  ${price}\n`);

    if (item.modifiers) {
      for (const mod of item.modifiers) {
        const modLine = `  +${mod.name}`;
        const modPrice = new Intl.NumberFormat("ar-SA", {
          style: "currency", currency,
        }).format(mod.priceCents / 100);
        p.write(`${modLine}${" ".repeat(pw - modLine.length - modPrice.length)}${modPrice}\n`);
      }
    }
  }

  p.write("-".repeat(pw) + "\n");

  const fmtCent = (c: number) =>
    new Intl.NumberFormat("ar-SA", { style: "currency", currency }).format(c / 100);

  const printLine = (label: string, value: string, bold?: boolean) => {
    const spaced = pw - value.length - 2;
    if (bold) p.setBold(true);
    p.write(`${label}${" ".repeat(Math.max(0, spaced))}${value}\n`);
    if (bold) p.setBold(false);
  };

  printLine("المجموع الفرعي", fmtCent(data.subtotalCents));
  if (data.serviceChargeCents > 0) {
    printLine("خدمة", fmtCent(data.serviceChargeCents));
  }
  printLine("الضريبة", fmtCent(data.taxCents));
  if (data.secondaryTaxCents > 0) {
    printLine("ضريبة إضافية", fmtCent(data.secondaryTaxCents));
  }
  if (data.discountCents > 0) {
    printLine("الخصم", `-${fmtCent(data.discountCents)}`);
  }
  if (data.savingsCents > 0) {
    printLine("وفرتم", fmtCent(data.savingsCents), true);
  }
  p.write("=".repeat(pw) + "\n");
  p.setFontSize(2, 2);
  p.setBold(true);
  printLine("الإجمالي", fmtCent(data.totalCents));
  p.setFontSize(1, 1);
  p.setBold(false);
  p.write("=".repeat(pw) + "\n");

  if (data.changeCents > 0) {
    printLine("الباقي", fmtCent(data.changeCents));
  }

  p.setAlign(1);
  p.write("\nشكراً لزيارتكم\n");
  p.write("نتمنى لكم يوماً سعيداً\n\n");

  p.openDrawer(200);

  return p.getBuffer();
}

function generateEscPosKitchenTicket(data: KitchenTicketData, config: { codePage: string; paperWidthMm: number }): Uint8Array {
  const pw = config.paperWidthMm === 58 ? 32 : 48;
  const p = createEscPosBuffer(config.codePage, config.paperWidthMm);

  p.setAlign(1);
  p.setFontSize(2, 2);
  p.setBold(true);
  p.write("*** المطبخ ***\n");
  p.setFontSize(1, 1);
  p.setBold(false);
  p.write("=".repeat(pw) + "\n");
  p.setAlign(0);

  const typeLabels: Record<string, string> = {
    DINE_IN: "داخلي", TAKEAWAY: "سفري", DELIVERY: "توصيل", ONLINE: "أونلاين",
  };
  p.write(`طاولة: ${data.tableName}\n`);
  p.write(`رقم: ${data.orderNumber}\n`);
  p.write(`النوع: ${typeLabels[data.orderType] ?? data.orderType}\n`);
  p.write(`التاريخ: ${new Date().toLocaleDateString("ar-SA")}\n`);
  p.write(`الوقت: ${new Date().toLocaleTimeString("ar-SA")}\n`);

  if (data.scheduledAt) {
    p.setBold(true);
    p.write(`مجدول: ${new Date(data.scheduledAt).toLocaleTimeString("ar-SA")}\n`);
    p.setBold(false);
  }

  p.write("-".repeat(pw) + "\n");

  for (const item of data.items) {
    p.setFontSize(1, 1);
    p.setBold(true);
    p.write(`${item.quantity} × ${item.name}\n`);
    p.setBold(false);
    if (item.modifiers) {
      for (const mod of item.modifiers) {
        p.write(`  + ${mod}\n`);
      }
    }
    if (item.notes) {
      p.write(`  ملاحظة: ${item.notes}\n`);
    }
    p.write("\n");
  }

  p.write("-".repeat(pw) + "\n");
  p.setAlign(1);
  p.write("\n");
  for (let i = 0; i < 3; i++) {
    p.write("\x07");
  }
  p.write("\n");

  return p.getBuffer();
}

export async function printToDevice(data: Uint8Array, printer: PrinterConfig): Promise<void> {
  if (printer.interface === "USB" && typeof navigator !== "undefined" && "usb" in navigator) {
    try {
      const devices = await (navigator as any).usb.getDevices();
      const device = devices.find(
        (d: any) =>
          `0x${d.vendorId.toString(16).padStart(4, "0")}` === printer.vendorId
      );
      if (!device) throw new Error("USB device not found");
      await device.open();
      if (device.configuration === null) await device.selectConfiguration(1);
      await device.claimInterface(0);
      await device.transferOut(1, data.buffer);
      await device.close();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "USB print failed";
      throw new Error(msg);
    }
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

export async function printReceipt(data: ReceiptData): Promise<void> {
  const db = await getDb();
  const printers = await db
    .selectFrom("printers")
    .selectAll()
    .where("printer_type", "=", "RECEIPT")
    .where("is_active", "=", 1)
    .orderBy("is_primary desc")
    .orderBy("is_secondary desc")
    .execute();

  const chain: any = await db
    .selectFrom("chain_config")
    .selectAll()
    .where("id", "=", "default")
    .executeTakeFirst();

  const defaultCodePage = chain?.code_page ?? "CP864";
  const defaultPaperWidth = chain?.default_paper_width ?? 80;

  let lastError: string | null = null;
  for (const printerPartial of printers.slice(0, 2)) {
    const p = printerPartial as any;
    try {
      const buf = generateEscPosReceipt(data, {
        codePage: p.code_page ?? defaultCodePage,
        paperWidthMm: p.paper_width_mm ?? defaultPaperWidth,
      });
      await printToDevice(buf, {
        id: p.id,
        name: p.name,
        printerType: "RECEIPT",
        interface: p.interface,
        vendorId: p.vendor_id,
        ipAddress: p.ip_address,
        port: p.port,
        paperWidthMm: p.paper_width_mm,
        codePage: p.code_page,
        drawerPulseMs: p.drawer_pulse_ms,
        isPrimary: p.is_primary,
        isSecondary: p.is_secondary,
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
  const db = await getDb();
  const printers = await db
    .selectFrom("printers")
    .selectAll()
    .where("printer_type", "=", "KITCHEN")
    .where("is_active", "=", 1)
    .execute();

  const chainK: any = await db
    .selectFrom("chain_config")
    .selectAll()
    .where("id", "=", "default")
    .executeTakeFirst();

  const defaultCodePageK = chainK?.code_page ?? "CP864";
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
      const buf = generateEscPosKitchenTicket(data, {
        codePage: p.code_page ?? defaultCodePageK,
        paperWidthMm: p.paper_width_mm ?? defaultPaperWidthK,
      });
      await printToDevice(buf, {
        id: p.id,
        name: p.name,
        printerType: "KITCHEN",
        interface: p.interface,
        vendorId: p.vendor_id,
        ipAddress: p.ip_address,
        port: p.port,
        paperWidthMm: p.paper_width_mm,
        codePage: p.code_page,
        drawerPulseMs: p.drawer_pulse_ms,
        isPrimary: p.is_primary,
        isSecondary: p.is_secondary,
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
  const db = await getDb();
  const printer = await db
    .selectFrom("printers")
    .selectAll()
    .where("printer_type", "=", "RECEIPT")
    .where("is_primary", "=", 1)
    .where("is_active", "=", 1)
    .executeTakeFirst();

  if (!printer) return;
  const pr = printer as any;

  const p = createEscPosBuffer(pr.code_page ?? "CP864", pr.paper_width_mm ?? 80);
  p.openDrawer(pulseMs ?? pr.drawer_pulse_ms ?? 200);
  const buf = p.getBuffer();

  await printToDevice(buf, {
    id: pr.id,
    name: pr.name,
    printerType: "RECEIPT",
    interface: pr.interface,
    vendorId: pr.vendor_id,
    ipAddress: pr.ip_address,
    port: pr.port,
    paperWidthMm: pr.paper_width_mm,
    codePage: pr.code_page,
    drawerPulseMs: pr.drawer_pulse_ms,
    isPrimary: pr.is_primary,
    isSecondary: pr.is_secondary,
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
  const db = await getDb();
  const cfg: any = await db
    .selectFrom("chain_config")
    .select(["chain_name", "currency"])
    .where("id", "=", "default")
    .executeTakeFirst();
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
