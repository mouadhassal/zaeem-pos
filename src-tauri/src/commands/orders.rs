use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;
use super::settings::resolve_order_table_id;

#[tauri::command]
pub fn list_orders_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<OrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ViewOrders).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_orders(&scope).map_err(|e| e.to_string())
}

/// Back-office command -- feeds the refund lookup UI (reports/page.tsx's
/// "الطلبات المدفوعة" section). See Repo::list_recent_paid_orders's own
/// doc comment for why this is capped and joined for display, not a reuse
/// of list_orders_v3 above.
#[tauri::command]
pub fn list_recent_paid_orders_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::RefundableOrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::RefundOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_recent_paid_orders(&scope, 50).map_err(|e| e.to_string())
}

/// `kds/page.tsx`'s kitchen display feed.
#[tauri::command]
pub fn list_kitchen_orders_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::KdsOrderRow>, String> {
    list_kitchen_orders_v3_impl(&state, session_token)
}

pub(crate) fn list_kitchen_orders_v3_impl(state: &Db, session_token: String) -> Result<Vec<crate::repo::KdsOrderRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::ViewOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_kitchen_orders(&actor.scope()).map_err(|e| e.to_string())
}

/// T2.0 per-terminal licensing (plan §2): registers this KDS terminal in
/// the cloud for fleet visibility ONLY -- deliberately FREE. No license
/// check (`require_license_not_locked` is never called here, same as
/// `list_kitchen_orders_v3` above -- KDS is a display, not a till), no
/// device_token, no billing row. Called once from `kds/page.tsx` on mount.
///
/// Still requires a real, authenticated staff session (not a bare
/// unauthenticated endpoint) -- this reuses the actor's own tenant_id/
/// branch_id rather than trusting client-supplied ids, even though the
/// data behind this is low-stakes (fleet visibility, not money). The
/// actual Supabase write is fire-and-forget on a spawned task: a
/// kitchen with no internet, or a Supabase outage, must never delay or
/// block the kitchen display from opening -- this command always returns
/// `Ok(())` to the frontend immediately, logging (not surfacing) any
/// eventual failure.
#[tauri::command]
pub fn register_kds_terminal_v3(state: State<Db>, session_token: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Ok(()); // Owner/Platform never run a KDS terminal.
    };
    let fingerprint = crate::license::fingerprint::current();
    let device_name = format!("KDS - {}", actor.device_id);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::license::cloud::register_kds_device(&tenant_id, &branch_id, &device_name, &fingerprint).await {
            crate::obslog::log_frontend_command_error("register_kds_terminal_v3", &e);
        }
    });
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_order_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    table_id: String,
    order_type: String,
    subtotal_cents: i64,
    tax_cents: i64,
    discount_cents: i64,
    manager_override_pin: Option<String>,
) -> Result<String, String> {
    create_order_v3_impl(&state, &license, session_token, table_id, order_type, subtotal_cents, tax_cents, discount_cents, manager_override_pin)
}

/// Real body, `&Db` instead of `State<Db>` -- see `authenticate_actor`'s doc
/// comment for why. Command-wrapper tests call this exact function.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_order_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    table_id: String,
    order_type: String,
    subtotal_cents: i64,
    tax_cents: i64,
    discount_cents: i64,
    manager_override_pin: Option<String>,
) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;

    // Owner has no single home branch by role -- but the physical terminal
    // does (its own license binding), so this auto-resolves instead of
    // rejecting outright. Platform still has nothing to write into.
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };

    if subtotal_cents < 0 || tax_cents < 0 || discount_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let total_cents = std::cmp::max(0, subtotal_cents + tax_cents - discount_cents);

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    // Same shift-required gate `create_full_order_v3_impl` already
    // enforces (2026-08-02 finding) -- this older, simpler command
    // (superseded by create_full_order_v3 for the real POS UI, but still
    // a registered, directly-invokable Tauri command) had never received
    // the same fix, a real gap a devtools/console caller could still hit.
    Repo::new(&conn)
        .get_active_shift(&actor.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "لا توجد وردية مفتوحة -- يجب فتح وردية أولاً قبل البيع".to_string())?;
    let override_used = enforce_discount_cap(&mut conn, &actor, &tenant_id, subtotal_cents, discount_cents, manager_override_pin.as_deref())?;

    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let order_id = Repo::new(&tx)
        .create_order(
            &scope,
            &tenant_id,
            &branch_id,
            NewOrder { table_id, user_id: actor.id.clone(), order_type: order_type.clone(), subtotal_cents, tax_cents, total_cents, discount_cents },
        )
        .map_err(|e| e.to_string())?;

    // T1.6: the first status fact for this order, and the projection rebuilt
    // from a fresh replay -- not a separate "status" column set inline on
    // the INSERT above. `order_current` never exists before its first event.
    Repo::new(&tx).append_order_status_event(&tenant_id, &branch_id, &order_id, "PENDING", &actor.id, &actor.device_id)
        .map_err(|e| e.to_string())?;
    Repo::new(&tx).rebuild_order_current(&order_id).map_err(|e| e.to_string())?;

    // Per T1.2's command shape: audit write in the SAME transaction. If this
    // fails, the order insert above rolls back with it -- there is no state
    // where an order exists but its creation was never recorded.
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderCreated, "order", &order_id,
        None, Some(&serde_json::json!({ "order_type": order_type, "total_cents": total_cents, "table_id_hash": "omitted" })),
    ).map_err(|e| e.to_string())?;

    // Anti-theft record: every applied discount is logged (who, how much,
    // which order), independent of the ManagerOverrideGranted entry (if
    // any) written by `enforce_discount_cap` above.
    if discount_cents > 0 {
        audit::append(
            &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
            audit::Action::DiscountApplied, "order", &order_id,
            None, Some(&serde_json::json!({ "discount_cents": discount_cents, "subtotal_cents": subtotal_cents, "manager_override_used": override_used })),
        ).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(order_id)
}

/// T1.6: appends a new status fact and rebuilds `order_current` from a fresh
/// replay, all inside one transaction with its audit entry -- there is no
/// UPDATE anywhere in this path against `orders.status` or `order_current`
/// directly; both are always derived, never hand-edited.
#[tauri::command]
pub fn update_order_status_v3(state: State<Db>, session_token: String, order_id: String, new_status: String) -> Result<(), String> {
    update_order_status_v3_impl(&state, session_token, order_id, new_status)
}

