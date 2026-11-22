import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What the terminal's own Tauri bridge answers: the satellite probe and the relay to the hub.
let relayAnswer: unknown = { redirected: false };
const tauriCalls: { cmd: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    tauriCalls.push({ cmd, args });
    if (cmd === "get_lan_redirect_target_v3") return { hubAddr: "192.168.1.10:47811", cloud: false };
    if (cmd === "lan_relay_v3") return relayAnswer;
    return "local";
  },
}));
vi.mock("../stores/sessionStore", () => ({ useSessionStore: { getState: () => ({ setExpired: () => {} }) } }));

import { invoke } from "./invoke";
import { BACK_OFFICE_REFUSED, BACK_OFFICE_REMOTE_COMMANDS, HUB_ONLY_WRITES, LAN_REDIRECT_COMMANDS, invalidateLanTargetCache } from "./lan";
import { SATELLITE_BACK_OFFICE_PAGES, applyBackOfficeAccess, getNavForRole } from "./permissions";

const CMD_DIR = fileURLToPath(new URL("../../src-tauri/src/commands/", import.meta.url));
const OFFICE_SOURCE = readFileSync(CMD_DIR + "lan_rpc_office.rs", "utf8");
const LAN_SOURCE = readFileSync(fileURLToPath(new URL("../../src-tauri/src/lan.rs", import.meta.url)), "utf8");

function rustList(): Set<string> {
  const body = OFFICE_SOURCE.slice(OFFICE_SOURCE.indexOf("pub const BACK_OFFICE_REMOTE_COMMANDS"));
  const list = body.slice(body.indexOf("= &["), body.indexOf("];"));
  return new Set([...list.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!));
}

