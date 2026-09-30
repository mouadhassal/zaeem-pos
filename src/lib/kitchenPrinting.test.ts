// Runs the real printKitchenTicket with a fake canvas and records what each
// kitchen printer is sent: the text drawn for each job and which printer got it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: any }[] = [];
let handler: (cmd: string, args: any) => unknown = () => undefined;
vi.mock("./invoke", () => ({
  invoke: async (cmd: string, args: any) => {
    calls.push({ cmd, args });
    return handler(cmd, args);
  },
}));

let drawn: string[] = [];
const fakeCtx = () =>
  new Proxy({ fillText: (t: string) => drawn.push(t) } as any, {
    get: (t, k) => (k in t ? t[k] : k === "getImageData" ? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => undefined),
    set: () => true,
  });
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) };

import { printKitchenTicket, getPrintQueue } from "./printer";

const kitchenPrinter = (id: string, name: string) => ({
  id, name, printer_type: "KITCHEN", interface: "USB", vendor_id: null, product_id: null, drawer_pulse_ms: 200,
  is_primary: 0, is_secondary: 0, is_active: 1, paper_width_mm: 80, ip_address: null, port: 9100, code_page: 0,
  system_printer_name: `Q-${id}`, print_mode: "raster",
});
const PRINTERS = [kitchenPrinter("grill", "الشواية"), kitchenPrinter("fryer", "القلاية"), kitchenPrinter("expo", "التجميع")];
const MENU = [
  { id: "m-burger", category_id: "c-grill" }, { id: "m-fries", category_id: "c-fry" }, { id: "m-cola", category_id: "c-bar" },
];
const TICKET = {
  tableName: "", orderNumber: "A1", orderType: "TAKEAWAY",
  items: [
    { name: "برغر", quantity: 1, menuItemId: "m-burger" },
    { name: "بطاطا", quantity: 2, menuItemId: "m-fries" },
    { name: "كولا", quantity: 1, menuItemId: "m-cola" },
  ],
};

/** The printed jobs, in order: [printer queue name, all text drawn on that ticket]. */
function jobs() {
  const out: [string, string[]][] = [];
  let acc: string[] = [];
  return { push: (printer: string) => { out.push([printer, acc]); acc = []; }, add: (t: string) => acc.push(t), out };
}

function setup(links: { printer_id: string; category_id: string }[], opts: { failPrinter?: string; linksError?: boolean } = {}) {
  const j = jobs();
  calls.length = 0;
  drawn = [];
  handler = (cmd, args) => {
    if (cmd === "list_active_printers_v3") return PRINTERS;
    if (cmd === "get_chain_config_v3") return { default_paper_width: 80 };
    if (cmd === "list_printer_categories_v3") { if (opts.linksError) throw new Error("db"); return links; }
    if (cmd === "list_menu_items_v3") return MENU;
    if (cmd === "print_raw_bytes_v3") {
      if (args.printerName === opts.failPrinter) { drawn = []; throw new Error("jammed"); }
      j.push(args.printerName);
      const texts = drawn; drawn = []; j.out[j.out.length - 1]![1] = texts;
    }
    return undefined;
  };
  return j.out;
}
const texts = (out: [string, string[]][], printer: string) => out.find(([p]) => p === printer)?.[1] ?? null;

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).window.dispatchEvent = vi.fn();
  (globalThis as any).CustomEvent ??= class { constructor(public type: string, public init?: unknown) {} };
});

describe("printKitchenTicket with stations", () => {
  const LINKS = [
    { printer_id: "grill", category_id: "c-grill" },
    { printer_id: "fryer", category_id: "c-fry" },
  ];

  it("sends each station only its items, with the station name, and the full ticket to the printer with no categories", async () => {
    const out = setup(LINKS);
    await printKitchenTicket(TICKET);
    const grill = texts(out, "Q-grill")!, fryer = texts(out, "Q-fryer")!, expo = texts(out, "Q-expo")!;
    expect(grill.join("|")).toContain("برغر");
    expect(grill.join("|")).not.toContain("بطاطا");
    expect(grill).toContain("الشواية");
    expect(fryer.join("|")).toContain("بطاطا");
    expect(fryer.join("|")).not.toContain("برغر");
    expect(fryer).toContain("القلاية");
    for (const name of ["برغر", "بطاطا", "كولا"]) expect(expo.join("|")).toContain(name);
    expect(expo).not.toContain("التجميع");
  });

  it("behaves as before when no printer has categories: every printer prints everything, no station line", async () => {
    const out = setup([]);
    await printKitchenTicket(TICKET);
    expect(out.length).toBe(3);
    for (const [, t] of out) {
      for (const name of ["برغر", "بطاطا", "كولا"]) expect(t.join("|")).toContain(name);
      expect(t).not.toContain("الشواية");
    }
  });

  it("falls back to the whole ticket everywhere if the routing data cannot be read", async () => {
    const out = setup(LINKS, { linksError: true });
    await printKitchenTicket(TICKET);
    expect(out.length).toBe(3);
    for (const [, t] of out) expect(t.join("|")).toContain("بطاطا");
  });

  it("queues a retry for a failed station carrying only that station's items", async () => {
    const out = setup(LINKS, { failPrinter: "Q-grill" });
    await printKitchenTicket(TICKET);
    expect(out.map(([p]) => p).sort()).toEqual(["Q-expo", "Q-fryer"]);
    const queue = getPrintQueue();
    expect(queue.length).toBe(1);
    expect(queue[0]!.printerId).toBe("grill");
    expect(queue[0]!.data.items.map((i: any) => i.name)).toEqual(["برغر"]);
    expect(queue[0]!.data.station).toBe("الشواية");
  });
});