pub(crate) fn update_order_status_v3_impl(state: &Db, session_token: String, order_id: String, new_status: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::UpdateOrderStatus).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (order_tenant_id, order_branch_id): (String, String) = conn
        .query_row("SELECT tenant_id, branch_id FROM orders WHERE id = ?1", params![order_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    authorize_scope(&actor, &order_tenant_id, Some(order_branch_id.as_str())).map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let repo = Repo::new(&tx);
    let previous_status = repo.replay_order_status(&order_id).map_err(|e| e.to_string())?;
    crate::order_lifecycle::validate_order_status_transition(&previous_status, &new_status)?;
    repo.append_order_status_event(&order_tenant_id, &order_branch_id, &order_id, &new_status, &actor.id, &actor.device_id)
        .map_err(|e| e.to_string())?;
    repo.rebuild_order_current(&order_id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &order_tenant_id, Some(&order_branch_id), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        Some(&serde_json::json!({ "status": previous_status })),
        Some(&serde_json::json!({ "status": new_status })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// T1.9's critical acceptance criterion: order -> PAID, the payment row,
/// table -> FREE, the optional debt entry, the order_current rebuild, AND
/// the audit entry all happen inside ONE transaction, committed once. Kill
/// -9 at any point before `tx.commit()` returns and NONE of this landed --
/// never a PAID order on an OCCUPIED table, never a payment without an
/// order. See `repo::Repo::take_payment` for the actual writes and
/// `commands_v3::tests::kill_9_mid_payment_never_leaves_a_partial_payment`
/// for the proof.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn take_payment_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    order_id: String,
    method: String,
    amount_cents: i64,
    change_cents: i64,
    debtor_id: Option<String>,
) -> Result<String, String> {
    take_payment_v3_impl(&state, &license, session_token, order_id, method, amount_cents, change_cents, debtor_id)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn take_payment_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    order_id: String,
    method: String,
    amount_cents: i64,
    change_cents: i64,
    debtor_id: Option<String>,
) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("take_payment_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::TakePayment).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };
    if amount_cents < 0 || change_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let payment_id = Repo::new(&tx)
        .take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
            order_id: order_id.clone(), method: method.clone(), amount_cents, change_cents,
            debtor_id: debtor_id.clone(), actor_id: actor.id.clone(),
        })
        .map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PaymentTaken, "order", &order_id,
        None, Some(&serde_json::json!({ "payment_id": payment_id, "method": method, "amount_cents": amount_cents, "change_cents": change_cents, "debtor_id": debtor_id })),
    ).map_err(|e| e.to_string())?;

    // `Repo::take_payment` just deducted recipe-linked ingredient stock
    // (`deplete_recipe_stock`) for every non-voided item on this order --
    // queue the current snapshot of each ingredient touched.
    let license_status = license.cached_status();
    sync_enqueue_recipe_ingredients_for_order(&tx, &tenant_id, &branch_id, &order_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(payment_id)
}

pub(crate) const MANAGER_OVERRIDE_MAX_ATTEMPTS: i64 = 5;
const MANAGER_OVERRIDE_LOCKOUT_SECONDS: i64 = 5 * 60;
const MANAGER_OVERRIDE_FAILURES_KEY: &str = "manager_pin_failures";
const MANAGER_OVERRIDE_LOCKED_UNTIL_KEY: &str = "manager_pin_locked_until";

/// Replaces the old, unscoped, unaudited `verify_manager_override` command
/// (Batch 3b, Slice B verification finding): that command took no session,
/// no scope, picked an arbitrary `LIMIT 1` manager row from the ENTIRE
/// `staff` table with no tenant/branch filter at all, and never logged a
/// successful override anywhere -- for a control that authorizes voids and
/// discounts (the textbook anti-theft gate), that's a real gap, not a
/// cosmetic one.
///
/// This version: authenticates the REQUESTING actor's session first (so the
/// override is scoped to their own tenant/branch, not the whole database),
/// scans every active MANAGER/OWNER/PLATFORM staff member in that scope
/// (there may be more than one manager on a branch; the cashier doesn't
/// know which one's PIN is being entered, so all are tried), and -- on a
/// match -- writes a same-transaction audit entry naming BOTH the
/// requesting actor and the manager whose credential authorized the
/// override. The lockout/failure-count bookkeeping (previously a
/// client-side `app_settings` read via `getDb()`, trivially bypassable by
/// clearing local state) now lives here too, enforced server-side.
#[tauri::command]
pub fn verify_manager_override_v3(state: State<Db>, session_token: String, password_or_pin: String) -> Result<bool, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    verify_manager_override_impl(&mut conn, &actor, &password_or_pin)
}

/// Extracted from `verify_manager_override_v3` so the test module (which
/// exercises real `rusqlite::Connection`s directly, not a live `tauri::App`
/// -- see the test module's own doc comment) can call it without needing
/// `State<Db>`.
pub(crate) fn verify_manager_override_impl(conn: &mut rusqlite::Connection, actor: &Actor, password_or_pin: &str) -> Result<bool, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();

    let locked_until_ms: i64 = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![MANAGER_OVERRIDE_LOCKED_UNTIL_KEY], |r| r.get::<_, String>(0))
        .optional().map_err(|e| e.to_string())?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if locked_until_ms > 0 && now_ms < locked_until_ms {
        return Ok(false);
    }
    if locked_until_ms > 0 && now_ms >= locked_until_ms {
        conn.execute("DELETE FROM app_settings WHERE key IN (?1, ?2)", params![MANAGER_OVERRIDE_FAILURES_KEY, MANAGER_OVERRIDE_LOCKED_UNTIL_KEY])
            .map_err(|e| e.to_string())?;
    }

    // Every active manager-rank-or-above staff member in the requesting
    // actor's own tenant (and, for a Branch-scoped actor, that same branch
    // -- Owner/Platform staff are branch-less and can override anywhere in
    // their tenant).
    let mut stmt = conn.prepare(
        "SELECT id, password_hash, pin_hash FROM staff \
         WHERE tenant_id = ?1 AND (branch_id = ?2 OR branch_id IS NULL OR role IN ('OWNER', 'PLATFORM')) \
         AND role IN ('MANAGER', 'OWNER', 'PLATFORM') AND is_active = 1",
    ).map_err(|e| e.to_string())?;
    let candidates: Vec<(String, Option<String>, Option<String>)> = stmt
        .query_map(params![actor.tenant_id, actor.branch_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);

    let matched = candidates.into_iter().find(|(_, password_hash, pin_hash)| {
        pin_hash.clone().or_else(|| password_hash.clone())
            .map(|h| verify(password_or_pin, &h).unwrap_or(false))
            .unwrap_or(false)
    });

    match matched {
        Some((manager_id, _, _)) => {
            conn.execute("DELETE FROM app_settings WHERE key IN (?1, ?2)", params![MANAGER_OVERRIDE_FAILURES_KEY, MANAGER_OVERRIDE_LOCKED_UNTIL_KEY])
                .map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            audit::append(
                &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
                audit::Action::ManagerOverrideGranted, "staff", &manager_id,
                None, Some(&serde_json::json!({ "requested_by": actor.id, "authorized_by": manager_id })),
            ).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => {
            let failures: i64 = conn
                .query_row("SELECT value FROM app_settings WHERE key = ?1", params![MANAGER_OVERRIDE_FAILURES_KEY], |r| r.get::<_, String>(0))
                .optional().map_err(|e| e.to_string())?
                .and_then(|s| s.parse().ok())
                .unwrap_or(0) + 1;
            if failures >= MANAGER_OVERRIDE_MAX_ATTEMPTS {
                let until = now_ms + MANAGER_OVERRIDE_LOCKOUT_SECONDS * 1000;
                conn.execute(
                    "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                    params![MANAGER_OVERRIDE_LOCKED_UNTIL_KEY, until.to_string()],
                ).map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO app_settings (key, value) VALUES (?1, '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
                    params![MANAGER_OVERRIDE_FAILURES_KEY],
                ).map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                    params![MANAGER_OVERRIDE_FAILURES_KEY, failures.to_string()],
                ).map_err(|e| e.to_string())?;
            }
            Ok(false)
        }
    }
}

