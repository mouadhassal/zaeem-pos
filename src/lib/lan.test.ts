import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What the terminal's own Tauri bridge answers. `lan_relay_v3` is the Rust
// command that decides "am I a satellite?" and forwards to the Hub.
let relayAnswer: unknown = { redirected: false };
let relayThrows = false;
const tauriCalls: { cmd: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    tauriCalls.push({ cmd, args });
    if (cmd === "lan_relay_v3") {
      if (relayThrows) throw new Error("no tauri runtime");
      return relayAnswer;
    }
    return undefined;
  },
}));

const localCalls: { cmd: string; args: unknown }[] = [];
vi.mock("./invoke", () => ({
  invoke: async (cmd: string, args: unknown) => {
    localCalls.push({ cmd, args });
    return [{ id: "local-printer" }];
  },
}));

import { HUB_ONLY_HELPERS, LAN_REDIRECT_COMMANDS, invokeOnHub } from "./lan";

const RPC_SOURCE = readFileSync(fileURLToPath(new URL("../../src-tauri/src/commands/lan_rpc.rs", import.meta.url)), "utf8");

/** Every `"name" => {` arm of `dispatch_lan_rpc`. */
function rustArms(): Set<string> {
  const dispatch = RPC_SOURCE.slice(RPC_SOURCE.indexOf("pub fn dispatch_lan_rpc"));
  return new Set([...dispatch.matchAll(/^\s*"([a-z0-9_]+)"\s*=>\s*\{/gm)].map((m) => m[1]!));
}

/** Arms that are reachable over the LAN but are not frontend-redirected commands. */
const NOT_REDIRECTED_ARMS = new Set(["__resolve_actor_v3", ...HUB_ONLY_HELPERS]);

describe("LAN_REDIRECT_COMMANDS stays in sync with dispatch_lan_rpc", () => {
  it("finds a plausible number of Rust arms (the parser itself works)", () => {
    expect(rustArms().size).toBeGreaterThan(50);
  });

  it("every redirected command has a Hub arm (else the satellite call dies with UNKNOWN_COMMAND)", () => {
    const arms = rustArms();
    const missing = [...LAN_REDIRECT_COMMANDS].filter((c) => !arms.has(c));
    expect(missing).toEqual([]);
  });

  it("every Hub arm is either redirected or a deliberate Hub-only helper (else it is dead or forgotten)", () => {
    const orphans = [...rustArms()].filter((a) => !LAN_REDIRECT_COMMANDS.has(a) && !NOT_REDIRECTED_ARMS.has(a));
    expect(orphans).toEqual([]);
  });

  it("the Hub-only helpers have arms and are NOT redirected for every caller", () => {
    const arms = rustArms();
    for (const c of HUB_ONLY_HELPERS) {
      expect(arms.has(c)).toBe(true);
      expect(LAN_REDIRECT_COMMANDS.has(c)).toBe(false);
    }
  });

  it("per-device things never go to the Hub", () => {
    for (const c of [
      "list_printers_v3", "print_raw_bytes_v3", "print_network_raw_v3", "print_image_driver_v3", "list_system_printers_v3",
      "get_receipt_config_v3", "get_chain_config_v3", "get_device_id_v3", "get_cached_license_status_v3", "check_license_v3",
      "backup_database_v3", "get_lan_status_v3", "request_pairing_v3", "update_chain_name_v3", "update_business_mode_v3",
    ]) {
      expect(LAN_REDIRECT_COMMANDS.has(c)).toBe(false);
    }
  });

  it("the second-till selling path is redirected", () => {
    for (const c of [
      "list_menu_items_v3", "list_categories_v3", "list_option_groups_v3", "list_combo_meals_v3",
      "add_items_to_order_v3", "finalize_order_with_payment_v3", "hold_order_v3", "retrieve_held_order_v3",
      "edit_order_item_v3", "set_order_item_comp_v3", "set_delivery_status_v3", "list_deliveries_v3",
    ]) {
      expect(LAN_REDIRECT_COMMANDS.has(c)).toBe(true);
    }
  });
});

describe("invokeOnHub", () => {
  beforeEach(() => {
    relayAnswer = { redirected: false };
    relayThrows = false;
    tauriCalls.length = 0;
    localCalls.length = 0;
  });

  it("on a satellite, answers from the Hub and never runs the local command", async () => {
    relayAnswer = { redirected: true, data: [{ id: "hub-kitchen" }], error: null };
    const r = await invokeOnHub<{ id: string }[]>("list_active_printers_v3", { sessionToken: "t" });
    expect(r).toEqual({ data: [{ id: "hub-kitchen" }], viaHub: true });
    expect(localCalls).toEqual([]);
    expect(tauriCalls[0]).toEqual({ cmd: "lan_relay_v3", args: { command: "list_active_printers_v3", args: { sessionToken: "t" } } });
  });

  it("on a standalone or Hub terminal, runs the command locally", async () => {
    const r = await invokeOnHub<{ id: string }[]>("list_active_printers_v3", { sessionToken: "t" });
    expect(r).toEqual({ data: [{ id: "local-printer" }], viaHub: false });
    expect(localCalls).toEqual([{ cmd: "list_active_printers_v3", args: { sessionToken: "t" } }]);
  });

  it("when the Hub cannot be reached it fails loudly instead of quietly using the local (wrong) printer list", async () => {
    relayAnswer = { redirected: true, data: null, error: "could not reach hub: connection refused" };
    await expect(invokeOnHub("list_active_printers_v3", { sessionToken: "t" })).rejects.toThrow("could not reach hub");
    expect(localCalls).toEqual([]);
  });

  it("with no Tauri runtime (preview, unit tests) it behaves like a standalone terminal", async () => {
    relayThrows = true;
    const r = await invokeOnHub<{ id: string }[]>("list_active_printers_v3", { sessionToken: "t" });
    expect(r.viaHub).toBe(false);
    expect(localCalls.length).toBe(1);
  });
});