/** Every `"name" => {` arm inside a `dispatch_remote_office` function, across all command files. */
function rustArms(): Set<string> {
  const arms = new Set<string>();
  for (const f of readdirSync(CMD_DIR).filter((n) => n.endsWith(".rs"))) {
    const src = readFileSync(CMD_DIR + f, "utf8");
    const at = src.indexOf("fn dispatch_remote_office");
    if (at < 0) continue;
    for (const m of src.slice(at).matchAll(/^\s*"([a-z0-9_]+)"\s*=>\s*\{/gm)) arms.add(m[1]!);
  }
  return arms;
}

describe("BACK_OFFICE_REMOTE_COMMANDS stays in sync with the hub", () => {
  it("the parsers find a plausible number of commands", () => {
    expect(rustList().size).toBeGreaterThan(100);
    expect(rustArms().size).toBeGreaterThan(100);
  });

  it("TS and Rust name exactly the same commands", () => {
    const rust = rustList();
    expect([...BACK_OFFICE_REMOTE_COMMANDS].filter((c) => !rust.has(c))).toEqual([]);
    expect([...rust].filter((c) => !BACK_OFFICE_REMOTE_COMMANDS.has(c))).toEqual([]);
  });

  it("every command on the list has a hub arm and every hub arm is on the list", () => {
    const arms = rustArms();
    expect([...BACK_OFFICE_REMOTE_COMMANDS].filter((c) => !arms.has(c))).toEqual([]);
    expect([...arms].filter((c) => !BACK_OFFICE_REMOTE_COMMANDS.has(c))).toEqual([]);
  });

  it("is disjoint from the till commands and from what stays on this machine", () => {
    for (const c of BACK_OFFICE_REMOTE_COMMANDS) {
      expect(LAN_REDIRECT_COMMANDS.has(c), c).toBe(false);
      expect(HUB_ONLY_WRITES.has(c), c).toBe(false);
    }
  });

  it("never forwards device-local work", () => {
    for (const c of [
      "list_printers_v3", "create_printer_v3", "set_printer_active_v3", "update_printer_paper_width_v3", "set_printer_categories_v3", "set_printer_template_v3",
      "print_raw_bytes_v3", "print_network_raw_v3", "get_device_id_v3", "check_license_v3", "activate_license_v3", "renew_license_v3",
      "backup_database_v3", "list_backups_v3", "update_backup_settings_v3", "send_diagnostics_report_v3",
      "get_lan_status_v3", "enable_hub_mode_v3", "request_pairing_v3", "set_remote_device_back_office_v3", "list_remote_devices_v3",
      "enrol_fingerprint_v3", "fingerprint_punch_v3", "export_pdf_v3", "ask_assistant_v3", "update_business_mode_v3",
      "login_pin_v3", "change_own_password_v3",
    ]) {
      expect(BACK_OFFICE_REMOTE_COMMANDS.has(c), c).toBe(false);
    }
  });

  it("covers the back-office areas the owner asked for", () => {
    for (const c of [
      "get_sales_report_v3", "get_dashboard_summary_v3", "get_cost_report_v3", "list_rent_contracts_v3",
      "list_ingredients_v3", "produce_batch_v3", "record_waste_v3", "list_purchase_orders_v3", "list_suppliers_v3",
      "create_menu_item_v3", "update_menu_item_v3", "delete_category_v3", "save_option_group_v3", "create_happy_hour_rule_v3",
      "list_staff_v3", "payroll_month_v3", "list_attendance_v3", "list_customers_v3", "list_debt_entries_v3",
      "save_delivery_platform_v3", "save_receipt_template_v3",
    ]) {
      expect(BACK_OFFICE_REMOTE_COMMANDS.has(c), c).toBe(true);
    }
  });

  it("the hub wording of the refusal is the one the app knows", () => {
    expect(LAN_SOURCE).toContain(BACK_OFFICE_REFUSED);
  });
});

describe("a back-office command on a second till", () => {
  beforeEach(() => {
    tauriCalls.length = 0;
    invalidateLanTargetCache();
    relayAnswer = { redirected: false };
  });

  it("is relayed to the hub and returns the hub's data when the hub allows this device", async () => {
    relayAnswer = { redirected: true, data: { total: 123 }, error: null };
    const r = await invoke<{ total: number }>("get_sales_report_v3", { sessionToken: "t", startIso: "a", endIso: "b" });
    expect(r).toEqual({ total: 123 });
    expect(tauriCalls.map((c) => c.cmd)).toContain("lan_relay_v3");
    expect(tauriCalls.map((c) => c.cmd)).not.toContain("get_sales_report_v3");
  });

  it("a menu edit is relayed too (it used to be refused)", async () => {
    relayAnswer = { redirected: true, data: "item-1", error: null };
    await expect(invoke("create_menu_item_v3", { sessionToken: "t" })).resolves.toBe("item-1");
    expect(tauriCalls.map((c) => c.cmd)).not.toContain("create_menu_item_v3");
  });

  it("shows the hub's Arabic refusal when this device is not allowed, instead of a blank page", async () => {
    relayAnswer = { redirected: true, data: null, error: BACK_OFFICE_REFUSED };
    await expect(invoke("list_ingredients_v3", { sessionToken: "t" })).rejects.toThrow(BACK_OFFICE_REFUSED);
  });

  it("runs locally on a hub or standalone till", async () => {
    relayAnswer = { redirected: false };
    await expect(invoke("list_ingredients_v3", { sessionToken: "t" })).resolves.toBe("local");
  });
});

describe("the sidebar of a second till", () => {
  const nav = getNavForRole("OWNER");
  const ids = (items: { id: string }[]) => items.map((n) => n.id);

  it("hides the back-office pages until the hub allows this device, keeping the till, settings and guide", () => {
    const shown = ids(applyBackOfficeAccess(nav, { isSatellite: true, allowed: false }));
    for (const p of SATELLITE_BACK_OFFICE_PAGES) expect(shown).not.toContain(p);
    for (const keep of ["pos", "shift", "orders", "delivery", "settings", "guide"]) expect(shown).toContain(keep);
  });

  it("shows everything the role has once the hub allows it", () => {
    expect(ids(applyBackOfficeAccess(nav, { isSatellite: true, allowed: true }))).toEqual(ids(nav));
  });

  it("never changes a hub, a standalone till or an unanswered question", () => {
    expect(applyBackOfficeAccess(nav, { isSatellite: false, allowed: true })).toBe(nav);
    expect(applyBackOfficeAccess(nav, null)).toBe(nav);
  });

  it("a cashier's pages are untouched either way", () => {
    const cashier = getNavForRole("CASHIER");
    expect(ids(applyBackOfficeAccess(cashier, { isSatellite: true, allowed: false })).sort()).toEqual(ids(cashier).filter((i) => !SATELLITE_BACK_OFFICE_PAGES.has(i)).sort());
  });
});