/// Discount cap enforcement, shared by `create_order_v3` and
/// `create_full_order_v3`. Returns `Ok(true)` if a manager override was
/// used to authorize a discount above the actor's own cap (so the caller
/// can note that in its own audit entry), `Ok(false)` if the discount was
/// within the actor's cap (including zero) and no override was needed.
/// The override itself, when used, is audited by
/// `verify_manager_override_impl` (naming both the requesting actor and
/// the authorizing manager) -- this function does not duplicate that
/// write, only the order-level `DiscountApplied` entry the caller writes.
pub(crate) fn enforce_discount_cap(
    conn: &mut rusqlite::Connection,
    actor: &Actor,
    tenant_id: &str,
    subtotal_cents: i64,
    discount_cents: i64,
    manager_override_pin: Option<&str>,
) -> Result<bool, String> {
    if discount_cents <= 0 {
        return Ok(false);
    }
    let caps = Repo::new(conn).get_discount_caps(tenant_id).map_err(|e| e.to_string())?;
    let cap_percent = caps.for_role(actor.role);
    match crate::pricing::check_discount_cap(subtotal_cents, discount_cents, cap_percent) {
        Ok(()) => Ok(false),
        Err(over) => {
            let Some(pin) = manager_override_pin else {
                return Err(over.to_string());
            };
            if verify_manager_override_impl(conn, actor, pin)? {
                Ok(true)
            } else {
                Err(over.to_string())
            }
        }
    }
}

/// §3.3 money-trust-boundary fix: the Rust command layer, not the frontend,
/// is now the authority on what an order costs. Previously
/// `create_full_order_v3`/`hold_order_v3` took `subtotal_cents`/`tax_cents`/
/// `total_cents` as trusted caller-supplied arguments -- only checked for
/// non-negativity and internal self-consistency
/// (`validate_order_money_consistency`), never against a real price or a
/// real tax computation. A modified client (or any direct Tauri command
/// invocation bypassing the real POS UI) could set `unit_price_cents` to 1
/// on every item and both the old subtotal-matches-items check AND the
/// total-matches-formula check would still pass, because both were only
/// checking arithmetic self-consistency against numbers the same hostile
/// caller supplied.
///
/// This re-prices every item from `menu_items` (see
/// `Repo::price_authoritative_items`'s own doc comment for why that table
/// and not the separate, unpopulated `menu_item_default`/`menu_item_override`
/// pair), sums the real subtotal, fetches the tenant's real tax config from
/// `chain_config`, and runs it through `pricing::calculate_tax` -- the exact
/// same rounding and "discount before tax" logic as
/// `taxCalculator.ts::calculateTax`, just no longer optional to honor.
/// Returns `(authoritative_items, subtotal_cents, combined_tax_cents,
/// total_cents)`. Callers still pass `discount_cents` in (permission-gated
/// and cap-checked separately by `enforce_discount_cap`, using THIS
/// function's authoritative subtotal, not whatever stale subtotal the
/// caller sent) and `delivery_fee_cents` (added on top, untaxed, matching
/// `orderService.ts`'s own convention).
fn price_order_authoritatively(
    conn: &rusqlite::Connection,
    tenant_id: &str,
    items: &[crate::repo::OrderItemInput],
    discount_cents: i64,
    delivery_fee_cents: i64,
) -> Result<(Vec<crate::repo::OrderItemInput>, i64, i64, i64), String> {
    let repo = Repo::new(conn);
    let priced_items = repo.price_authoritative_items(tenant_id, items).map_err(|e| e.to_string())?;
    let subtotal_cents = Repo::sum_item_total_cents(&priced_items);

    let chain_config = repo.get_chain_config(tenant_id).map_err(|e| e.to_string())?;
    let tax_config = crate::pricing::TaxConfig {
        mode: crate::pricing::TaxMode::from_str(&chain_config.tax_mode),
        tax_rate_cents: chain_config.tax_rate_cents,
        secondary_tax_rate_cents: chain_config.secondary_tax_rate_cents,
        service_charge_rate_cents: chain_config.service_charge_rate_cents,
    };
    let breakdown = crate::pricing::calculate_tax(subtotal_cents, discount_cents, &tax_config);
    let combined_tax_cents = breakdown.combined_tax_cents();
    let total_cents = std::cmp::max(0, subtotal_cents + combined_tax_cents - discount_cents + delivery_fee_cents);

    Ok((priced_items, subtotal_cents, combined_tax_cents, total_cents))
}

// ---------------------------------------------------------------------------
// Slice A -- POS flow commands. These replace the frontend's `orderService.ts`
// and `pos/page.tsx` getDb() calls with Rust-backed, auth-checked commands.
// Each write command: authn → authz → validate → repo (with transaction) →
// audit → commit.
// ---------------------------------------------------------------------------

/// Simple list of all tables. No scope filter (tables has no tenant_id/branch_id).
#[tauri::command]
pub fn list_tables_v3(state: State<Db>, session_token: String) -> Result<Vec<TableInfo>, String> {
    list_tables_v3_impl(&state, session_token)
}

