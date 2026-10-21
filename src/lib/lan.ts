import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke } from "./invoke";

/**
 * LAN RPC allowlist -- every command here is sent to the branch's Hub when
 * this terminal is a paired Satellite, and runs against the Hub's SQLite
 * instead of this terminal's own (empty) one. Must match the `"name" =>`
 * arms of `dispatch_lan_rpc` in `src-tauri/src/commands/lan_rpc.rs`
 * (`lan.test.ts` fails if the two drift apart). A command NOT in this set
 * always runs against this terminal's own local SQLite, even on a
 * Satellite: that is deliberate for per-device things (printers, settings,
 * license, backups, LAN config, device id) and for
 * back-office work (reports, staff, inventory, menu editing), which is done
 * on the Hub terminal.
 *
 * What IS forwarded is everything the till needs to sell from the Hub's
 * data: the shared menu (items, categories, options, combos, happy hours,
 * photos), tables, open tabs, hold/retrieve, add-to-order, edit/gift of a
 * line, split/merge/transfer, delayed orders, payment, shifts, manager
 * override, the branch's tax/currency/receipt header, debtors, loyalty, and
 * delivery.
 */
export const LAN_REDIRECT_COMMANDS = new Set([
  // session + shift
  "login_pin_v3",
  "logout_v3",
  "get_active_shift_v3",
  "clock_in_v3",
  "clock_out_v3",
  "open_shift_v3",
  "close_shift_v3",
  "get_shift_stats_v3",
  "verify_manager_override_v3",
  "get_manager_thresholds_v3",
  "get_discount_caps_v3",
  "get_business_mode_v3",
  "get_chain_config_v3",
  "get_receipt_config_v3",
  // shared menu (the Hub owns item ids, prices, availability)
  "list_menu_items_v3",
  "list_categories_v3",
  "list_option_groups_v3",
  "list_combo_meals_v3",
  "list_combo_meal_items_v3",
  "list_combo_components_v3",
  "list_happy_hour_rules_v3",
  "get_menu_item_photo_v3",
  "toggle_menu_item_availability_v3",
  // tables and orders
  "list_tables_v3",
  "create_table_v3",
  "rename_table_v3",
  "delete_table_v3",
  "list_kitchen_orders_v3",
  "update_order_status_v3",
  "create_full_order_v3",
  "list_pending_orders_for_table_v3",
  "retrieve_open_order_v3",
  "retrieve_held_order_v3",
  "add_items_to_order_v3",
  "hold_order_v3",
  "edit_order_item_v3",
  "set_order_item_comp_v3",
  "void_order_item_v3",
  "transfer_order_v3",
  "split_bill_v3",
  "merge_tables_v3",
  "unmerge_tables_v3",
  "schedule_delayed_order_v3",
  "activate_delayed_orders_v3",
  // payment
  "take_payment_v3",
  "finalize_order_with_payment_v3",
  // customers on the till: debtors and loyalty
  "list_debtors_v3",
  "create_debtor_v3",
  "lookup_loyalty_card_v3",
  "list_loyalty_rewards_v3",
  "redeem_loyalty_reward_v3",
  // delivery
  "get_delivery_settings_v3",
  "list_delivery_drivers_v3",
  "list_deliveries_v3",
  "assign_delivery_driver_v3",
  "set_delivery_status_v3",
  "settle_driver_v3",
  "get_driver_statement_v3",
  "list_driver_settlements_v3",
]);

/**
 * Commands that have a Hub arm in `dispatch_lan_rpc` but are NOT redirected
 * for every caller: they are only ever asked of the Hub on purpose, through
 * `invokeOnHub`. Everything else on a Satellite stays local. (The Rust arm
 * `__resolve_actor_v3` is a third kind -- called by the Hub-fallback in
 * `authenticate_actor`, never by the frontend.)
 */
export const HUB_ONLY_HELPERS = new Set(["list_active_printers_v3", "list_printer_categories_v3"]);


interface LanRelayResult<T> {
  redirected: boolean;
  data?: T;
  error?: string | null;
}

/**
 * Called by `invoke.ts` for every command on `LAN_REDIRECT_COMMANDS`
 * before it would otherwise run locally. Returns `{ redirected: false }`
 * for the overwhelming majority of calls (standalone and Hub terminals,
 * which never redirect) -- the caller falls through to the normal local
 * `invoke` in that case, at the cost of one extra cheap round-trip to a
 * synchronous file read on the Rust side.
 */
export async function relayIfSatellite<T>(command: string, args?: Record<string, unknown>): Promise<LanRelayResult<T>> {
  return tauriInvoke<LanRelayResult<T>>("lan_relay_v3", { command, args: args ?? {} });
}

/**
 * Runs `command` on the Hub when this terminal is a paired Satellite, and
 * locally otherwise -- without putting the command on
 * `LAN_REDIRECT_COMMANDS`. Used by the kitchen-ticket path: the kitchen
 * network printers and their category routing are configured on the Hub, so
 * a Satellite must read them from there, while the same screens' settings
 * pages (and receipt printing, often a USB printer on this very machine)
 * keep reading this terminal's own printer list.
 *
 * `viaHub` tells the caller which side the answer came from. If the relay
 * probe itself cannot run (no Tauri runtime, e.g. unit tests or the browser
 * preview) this behaves as a standalone terminal. A relayed call that
 * fails (Hub unreachable) is an error, never a silent local fallback: the
 * local answer would be a different, wrong printer list.
 */
export async function invokeOnHub<T>(command: string, args?: Record<string, unknown>): Promise<{ data: T; viaHub: boolean }> {
  let relayed: LanRelayResult<T> | null = null;
  try {
    relayed = await relayIfSatellite<T>(command, args);
  } catch {
    relayed = null;
  }
  if (relayed?.redirected) {
    if (relayed.error) throw new Error(relayed.error);
    return { data: relayed.data as T, viaHub: true };
  }
  return { data: await invoke<T>(command, args), viaHub: false };
}

let cachedHubAddr: string | null | undefined;

async function getHubAddr(): Promise<string | null> {
  if (cachedHubAddr !== undefined) return cachedHubAddr;
  try {
    const target = await tauriInvoke<{ hubAddr: string } | null>("get_lan_redirect_target_v3");
    cachedHubAddr = target?.hubAddr ?? null;
  } catch {
    cachedHubAddr = null;
  }
  return cachedHubAddr;
}

/** Call after pairing/forgetting so the next `connectLanChangeSocket` picks up the new role without an app restart. */
export function invalidateLanTargetCache(): void {
  cachedHubAddr = undefined;
}

/**
 * Opens a WebSocket to the paired Hub's "something changed" broadcast
 * (see `broadcast_change` in `lan.rs`) and calls `onChange` for every
 * message -- the payload itself carries no data, it's just a nudge to
 * re-fetch, so callers should already have a working `fetchX()` to re-run.
 * No-op (returns a no-op cleanup) on standalone/Hub terminals. Reconnects
 * with a fixed backoff on drop (bad Wi-Fi, Hub restart) since this exists
 * to survive exactly that.
 */
export function connectLanChangeSocket(onChange: () => void): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function connect() {
    if (stopped) return;
    const hubAddr = await getHubAddr();
    if (!hubAddr || stopped) return;
    try {
      socket = new WebSocket(`ws://${hubAddr}/ws`);
      socket.onmessage = () => onChange();
      socket.onclose = scheduleRetry;
      socket.onerror = () => socket?.close();
    } catch {
      scheduleRetry();
    }
  }

  function scheduleRetry() {
    if (stopped) return;
    retryTimer = setTimeout(connect, 5000);
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
