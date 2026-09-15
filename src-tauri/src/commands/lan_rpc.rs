use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;
use super::auth::{login_pin_v3_impl, logout_v3_impl};
use super::orders::{list_tables_v3_impl, list_kitchen_orders_v3_impl, update_order_status_v3_impl, create_full_order_v3_impl, void_order_item_v3_impl, take_payment_v3_impl};
use super::shifts::{get_active_shift_v3_impl, clock_in_v3_impl, clock_out_v3_impl, open_shift_v3_impl, close_shift_v3_impl, get_shift_stats_v3_impl};

// T3.0 LAN hub/satellite: Phase 1 RPC dispatch allowlist. See `lan.rs`'s
// module doc for the full design. Every arm here calls the SAME, real,
// unmodified `#[tauri::command]` function a local/standalone terminal
// would call -- there is no parallel business-logic path, only a second
// way to reach the existing one. Deliberately a curated allowlist, not
// "every command": commands not listed here simply aren't available to a
// Satellite in Phase 1 (menu/inventory/supplier/finance management, for
// example) -- those still need to be done from the Hub terminal itself
// for now. Growing this list is safe and additive; it never changes what
// a Hub or standalone terminal does.
// ---------------------------------------------------------------------------

/// True for any command whose success means an order/table/kitchen-queue
/// changed -- exactly the set of events a KDS (or any other Satellite)
/// needs to know to re-fetch. Deliberately conservative (a false positive
/// here just costs one harmless extra re-fetch; a false negative would
/// mean a Satellite silently goes stale).
pub fn lan_rpc_mutates_orders(command: &str) -> bool {
    matches!(
        command,
        "create_full_order_v3"
            | "create_order_v3"
            | "update_order_status_v3"
            | "void_order_item_v3"
            | "take_payment_v3"
            | "finalize_order_with_payment_v3"
            | "hold_order_v3"
            | "retrieve_held_order_v3"
            | "transfer_order_v3"
            | "split_bill_v3"
            | "merge_tables_v3"
            | "unmerge_tables_v3"
    )
}

/// Parses `args[key]` into `T`, treating a missing key the same as JSON
/// `null` (so an `Option<T>` field the frontend simply omits still
/// deserializes correctly, matching how Tauri's own IPC argument binding
/// already behaves for optional params).
fn lan_arg<T: serde::de::DeserializeOwned>(args: &serde_json::Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|e| format!("invalid or missing '{key}': {e}"))
}