pub(crate) fn list_tables_v3_impl(state: &Db, session_token: String) -> Result<Vec<TableInfo>, String> {
    crate::lan::reject_if_local_kitchen_satellite("list_tables_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_tables(&actor.scope()).map_err(|e| e.to_string())
}

/// Lets a restaurant configure any number of physical tables (0, 1, 20, ...)
/// -- previously the only ones that ever existed were 2 hardcoded dev-seed
/// rows, with no way for a real install to add its own. Same Owner/Branch
/// scope-resolution convention as `open_shift_v3`: a Branch-scoped caller
/// (Manager/Cashier/...) is pinned to their own branch; an Owner (Tenant-
/// scoped, no home branch) must pass an explicit `branch_id` naming one of
/// their own tenant's branches.
#[tauri::command]
pub fn create_table_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, branch_id: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    if name.trim().is_empty() {
        return Err("اسم الطاولة مطلوب".to_string());
    }

    // QA audit fix (2026-08-21): this used to call `resolve_branch_for_actor`
    // directly, which requires an explicit `branch_id` for any Tenant-scoped
    // caller (Owner) and fails closed with a raw, untranslated English error
    // ("select a branch first") otherwise -- exactly the friction
    // `resolve_operating_branch` (added later, see its own doc comment) was
    // built to remove for the common single-branch case, but this call site
    // was never migrated to it. Reproduced live: an Owner on a genuinely
    // single-branch tenant could not create a table at all. Settings' own
    // table-creation form (settings/page.tsx) never collects/sends a
    // branch_id either, so this was unconditionally broken for every
    // single-branch install, not just an edge case.
    let (tenant_id, resolved_branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, branch_id)?
    };

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).create_table(&tenant_id, &resolved_branch_id, name.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_table_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, table_id: String, name: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    if name.trim().is_empty() {
        return Err("table name cannot be empty".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).rename_table(&actor.scope(), &table_id, name.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_table_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, table_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).delete_table(&actor.scope(), &table_id).map_err(|e| e.to_string())
}

/// Atomic full order creation: order + items + modifiers + table→OCCUPIED.
/// Replaces `orderService.createOrder`. Returns the new order ID.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_full_order_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    table_id: String,
    order_type: String,
    items: Vec<crate::repo::OrderItemInput>,
    subtotal_cents: i64,
    tax_cents: i64,
    total_cents: i64,
    discount_cents: i64,
    discount_reason: Option<String>,
    customer_name: Option<String>,
    customer_phone: Option<String>,
    delivery_address: Option<String>,
    delivery_fee_cents: i64,
    shift_id: Option<String>,
    manager_override_pin: Option<String>,
) -> Result<String, String> {
    create_full_order_v3_impl(
        &state, &license, session_token, table_id, order_type, items, subtotal_cents, tax_cents,
        total_cents, discount_cents, discount_reason, customer_name, customer_phone,
        delivery_address, delivery_fee_cents, shift_id, manager_override_pin,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_full_order_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    table_id: String,
    order_type: String,
    items: Vec<crate::repo::OrderItemInput>,
    // No longer trusted -- the command recomputes its own authoritative
    // subtotal/tax/total via `price_order_authoritatively` below. Kept as
    // parameters so the Tauri command signature (and every existing
    // frontend call site) doesn't need to change; a caller-supplied value
    // here is now read by nobody. See `price_order_authoritatively`'s doc
    // comment for the attack this closes.
    _subtotal_cents: i64,
    _tax_cents: i64,
    _total_cents: i64,
    discount_cents: i64,
    discount_reason: Option<String>,
    customer_name: Option<String>,
    customer_phone: Option<String>,
    delivery_address: Option<String>,
    delivery_fee_cents: i64,
    // No longer trusted -- see the real `shift_id` binding resolved
    // server-side below, right before it's used.
    _shift_id: Option<String>,
    manager_override_pin: Option<String>,
) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("create_full_order_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };
    if discount_cents < 0 || delivery_fee_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    // 2026-08-02 client walkthrough finding: nothing previously stopped a
    // cashier from ringing up orders with no shift open at all -- the
    // caller-supplied `shift_id` param was trusted as-is (or silently
    // left null), so those sales never showed up in ANY shift's stats
    // (`repo.rs`'s `shift_stats` filters `orders.shift_id = ?1`), breaking
    // end-of-day cash reconciliation with zero warning. Never trust the
    // caller's claim (R1) -- always resolve the actor's own real,
    // currently-open shift server-side instead of using whatever
    // `shift_id` this call happened to pass in.
    let shift_id = Some(
        Repo::new(&conn)
            .get_active_shift(&actor.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "لا توجد وردية مفتوحة -- يجب فتح وردية أولاً قبل البيع".to_string())?
            .id,
    );
    let (items, subtotal_cents, tax_cents, total_cents) =
        price_order_authoritatively(&conn, &tenant_id, &items, discount_cents, delivery_fee_cents)?;
    let override_used = enforce_discount_cap(&mut conn, &actor, &tenant_id, subtotal_cents, discount_cents, manager_override_pin.as_deref())?;

    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let table_id = resolve_order_table_id(&tx, &tenant_id, &branch_id, &table_id)?;
    let input = FullOrderInput {
        table_id, user_id: actor.id.clone(), order_type: order_type.clone(),
        subtotal_cents, tax_cents, total_cents, discount_cents,
        discount_reason, customer_name, customer_phone, delivery_address,
        delivery_fee_cents, shift_id, items,
    };
    let order_id = Repo::new(&tx).create_full_order(&scope, &tenant_id, &branch_id, input)
        .map_err(|e| e.to_string())?;

    Repo::new(&tx).append_order_status_event(&tenant_id, &branch_id, &order_id, "PENDING", &actor.id, &actor.device_id)
        .map_err(|e| e.to_string())?;
    Repo::new(&tx).rebuild_order_current(&order_id).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderCreated, "order", &order_id,
        None, Some(&serde_json::json!({ "order_type": order_type, "total_cents": total_cents })),
    ).map_err(|e| e.to_string())?;

    if discount_cents > 0 {
        audit::append(
            &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
            audit::Action::DiscountApplied, "order", &order_id,
            None, Some(&serde_json::json!({ "discount_cents": discount_cents, "subtotal_cents": subtotal_cents, "manager_override_used": override_used })),
        ).map_err(|e| e.to_string())?;
    }

    // Sync (Plan §5, Slice 2a): queued in the SAME transaction as the order
    // and its items -- if anything above rolls back, these outbox rows never
    // existed either. No network here; a background worker drains this.
    let license_status = license.cached_status();
    sync_enqueue_order(&tx, &tenant_id, &branch_id, &order_id, &actor.device_id, &license_status)?;
    sync_enqueue_order_items(&tx, &tenant_id, &branch_id, &order_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(order_id)
}

/// Stamps `orders.rev`/`updated_at_hlc`/`device_id` (previously never
/// populated on write -- the v9 migration added the columns but nothing
/// filled them in) and queues the row's current snapshot. Called at
/// creation (rev 1) and again whenever the order's status changes to a
/// terminal state (rev 2+, see `finalize_order_with_payment_v3`).
fn sync_enqueue_order(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    order_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE orders SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, order_id],
    ).map_err(|e| e.to_string())?;

    let (status, order_type, subtotal_cents, tax_cents, total_cents, discount_cents, created_at, rev): (String, String, i64, i64, i64, i64, String, i64) = tx.query_row(
        "SELECT status, order_type, subtotal_cents, tax_cents, total_cents, discount_cents, created_at, rev FROM orders WHERE id = ?1",
        params![order_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    ).map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "id": order_id, "tenant_id": tenant_id, "branch_id": branch_id, "device_id": device_id,
        "status": status, "order_type": order_type, "subtotal_cents": subtotal_cents,
        "tax_cents": tax_cents, "total_cents": total_cents, "discount_cents": discount_cents,
        "created_at": created_at,
    });
    crate::sync::enqueue(tx, "orders", order_id, tenant_id, branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

/// Stamps and queues every item currently on `order_id` -- called once at
/// order creation (all items at rev 1). `void_order_item_v3` handles its own
/// single-item re-stamp+enqueue separately (see `sync_enqueue_single_order_item`).
fn sync_enqueue_order_items(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    order_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    let item_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM order_items WHERE order_id = ?1").map_err(|e| e.to_string())?;
        let ids = stmt.query_map(params![order_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        ids.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for item_id in item_ids {
        sync_enqueue_single_order_item(tx, tenant_id, branch_id, &item_id, device_id, license_status)?;
    }
    Ok(())
}

/// Stamps `order_items.rev`/`updated_at_hlc`/`device_id` and queues one
/// item's current snapshot -- `menu_item_name` is denormalized in
/// (looked up now, not stored by reference) so a later menu rename can never
/// rewrite this historical fact.
fn sync_enqueue_single_order_item(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    item_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE order_items SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, item_id],
    ).map_err(|e| e.to_string())?;

    let (order_id, menu_item_id, quantity, unit_price_cents, voided, rev): (String, String, i64, i64, i64, i64) = tx.query_row(
        "SELECT order_id, menu_item_id, quantity, unit_price_cents, voided, rev FROM order_items WHERE id = ?1",
        params![item_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).map_err(|e| e.to_string())?;
    let menu_item_name: String = tx.query_row("SELECT name FROM menu_items WHERE id = ?1", params![menu_item_id], |r| r.get(0))
        .unwrap_or_default();

    let payload = serde_json::json!({
        "id": item_id, "order_id": order_id, "tenant_id": tenant_id, "branch_id": branch_id,
        "menu_item_id": menu_item_id, "menu_item_name": menu_item_name,
        "quantity": quantity, "unit_price_cents": unit_price_cents, "voided": voided != 0,
    });
    crate::sync::enqueue(tx, "order_items", item_id, tenant_id, branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

/// DRAFT order + items + modifiers + table→OCCUPIED. Replaces `orderService.holdOrder`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn hold_order_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    table_id: String,
    order_type: String,
    items: Vec<crate::repo::OrderItemInput>,
    subtotal_cents: i64,
    tax_cents: i64,
    total_cents: i64,
    shift_id: Option<String>,
) -> Result<String, String> {
    hold_order_v3_impl(&state, &license, session_token, table_id, order_type, items, subtotal_cents, tax_cents, total_cents, shift_id)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn hold_order_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    table_id: String,
    order_type: String,
    items: Vec<crate::repo::OrderItemInput>,
    // No longer trusted -- see `price_order_authoritatively`. A held DRAFT
    // should show the cashier real prices when retrieved, same as a live
    // order; there's no reason a hold gets a weaker guarantee than a sale.
    _subtotal_cents: i64,
    _tax_cents: i64,
    _total_cents: i64,
    shift_id: Option<String>,
) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (items, subtotal_cents, tax_cents, total_cents) =
        price_order_authoritatively(&conn, &tenant_id, &items, 0, 0)?;
    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let table_id = resolve_order_table_id(&tx, &tenant_id, &branch_id, &table_id)?;
    let input = FullOrderInput {
        table_id, user_id: actor.id.clone(), order_type: order_type.clone(),
        subtotal_cents, tax_cents, total_cents, discount_cents: 0,
        discount_reason: None, customer_name: None, customer_phone: None,
        delivery_address: None, delivery_fee_cents: 0, shift_id, items,
    };
    let order_id = Repo::new(&tx).hold_order(&scope, &tenant_id, &branch_id, input)
        .map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderCreated, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "hold", "order_type": order_type })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(order_id)
}

