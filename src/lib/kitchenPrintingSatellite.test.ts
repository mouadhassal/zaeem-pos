// A second till (LAN satellite) prints kitchen slips on the HUB's kitchen
// network printers with the Hub's category routing, and still prints its
// receipts on its own printer list.
import { beforeEach, describe, expect, it, vi } from "vitest";

const localCalls: { cmd: string; args: any }[] = [];
let localHandler: (cmd: string, args: any) => unknown = () => undefined;
vi.mock("./invoke", () => ({
  invoke: async (cmd: string, args: any) => {
    localCalls.push({ cmd, args });
    return localHandler(cmd, args);
  },
}));

// The satellite's Tauri bridge: lan_relay_v3 forwards to the Hub.
const relayed: string[] = [];
let hubAnswers: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: any) => {
    if (cmd !== "lan_relay_v3") return undefined;
    relayed.push(args.command);
    return { redirected: true, data: hubAnswers[args.command], error: null };
  },
}));

let drawn: string[] = [];
const fakeCtx = () =>
  new Proxy({ fillText: (t: string) => drawn.push(t) } as any, {
    get: (t, k) => (k in t ? t[k] : k === "getImageData" ? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => undefined),
    set: () => true,
  });
(globalThis as any).document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) };

import { openCashDrawer, printKitchenTicket } from "./printer";

const printer = (id: string, name: string, type: string, iface: string, extra: Record<string, unknown> = {}) => ({
  id, name, printer_type: type, interface: iface, vendor_id: null, product_id: null, drawer_pulse_ms: 200,
  is_primary: 0, is_secondary: 0, is_active: 1, paper_width_mm: 80, ip_address: null, port: 9100, code_page: 0,
  system_printer_name: null, print_mode: "raster", ...extra,
});

const HUB_PRINTERS = [
  printer("grill", "الشواية", "KITCHEN", "NETWORK", { ip_address: "192.168.1.50" }),
  printer("bar", "البار", "KITCHEN", "NETWORK", { ip_address: "192.168.1.51" }),
  printer("usb-kitchen", "مطبخ USB", "KITCHEN", "USB", { system_printer_name: "POS-80" }), // plugged into the Hub: unreachable
  printer("hub-receipt", "إيصالات الصندوق", "RECEIPT", "USB", { system_printer_name: "POS-80" }),
];

const TICKET = {
  tableName: "٣", orderNumber: "B1", orderType: "DINE_IN",
  items: [
    { name: "برغر", quantity: 1, menuItemId: "m-burger" },
    { name: "كولا", quantity: 1, menuItemId: "m-cola" },
  ],
};

beforeEach(() => {
  localStorage.clear();
  localCalls.length = 0;
  relayed.length = 0;
  drawn = [];
  (globalThis as any).window.dispatchEvent = vi.fn();
  (globalThis as any).CustomEvent ??= class { constructor(public type: string, public init?: unknown) {} };
  hubAnswers = {
    list_active_printers_v3: HUB_PRINTERS,
    list_printer_categories_v3: [
      { printer_id: "grill", category_id: "c-grill" },
      { printer_id: "bar", category_id: "c-bar" },
    ],
  };
  localHandler = (cmd) => {
    if (cmd === "get_chain_config_v3") return { default_paper_width: 80 };
    // Item ids are the Hub's (list_menu_items_v3 is redirected to the Hub on a satellite).
    if (cmd === "list_menu_items_v3") return [{ id: "m-burger", category_id: "c-grill" }, { id: "m-cola", category_id: "c-bar" }];
    return undefined; // print_network_raw_v3 etc.
  };
});

describe("kitchen slips from a satellite till", () => {
  it("go to the Hub's kitchen NETWORK printers, routed by the Hub's categories", async () => {
    await printKitchenTicket(TICKET);
    const sent = localCalls.filter((c) => c.cmd === "print_network_raw_v3").map((c) => c.args.ipAddress).sort();
    expect(sent).toEqual(["192.168.1.50", "192.168.1.51"]);
    // The list came from the Hub, not from this terminal's own (empty) printer table.
    expect(relayed).toContain("list_active_printers_v3");
    expect(relayed).toContain("list_printer_categories_v3");
    expect(localCalls.some((c) => c.cmd === "list_active_printers_v3")).toBe(false);
    expect(localCalls.some((c) => c.cmd === "list_printer_categories_v3")).toBe(false);
  });

  it("never try the Hub's USB kitchen printer or its receipt printer from this machine", async () => {
    await printKitchenTicket(TICKET);
    expect(localCalls.some((c) => c.cmd === "print_raw_bytes_v3")).toBe(false);
    expect(localCalls.some((c) => c.cmd === "print_image_driver_v3")).toBe(false);
  });

  it("report the kitchen as offline when the Hub only has USB kitchen printers", async () => {
    hubAnswers.list_active_printers_v3 = [HUB_PRINTERS[2], HUB_PRINTERS[3]];
    await expect(printKitchenTicket(TICKET)).rejects.toThrow();
    expect(localCalls.some((c) => c.cmd === "print_network_raw_v3")).toBe(false);
  });

  it("leave receipt-side printing (cash drawer here) on this terminal's own printer list", async () => {
    localHandler = (cmd) => (cmd === "list_active_printers_v3" ? [] : undefined);
    await openCashDrawer().catch(() => undefined);
    expect(localCalls.some((c) => c.cmd === "list_active_printers_v3")).toBe(true);
    expect(relayed).toEqual([]);
  });
});