/// The Phase 1 dispatcher. `args` is exactly the JSON object the frontend
/// already builds for `invoke(command, args)` -- a Satellite's `invoke()`
/// wrapper forwards that object over the LAN completely unchanged (see
/// `invoke.ts`), so nothing about a page's own calling code needs to know
/// or care whether it's talking to its own local Tauri backend or a
/// paired Hub over the network.
///
/// Takes a plain `&Db`/`&CloudLicenseState`, NOT a `tauri::AppHandle` --
/// deliberately, so this function is reachable both from the Hub's real
/// axum handler (which gets these via `AppHandle::state::<T>()`, a
/// `State<T>` that derefs to exactly this) AND from a unit test with a
/// real `Db`/`CloudLicenseState` built the same way every other test in
/// `command_wrapper_tests` already does -- `tauri::test::mock_builder()`
/// is confirmed to crash this dev box (see that module's own doc
/// comment), so anything built on top of a real `tauri::App`/`State<T>`
/// would be untestable here.
pub fn dispatch_lan_rpc(
    db: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let result: serde_json::Value = match command {
        "login_pin_v3" => {
            let pin: String = lan_arg(&args, "pin")?;
            let device_id: String = lan_arg(&args, "deviceId")?;
            let r = login_pin_v3_impl(db, pin, device_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "logout_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            logout_v3_impl(db, session_token)?;
            serde_json::Value::Null
        }
        "list_tables_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let r = list_tables_v3_impl(db, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "list_kitchen_orders_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let r = list_kitchen_orders_v3_impl(db, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "update_order_status_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let order_id: String = lan_arg(&args, "orderId")?;
            let new_status: String = lan_arg(&args, "newStatus")?;
            update_order_status_v3_impl(db, session_token, order_id, new_status)?;
            serde_json::Value::Null
        }
        "create_full_order_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let table_id: String = lan_arg(&args, "tableId")?;
            let order_type: String = lan_arg(&args, "orderType")?;
            let items: Vec<crate::repo::OrderItemInput> = lan_arg(&args, "items")?;
            let subtotal_cents: i64 = lan_arg(&args, "subtotalCents")?;
            let tax_cents: i64 = lan_arg(&args, "taxCents")?;
            let total_cents: i64 = lan_arg(&args, "totalCents")?;
            let discount_cents: i64 = lan_arg(&args, "discountCents")?;
            let discount_reason: Option<String> = lan_arg(&args, "discountReason")?;
            let customer_name: Option<String> = lan_arg(&args, "customerName")?;
            let customer_phone: Option<String> = lan_arg(&args, "customerPhone")?;
            let delivery_address: Option<String> = lan_arg(&args, "deliveryAddress")?;
            let delivery_fee_cents: i64 = args.get("deliveryFeeCents").and_then(|v| v.as_i64()).unwrap_or(0);
            let shift_id: Option<String> = lan_arg(&args, "shiftId")?;
            let manager_override_pin: Option<String> = lan_arg(&args, "managerOverridePin")?;
            let r = create_full_order_v3_impl(
                db, license, session_token, table_id, order_type, items, subtotal_cents, tax_cents,
                total_cents, discount_cents, discount_reason, customer_name, customer_phone,
                delivery_address, delivery_fee_cents, shift_id, manager_override_pin,
            )?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "void_order_item_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let item_id: String = lan_arg(&args, "itemId")?;
            let reason: String = lan_arg(&args, "reason")?;
            let manager_override_pin: Option<String> = lan_arg(&args, "managerOverridePin")?;
            void_order_item_v3_impl(db, license, session_token, item_id, reason, manager_override_pin)?;
            serde_json::Value::Null
        }
        "take_payment_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let order_id: String = lan_arg(&args, "orderId")?;
            let method: String = lan_arg(&args, "method")?;
            let amount_cents: i64 = lan_arg(&args, "amountCents")?;
            let change_cents: i64 = args.get("changeCents").and_then(|v| v.as_i64()).unwrap_or(0);
            let debtor_id: Option<String> = lan_arg(&args, "debtorId")?;
            let r = take_payment_v3_impl(db, license, session_token, order_id, method, amount_cents, change_cents, debtor_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_active_shift_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let r = get_active_shift_v3_impl(db, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "clock_in_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let user_id: String = lan_arg(&args, "userId")?;
            clock_in_v3_impl(db, license, session_token, user_id)?;
            serde_json::Value::Null
        }
        "clock_out_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let user_id: String = lan_arg(&args, "userId")?;
            clock_out_v3_impl(db, license, session_token, user_id)?;
            serde_json::Value::Null
        }
        // T3.0 follow-up: a shift opened/closed on a Satellite must live in
        // the SAME `shifts` table its orders/payments already land in (the
        // Hub's) -- otherwise end-of-shift cash reconciliation reads an
        // empty local table while the drawer holds real Hub-recorded
        // sales. See the audit that flagged this as the #1 remaining gap
        // after Phase 1's order/table redirection.
        "open_shift_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let starting_cash_cents: i64 = lan_arg(&args, "startingCashCents")?;
            let branch_id: Option<String> = lan_arg(&args, "branchId")?;
            let r = open_shift_v3_impl(db, license, session_token, starting_cash_cents, branch_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "close_shift_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let shift_id: String = lan_arg(&args, "shiftId")?;
            let ending_cash_cents: i64 = lan_arg(&args, "endingCashCents")?;
            let difference_cents: i64 = lan_arg(&args, "differenceCents")?;
            let manager_override_pin: Option<String> = lan_arg(&args, "managerOverridePin")?;
            close_shift_v3_impl(db, session_token, shift_id, ending_cash_cents, difference_cents, manager_override_pin)?;
            serde_json::Value::Null
        }
        "get_shift_stats_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let shift_id: String = lan_arg(&args, "shiftId")?;
            let r = get_shift_stats_v3_impl(db, session_token, shift_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        // Resolves a session token that only exists in the Hub's own
        // `session_v3` table (every login is redirected -- staff accounts
        // are Hub-authoritative) into an `Actor` a Satellite can use
        // locally. Not a real business command and never on the frontend
        // allowlist directly -- `authenticate_actor`'s own Hub-fallback
        // path (see `lan::resolve_actor_via_hub`) is the only caller, for
        // every one of the ~140 commands NOT on the Phase 1 allowlist that
        // would otherwise see a session that "doesn't exist" the moment a
        // cashier logs in at a Satellite.
        "__resolve_actor_v3" => {
            let session_token: String = lan_arg(&args, "sessionToken")?;
            let actor = authenticate_actor(db, &session_token)?;
            serde_json::to_value(ActorWire {
                id: actor.id,
                tenant_id: actor.tenant_id,
                branch_id: actor.branch_id,
                role: actor.role,
                device_id: actor.device_id,
            }).map_err(|e| e.to_string())?
        }
        _ => return Err("UNKNOWN_COMMAND".to_string()),
    };
    Ok(result)
}