/// Read a DRAFT order with all items + modifiers + menu item names.
/// Returns null if no DRAFT order with that ID exists.
#[tauri::command]
pub fn retrieve_held_order_v3(state: State<Db>, _session_token: String, order_id: String) -> Result<Option<HeldOrderResult>, String> {
    let actor = authenticate_actor(&state, &_session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).retrieve_held_order(&actor.scope(), &order_id).map_err(|e| e.to_string())
}

/// Lists PENDING orders (split-bill children included) still outstanding
/// for a table -- lets the frontend surface a "resume unpaid splits"
/// affordance for orders `retrieve_held_order_v3` can never find (those
/// are DRAFT-only) and that re-selecting the table alone does not reveal,
/// since `tables.current_order_id` only ever points at the first split.
#[tauri::command]
pub fn list_pending_orders_for_table_v3(state: State<Db>, session_token: String, table_id: String) -> Result<Vec<crate::repo::PendingOrderSummary>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_pending_orders_for_table(&actor.scope(), &table_id).map_err(|e| e.to_string())
}

/// "Send to kitchen now, pay later" dine-in fix: read back a table's OPEN
/// (already sent to the kitchen, still unpaid) order -- see
/// `Repo::retrieve_open_order`'s doc comment. Returns null if `order_id`
/// isn't currently PENDING/PREPARING/READY/SERVED (e.g. it's a DRAFT, or
/// already PAID) -- the frontend falls back to `retrieve_held_order_v3` for
/// the DRAFT case and treats null-from-both as "nothing to load."
#[tauri::command]
pub fn retrieve_open_order_v3(state: State<Db>, session_token: String, order_id: String) -> Result<Option<crate::repo::OpenOrderResult>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).retrieve_open_order(&actor.scope(), &order_id).map_err(|e| e.to_string())
}

/// "Send to kitchen now, pay later" dine-in fix: append more items to an
/// order that's already been sent to the kitchen and is still unpaid --
/// the real "running tab" mutation. Re-prices the WHOLE order (existing
/// items + these new ones) authoritatively so `orders.total_cents` never
/// drifts, but only INSERTs the new rows -- the items already on the order
/// (already fired to the kitchen, possibly already PREPARING/READY) are
/// never touched, so this can't double-fire a kitchen ticket or re-deduct
/// stock for food already cooking. The frontend is responsible for firing a
/// kitchen ticket containing ONLY the items it just sent here (see
/// `orderService.addItemsToOrder`), mirroring how `create_full_order_v3`'s
/// own ticket is fired client-side by `orderService.createOrder`.
#[tauri::command]
pub fn add_items_to_order_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    order_id: String,
    items: Vec<crate::repo::OrderItemInput>,
) -> Result<(), String> {
    add_items_to_order_v3_impl(&state, &license, session_token, order_id, items)
}

pub(crate) fn add_items_to_order_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    order_id: String,
    items: Vec<crate::repo::OrderItemInput>,
) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("add_items_to_order_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    if items.is_empty() {
        return Ok(());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id, status, discount_cents, delivery_fee_cents) =
        Repo::new(&conn).get_order_pricing_context(&scope, &order_id).map_err(|e| e.to_string())?;
    if !matches!(status.as_str(), "PENDING" | "PREPARING" | "READY" | "SERVED") {
        return Err(crate::repo::RepoError::OrderNotOpenForAdditions { order_id: order_id.clone(), status }.to_string());
    }

    let existing_items = Repo::new(&conn).list_order_items_as_input(&order_id).map_err(|e| e.to_string())?;
    let existing_count = existing_items.len();
    let mut combined = existing_items;
    combined.extend(items);
    let (priced_combined, subtotal_cents, tax_cents, total_cents) =
        price_order_authoritatively(&conn, &tenant_id, &combined, discount_cents, delivery_fee_cents)?;
    let new_priced_items = &priced_combined[existing_count..];

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let inserted_ids = Repo::new(&tx).append_order_items(&tenant_id, &branch_id, &order_id, new_priced_items).map_err(|e| e.to_string())?;
    Repo::new(&tx).update_order_totals(&order_id, subtotal_cents, tax_cents, total_cents).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "items_added", "added_count": new_priced_items.len(), "new_total_cents": total_cents })),
    ).map_err(|e| e.to_string())?;

    // Only the NEW item rows need a fresh sync rev -- the items already on
    // this order (already fired to the kitchen) haven't changed and
    // shouldn't be re-queued (unlike `sync_enqueue_order_items`, which would
    // re-stamp every item on the order, not just the ones this call added).
    let license_status = license.cached_status();
    sync_enqueue_order(&tx, &tenant_id, &branch_id, &order_id, &actor.device_id, &license_status)?;
    for item_id in &inserted_ids {
        sync_enqueue_single_order_item(&tx, &tenant_id, &branch_id, item_id, &actor.device_id, &license_status)?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Split a PENDING order into child orders, moving items.
#[tauri::command]
pub fn split_bill_v3(
    state: State<Db>,
    session_token: String,
    order_id: String,
    splits: Vec<SplitBillInput>,
    table_id: String,
) -> Result<Vec<String>, String> {
    split_bill_v3_impl(&state, session_token, order_id, splits, table_id)
}

pub(crate) fn split_bill_v3_impl(
    state: &Db,
    session_token: String,
    order_id: String,
    splits: Vec<SplitBillInput>,
    table_id: String,
) -> Result<Vec<String>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ids = Repo::new(&tx).split_bill(&scope, &order_id, splits, &actor.id, &table_id)
        .map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "split", "child_count": ids.len() })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids)
}

/// Merge source tables into target: all become MERGED, source order items
/// move to target order, source orders cancelled.
#[tauri::command]
pub fn merge_tables_v3(
    state: State<Db>,
    session_token: String,
    source_table_ids: Vec<String>,
    target_table_id: String,
) -> Result<Option<String>, String> {
    merge_tables_v3_impl(&state, session_token, source_table_ids, target_table_id)
}

pub(crate) fn merge_tables_v3_impl(
    state: &Db,
    session_token: String,
    source_table_ids: Vec<String>,
    target_table_id: String,
) -> Result<Option<String>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let target_order_id = Repo::new(&tx).merge_tables(&scope, source_table_ids, &target_table_id)
        .map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "table", &target_table_id,
        None, Some(&serde_json::json!({ "action": "merge" })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(target_order_id)
}

/// Unmerge all tables in a merge group back to FREE.
#[tauri::command]
pub fn unmerge_tables_v3(state: State<Db>, session_token: String, merge_group_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).unmerge_tables(&scope, &merge_group_id).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "table", &merge_group_id,
        None, Some(&serde_json::json!({ "action": "unmerge" })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Soft-void an order item (set voided=1 + void_reason).
#[tauri::command]
pub fn void_order_item_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, reason: String, manager_override_pin: Option<String>) -> Result<(), String> {
    void_order_item_v3_impl(&state, &license, session_token, item_id, reason, manager_override_pin)
}

/// WENZDES audit C5/H5, updated 2026-08-02: below the tenant's
/// `void_manager_threshold_cents` (Owner-configurable via
/// `update_manager_thresholds_v3` -- see pricing.rs's `ManagerThresholds`
/// doc for why this replaced a hardcoded constant), any actor holding
/// `Permission::CreateOrder` (i.e. a cashier) may void a line on their own
/// authority, same as before. At or above it, a valid manager PIN is
/// required -- checked here, server-side, against the line's REAL price
/// (`order_item_line_total_cents`, itself scope-checked), not whatever
/// price the caller claims. Mirrors `enforce_discount_cap`'s established
/// shape exactly: verify on the plain `Connection` before the write
/// transaction opens, since `verify_manager_override_impl` needs
/// `&mut Connection`, not a `Transaction`.
pub(crate) fn void_order_item_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, item_id: String, reason: String, manager_override_pin: Option<String>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("void_order_item_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let line_total_cents = Repo::new(&conn).order_item_line_total_cents(&scope, &item_id).map_err(|e| e.to_string())?;
    let threshold_cents = Repo::new(&conn).get_manager_thresholds(&actor.tenant_id).map_err(|e| e.to_string())?.void_threshold_cents;
    let override_used = if line_total_cents >= threshold_cents {
        let Some(pin) = manager_override_pin.as_deref() else {
            return Err("voiding an item over the manager-override threshold requires a manager PIN".to_string());
        };
        if !verify_manager_override_impl(&mut conn, &actor, pin)? {
            return Err("manager PIN is not valid".to_string());
        }
        true
    } else {
        false
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).void_order_item(&scope, &item_id, &reason, &actor.id).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "order_item", &item_id,
        None, Some(&serde_json::json!({ "action": "void", "reason": reason, "manager_override_used": override_used })),
    ).map_err(|e| e.to_string())?;

    // Sync: re-stamp+re-queue this one item at its next rev (voided=1).
    // tenant_id/branch_id come from the item's OWN row, not the actor's
    // scope -- correct regardless of whether the caller is Branch- or
    // Tenant-scoped, and it's the row's true scope that matters for RLS
    // once this reaches Supabase (Slice 2b).
    let (item_tenant_id, item_branch_id): (String, String) = tx.query_row(
        "SELECT tenant_id, branch_id FROM order_items WHERE id = ?1", params![item_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_single_order_item(&tx, &item_tenant_id, &item_branch_id, &item_id, &actor.device_id, &license_status)?;

    // `Repo::void_order_item` restores this item's recipe-linked
    // ingredient stock ONLY when its parent order was already PAID (see
    // that function's doc comment) -- re-check the same condition here to
    // decide whether there's anything to sync.
    let (order_id, menu_item_id): (String, String) = tx.query_row(
        "SELECT order_id, menu_item_id FROM order_items WHERE id = ?1", params![item_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let order_status: String = tx.query_row(
        "SELECT status FROM orders WHERE id = ?1", params![order_id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if order_status == "PAID" {
        sync_enqueue_recipe_ingredients_for_menu_item(&tx, &item_tenant_id, &item_branch_id, &menu_item_id, &actor.device_id, &license_status)?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Transfer an order from one table to another.
#[tauri::command]
pub fn transfer_order_v3(state: State<Db>, session_token: String, order_id: String, from_table_id: String, to_table_id: String) -> Result<(), String> {
    transfer_order_v3_impl(&state, session_token, order_id, from_table_id, to_table_id)
}

pub(crate) fn transfer_order_v3_impl(state: &Db, session_token: String, order_id: String, from_table_id: String, to_table_id: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).transfer_order(&scope, &order_id, &from_table_id, &to_table_id).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "transfer", "from": from_table_id, "to": to_table_id })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a SCHEDULED order + items + modifiers + delayed_orders entry.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn schedule_delayed_order_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    table_id: String,
    order_type: String,
    items: Vec<crate::repo::OrderItemInput>,
    subtotal_cents: i64,
    tax_cents: i64,
    total_cents: i64,
    scheduled_at: String,
) -> Result<String, String> {
    schedule_delayed_order_v3_impl(&state, &license, session_token, table_id, order_type, items, subtotal_cents, tax_cents, total_cents, scheduled_at)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn schedule_delayed_order_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    table_id: String,
    order_type: String,
    items: Vec<crate::repo::OrderItemInput>,
    // No longer trusted -- see `price_order_authoritatively`.
    _subtotal_cents: i64,
    _tax_cents: i64,
    _total_cents: i64,
    scheduled_at: String,
) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (items, subtotal_cents, tax_cents, total_cents) =
        price_order_authoritatively(&conn, &tenant_id, &items, 0, 0)?;
    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let table_id = resolve_order_table_id(&tx, &tenant_id, &branch_id, &table_id)?;
    let input = FullOrderInput {
        table_id, user_id: actor.id.clone(), order_type: order_type.clone(),
        subtotal_cents, tax_cents, total_cents, discount_cents: 0,
        discount_reason: None, customer_name: None, customer_phone: None,
        delivery_address: None, delivery_fee_cents: 0, shift_id: None, items,
    };
    let order_id = Repo::new(&tx).schedule_delayed_order(&scope, &tenant_id, &branch_id, input, &scheduled_at)
        .map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderCreated, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "schedule", "scheduled_at": scheduled_at })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(order_id)
}

/// Activate all delayed orders where scheduled_at <= now.
#[tauri::command]
pub fn activate_delayed_orders_v3(state: State<Db>, _session_token: String) -> Result<Vec<String>, String> {
    let _actor = authenticate_actor(&state, &_session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).activate_delayed_orders().map_err(|e| e.to_string())
}

/// Get receipt config: chain_name, currency from chain_config + branch name.
#[tauri::command]
pub fn get_receipt_config_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<ReceiptConfig, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_receipt_config(&tenant_id, &branch_id).map_err(|e| e.to_string())
}

/// Look up a loyalty card by card_number.
#[tauri::command]
pub fn lookup_loyalty_card_v3(state: State<Db>, _session_token: String, card_number: String) -> Result<Option<LoyaltyCardLookup>, String> {
    let actor = authenticate_actor(&state, &_session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).lookup_loyalty_card(&actor.tenant_id, &card_number).map_err(|e| e.to_string())
}

// 2026-09-13: `earn_loyalty_points_v3` (the standalone accrual command) was
// removed here. Its own doc comment already said it was "superseded by
// finalize_order_with_payment's own atomic, server-computed accrual...
// and isn't called from any frontend page today" -- confirmed by a
// whole-tree grep of src/ (*.ts/*.tsx) turning up zero callers. Leaving it
// registered as a live, license-gated, `ManageLoyalty`-authorized command
// was a real hazard, not just dead code: it let points be earned with a
// CLIENT-SUPPLIED `points` value (only floor-checked at > 0, no ceiling,
// no tie to any real order total) completely outside
// `finalize_order_with_payment`'s atomic, server-computed accrual path --
// any caller with `ManageLoyalty` could invoke it directly and create a
// loyalty balance inconsistent with what the order that `order_id` names
// actually earned. `Repo::earn_loyalty_points` (repo.rs) is kept, not
// removed -- it still has direct unit-test coverage there and remains a
// harmless private building block now that nothing reaches it over IPC.

/// Return shape for `finalize_order_with_payment_v3` -- `points_earned` is
/// `Some` only when a `card_number` was passed and accrual actually ran, so
/// the frontend can show "earned N points" without a second round trip.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FinalizePaymentResult {
    pub payment_id: String,
    pub points_earned: Option<i64>,
}

/// Finalize a PENDING order: status→PAID, insert payment, free table,
/// optional debt entry, optional atomic loyalty accrual (see
/// `Repo::finalize_order_with_payment`'s doc comment). Replaces
/// `orderService.finalizeOrder` (the DB part). Receipt printing stays on
/// the frontend.
///
/// 2026-09-13 audit fix: `reference_code` is the cashier-entered terminal/
/// wallet approval code (PaymentModal.tsx now requires it for CARD/WALLET
/// before "Confirm" is even clickable). Re-checked here, not just trusted
/// from the frontend gate -- a required-on-the-client field is a UX
/// nudge, not a guarantee, and this is the one place that actually decides
/// whether a CARD/WALLET payment gets recorded as PAID.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn finalize_order_with_payment_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    order_id: String,
    method: String,
    amount_cents: i64,
    change_cents: i64,
    debtor_id: Option<String>,
    card_number: Option<String>,
    reference_code: Option<String>,
) -> Result<FinalizePaymentResult, String> {
    finalize_order_with_payment_v3_impl(&state, &license, session_token, order_id, method, amount_cents, change_cents, debtor_id, card_number, reference_code)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn finalize_order_with_payment_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    order_id: String,
    method: String,
    amount_cents: i64,
    change_cents: i64,
    debtor_id: Option<String>,
    card_number: Option<String>,
    reference_code: Option<String>,
) -> Result<FinalizePaymentResult, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::TakePayment).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };
    if amount_cents < 0 || change_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let reference_code = reference_code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    if (method == "CARD" || method == "WALLET") && reference_code.is_none() {
        return Err("رقم المرجع من جهاز الدفع مطلوب لإتمام هذه العملية".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (payment_id, points_earned) = Repo::new(&tx).finalize_order_with_payment(
        &tenant_id, &branch_id, &order_id, &method, amount_cents, change_cents,
        debtor_id.as_deref(), &actor.id, card_number.as_deref(), reference_code.as_deref(),
    ).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PaymentTaken, "order", &order_id,
        None, Some(&serde_json::json!({ "payment_id": payment_id, "method": method, "amount_cents": amount_cents, "change_cents": change_cents, "debtor_id": debtor_id, "loyalty_points_earned": points_earned, "reference_code": reference_code })),
    ).map_err(|e| e.to_string())?;

    // Sync: the payment is a brand-new fact (rev 1); the order's own row
    // changed too (status -> PAID), so it gets re-stamped and re-queued at
    // its next rev -- same transaction as everything else above.
    let license_status = license.cached_status();
    sync_enqueue_payment(&tx, &tenant_id, &branch_id, &payment_id, &actor.device_id, &license_status)?;
    sync_enqueue_order(&tx, &tenant_id, &branch_id, &order_id, &actor.device_id, &license_status)?;

    // `Repo::finalize_order_with_payment` just deducted recipe-linked
    // ingredient stock for every non-voided item on this order -- queue
    // the current snapshot of each ingredient touched.
    sync_enqueue_recipe_ingredients_for_order(&tx, &tenant_id, &branch_id, &order_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(FinalizePaymentResult { payment_id, points_earned })
}

/// Back-office command -- license-gated (unlike void/payment: a refund
/// happens AFTER the sale already closed, never mid-service, so it's not
/// on the "must stay open during a locked license" list those are).
/// Single function body, not a wrapper+impl split -- the license-gate
/// coverage test scans this exact body's literal source text for the
/// require_license_not_locked call, same constraint every other GATED
/// command here follows (see list_staff_v3/create_roster_entry_v3's own
/// notes on this).
#[tauri::command]
pub fn refund_order_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    order_id: String,
    reason: Option<String>,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::RefundOrder).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    let scope = actor.scope();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let refund_id = Repo::new(&tx)
        .refund_order(&scope, &order_id, &actor.id, reason.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderRefunded, "order", &order_id,
        None, Some(&serde_json::json!({ "refund_id": refund_id, "reason": reason })),
    ).map_err(|e| e.to_string())?;

    // `Repo::refund_order` just restored recipe-linked ingredient stock for
    // every non-voided item on this order (mirror of the deplete at
    // payment time) -- queue the current snapshot of each ingredient
    // touched. tenant_id/branch_id come from the order's OWN row, not the
    // actor's scope, same reasoning as elsewhere in this file.
    let (order_tenant_id, order_branch_id): (String, String) = tx.query_row(
        "SELECT tenant_id, branch_id FROM orders WHERE id = ?1", params![order_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_recipe_ingredients_for_order(&tx, &order_tenant_id, &order_branch_id, &order_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(refund_id)
}

/// Stamps `payments.rev`/`updated_at_hlc`/`device_id` and queues the row --
/// payments are never mutated after creation, so this only ever runs once
/// per payment, always at rev 1.
fn sync_enqueue_payment(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    payment_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE payments SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, payment_id],
    ).map_err(|e| e.to_string())?;

    let (order_id, method, amount_cents, change_cents, created_at, rev): (String, String, i64, i64, String, i64) = tx.query_row(
        "SELECT order_id, method, amount_cents, change_cents, created_at, rev FROM payments WHERE id = ?1",
        params![payment_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "id": payment_id, "order_id": order_id, "tenant_id": tenant_id, "branch_id": branch_id,
        "method": method, "amount_cents": amount_cents, "change_cents": change_cents, "created_at": created_at,
    });
    crate::sync::enqueue(tx, "payments", payment_id, tenant_id, branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

/// T2.0 supplier ledger: first sync wire-up for `supplier_payments` -- a
/// brand-new fact table, always at rev 1 when this runs (it's called once,
/// right after the row is inserted, same as `sync_enqueue_single_order_item`
/// for a freshly-created order item). Money paid to suppliers must reach
/// the cloud for the owner dashboard's cross-branch cash-flow rollup
/// (T2.0 plan §0 flag #4 / §3) to be possible at all.
pub(crate) fn sync_enqueue_supplier_payment(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    payment_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE supplier_payments SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, payment_id],
    ).map_err(|e| e.to_string())?;

    #[allow(clippy::type_complexity)]
    let (supplier_id, purchase_order_id, entry_type, amount_cents, method, notes, created_at, rev): (String, Option<String>, String, i64, Option<String>, Option<String>, String, i64) = tx.query_row(
        "SELECT supplier_id, purchase_order_id, type, amount_cents, method, notes, created_at, rev FROM supplier_payments WHERE id = ?1",
        params![payment_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    ).map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "id": payment_id, "supplier_id": supplier_id, "purchase_order_id": purchase_order_id,
        "tenant_id": tenant_id, "branch_id": branch_id, "type": entry_type,
        "amount_cents": amount_cents, "method": method, "notes": notes, "created_at": created_at,
    });
    crate::sync::enqueue(tx, "supplier_payments", payment_id, tenant_id, branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

/// The marketplace "reorder low-stock ingredients" feature's POS-side
/// half: stamps `ingredients.rev`/`updated_at_hlc`/`device_id` and queues
/// the ingredient's CURRENT row -- always re-read fresh here, never
/// reconstructed from the caller's own view of what changed, same
/// "always send the live state" principle as `sync_enqueue_order`. Called
/// after every write that can change what the marketplace needs to see
/// (name/unit/min_stock/cost on create+edit, current_stock on manual
/// adjustment, recipe-based depletion at payment, restoration on
/// void/refund, and purchase-order receiving). Silently a no-op if the
/// ingredient was hard-deleted between the write and this call -- nothing
/// left to sync, not an error.
pub(crate) fn sync_enqueue_ingredient(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    ingredient_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE ingredients SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, ingredient_id],
    ).map_err(|e| e.to_string())?;

    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, f64, f64, i64, i64, i64)> = tx.query_row(
        "SELECT name, unit, current_stock, min_stock, cost_cents_per_unit, is_active, rev FROM ingredients WHERE id = ?1",
        params![ingredient_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
    ).optional().map_err(|e| e.to_string())?;
    let Some((name, unit, current_stock, min_stock, cost_cents_per_unit, is_active, rev)) = row else {
        return Ok(());
    };

    let payload = serde_json::json!({
        "id": ingredient_id, "tenant_id": tenant_id, "branch_id": branch_id,
        "name": name, "unit": unit, "current_stock": current_stock,
        "min_stock": min_stock, "cost_cents_per_unit": cost_cents_per_unit,
        "is_active": is_active != 0,
    });
    crate::sync::enqueue(tx, "ingredients", ingredient_id, tenant_id, branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

/// Every ingredient_id touched by recipe-based stock movement (deplete at
/// payment, restore on refund) for a whole order -- re-derived from
/// `order_items` JOIN `recipes`, the exact same query shape
/// `Repo::deplete_recipe_stock`/`Repo::refund_order` use internally to
/// decide what to move, so this always matches what the repo layer just
/// changed. Enqueues each one via `sync_enqueue_ingredient`.
fn sync_enqueue_recipe_ingredients_for_order(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    order_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    let ingredient_ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT r.ingredient_id FROM order_items oi JOIN recipes r ON r.menu_item_id = oi.menu_item_id \
             WHERE oi.order_id = ?1 AND oi.voided = 0",
        ).map_err(|e| e.to_string())?;
        let ids = stmt.query_map(params![order_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        ids.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for ingredient_id in ingredient_ids {
        sync_enqueue_ingredient(tx, tenant_id, branch_id, &ingredient_id, device_id, license_status)?;
    }
    Ok(())
}

/// Every ingredient_id in one menu item's recipe -- used by
/// `void_order_item_v3` (a single item's own recipe, restored only when its
/// parent order was already PAID; see `Repo::void_order_item`'s doc
/// comment for that condition).
fn sync_enqueue_recipe_ingredients_for_menu_item(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    menu_item_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    let ingredient_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT ingredient_id FROM recipes WHERE menu_item_id = ?1").map_err(|e| e.to_string())?;
        let ids = stmt.query_map(params![menu_item_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        ids.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for ingredient_id in ingredient_ids {
        sync_enqueue_ingredient(tx, tenant_id, branch_id, &ingredient_id, device_id, license_status)?;
    }
    Ok(())
}

/// Owner dashboard "staff" summary (aggregate-only, per user's explicit
/// scope decision: who exists / who's clocked in per branch, no remote
/// edit path -- that stays a POS-only, in-person action, same trust
/// boundary as everything else that requires a manager PIN in person).
/// Called at the 3 points that change what this snapshot should show:
/// `create_staff_v3` (new hire appears), `clock_in_v3`/`clock_out_v3`
/// (attendance is the purpose-built "who's here today" system -- NOT
/// shifts, which track cash-register sessions and can span multiple
/// staff or stay open across a clock-out). `update_staff_v3` (role
/// changes) is NOT hooked -- role edits are rare and this is a summary
/// view, not a management tool, so a few minutes of staleness there is
/// an accepted tradeoff rather than wiring a 4th call site for it.
///
/// Skips PLATFORM/OWNER-role staff rows entirely (no branch_id -- there's
/// nothing to attach them to on a per-branch dashboard card, and an
/// owner doesn't need to see themselves listed as "staff").
pub(crate) fn sync_enqueue_staff_snapshot(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    staff_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE staff SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, staff_id],
    ).map_err(|e| e.to_string())?;

    let (branch_id, name, role, is_active, rev): (Option<String>, String, String, i64, i64) = tx.query_row(
        "SELECT branch_id, name, role, is_active, rev FROM staff WHERE id = ?1",
        params![staff_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).map_err(|e| e.to_string())?;

    let Some(branch_id) = branch_id else {
        // OWNER/PLATFORM staff row -- nothing to sync, not an error.
        return Ok(());
    };

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_attendance: Option<(Option<String>, Option<String>)> = tx.query_row(
        "SELECT clock_in, clock_out FROM attendance WHERE user_id = ?1 AND date = ?2",
        params![staff_id, today],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    let (last_clock_in, is_clocked_in) = match today_attendance {
        Some((clock_in, clock_out)) => (clock_in.clone(), clock_in.is_some() && clock_out.is_none()),
        None => (None, false),
    };

    let payload = serde_json::json!({
        "id": staff_id, "tenant_id": tenant_id, "branch_id": branch_id,
        "name": name, "role": role, "is_active": is_active != 0,
        "is_clocked_in": is_clocked_in, "last_clock_in": last_clock_in,
    });
    crate::sync::enqueue(tx, "staff", staff_id, tenant_id, &branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

/// T2.0 plan §0 flag #4: `operational_costs` existed since day one but was
/// never wired into the sync outbox at all -- this is its first sync
/// wire-up, same pattern as every other enqueue function here.
pub(crate) fn sync_enqueue_operational_cost(
    tx: &rusqlite::Transaction,
    tenant_id: &str,
    branch_id: &str,
    cost_id: &str,
    device_id: &str,
    license_status: &crate::license::signed::LicenseStatus,
) -> Result<(), String> {
    tx.execute(
        "UPDATE operational_costs SET rev = COALESCE(rev, 0) + 1, updated_at_hlc = ?1, device_id = ?2 WHERE id = ?3",
        params![crate::hlc::next(), device_id, cost_id],
    ).map_err(|e| e.to_string())?;

    let (category, amount_cents, date, notes, reference_type, reference_id, rev): (String, i64, String, Option<String>, Option<String>, Option<String>, i64) = tx.query_row(
        "SELECT category, amount_cents, date, notes, reference_type, reference_id, rev FROM operational_costs WHERE id = ?1",
        params![cost_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
    ).map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "id": cost_id, "tenant_id": tenant_id, "branch_id": branch_id, "category": category,
        "amount_cents": amount_cents, "date": date, "notes": notes,
        "reference_type": reference_type, "reference_id": reference_id,
    });
    crate::sync::enqueue(tx, "operational_costs", cost_id, tenant_id, branch_id, &payload, rev, device_id, license_status).map_err(|e| e.to_string())
}

