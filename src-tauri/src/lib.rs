use rusqlite::{params, Connection};
use std::sync::Mutex;
use tauri::{Manager, State};

mod migrate;
mod migrate_v3;
mod money;
mod pricing;
mod security;
mod repo;
mod audit;
mod commands_v3;
mod ai;
mod photos;
pub mod license;
mod hlc;
mod sync;
mod obslog;

use bcrypt::{hash, DEFAULT_COST};

struct Db(Mutex<Connection>);

use ai::commands::AppState;
use ai::commands;
use ai::MockAiProvider;
use ai::NullAiProvider;
use ai::UploadQueue;

// `SCHEMA_SQL` (the `tauri_plugin_sql` lazy-migration constant that used to
// live here) is gone along with the plugin registration below it and the
// frontend's `getDb()` -- it was a SEPARATE SQLite connection to the same
// file, entirely independent of `init_db()`'s real migrations, and the
// exact mechanism that resurrected a zombie `users` table earlier this
// sprint (root-caused during Batch 3a hand-testing). Now that no frontend
// code calls `getDb()` at all (Batch 3b closeout), this dead, previously-
// dangerous duplicate is removed rather than left registered and unused.

/// Every connection this app opens to `zaeem_pos.db` must call this. SQLite's
/// `busy_timeout` defaults to 0 -- a connection that hits a writer lock held
/// by ANOTHER connection to the same file fails immediately with "database
/// is locked" instead of waiting. This app opens three separate connections
/// to the same file (`Db`, the AI upload queue, `AppState`) specifically so
/// that a slow AI/photo operation never blocks a sale -- but without this,
/// that same design makes ordinary contention between them return hard
/// errors instead of just waiting the few milliseconds a competing write
/// actually takes. 5s is generous -- no single transaction in this app
/// legitimately holds a write lock anywhere close to that long.
fn set_busy_timeout(conn: &Connection) {
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .expect("failed to set busy_timeout");
}

fn db_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_config_dir().expect("failed to resolve app config dir");
    std::fs::create_dir_all(&dir).ok();
    dir.join("zaeem_pos.db")
}

fn init_db(conn: &mut Connection, db_path: &std::path::Path) -> Result<(), String> {
    migrate::run_migrations(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_expand_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_remap_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_identity_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_drift_fix_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_index_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_discount_cap_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_sync_outbox_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_supplier_ledger_migration(conn, db_path).map_err(|e| e.to_string())?;
    migrate_v3::run_loyalty_migration(conn, db_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Replaces the old `seed_default_users` (which wrote to the now-dropped
/// `users` table). Seeds `staff` instead, and -- unlike the old seed, which
/// never set a PIN at all -- gives each seeded row a working `pin_hash`,
/// because `LoginPage.tsx` (the app's actual, only login screen) is a PIN pad
/// with no username/password field. Without this, dev builds could never log
/// in through the UI at all, independent of anything this sprint touched.
#[cfg(debug_assertions)]
fn seed_default_staff(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM staff", [], |row| row.get(0)).unwrap_or(0);
    if count > 0 { return Ok(()); }

    let tenant_id: String = match conn.query_row("SELECT id FROM tenant LIMIT 1", [], |r| r.get(0)) {
        Ok(id) => id,
        Err(_) => return Ok(()), // migrations haven't seeded a tenant yet
    };
    let branch_id: String = match conn.query_row("SELECT id FROM branch WHERE tenant_id = ?1 LIMIT 1", params![tenant_id], |r| r.get(0)) {
        Ok(id) => id,
        Err(_) => return Ok(()),
    };

    let now = chrono::Utc::now().to_rfc3339();
    struct SeedStaff<'a> { id: &'a str, name: &'a str, role: &'a str, role_rank: u8, branch: Option<&'a str>, pin: &'a str }
    // PINs are distinct and documented here since CredentialsModal.tsx's
    // displayed credentials are for the old username/password path, not
    // this PIN pad.
    let staff = [
        SeedStaff { id: "staff-owner-001", name: "المدير العام", role: "OWNER", role_rank: 3, branch: None, pin: "123456" },
        SeedStaff { id: "staff-mgr-001", name: "المشرف", role: "MANAGER", role_rank: 2, branch: Some(branch_id.as_str()), pin: "222222" },
        SeedStaff { id: "staff-cash-001", name: "الكاشير", role: "CASHIER", role_rank: 1, branch: Some(branch_id.as_str()), pin: "333333" },
        SeedStaff { id: "staff-kit-001", name: "المطبخ", role: "KITCHEN", role_rank: 1, branch: Some(branch_id.as_str()), pin: "444444" },
    ];
    for SeedStaff { id, name, role, role_rank, branch, pin } in staff {
        let pin_hash = hash(pin, DEFAULT_COST).unwrap_or_default();
        conn.execute(
            "INSERT OR IGNORE INTO staff (id, tenant_id, branch_id, role, role_rank, name, pin_hash, is_active, created_at, updated_at_hlc, device_id, rev) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8, 'dev-seed', 1)",
            params![id, tenant_id, branch, role, role_rank, name, pin_hash, now],
        )?;
    }
    Ok(())
}

// `needs_setup`/`setup_owner` (old, `users`-backed) are superseded by
// `commands_v3::needs_setup_v3`/`setup_owner_v3`, which target `staff`.
//
// T1.9 finding (2026-07-17): 12 more pre-v3 commands were still registered
// here -- `get_debtors`, `get_debtor_detail`, `create_debtor`, `update_debtor`,
// `delete_debtor`, `add_debt`, `record_debt_payment`, `get_kitchen_orders`,
// `update_order_status`, `get_active_orders`, `get_settings`, `update_settings`
// -- every one of them took only `state: State<Db>` with NO `session_token`
// parameter at all: no `authenticate_actor`, no `authorize`, no scope check,
// nothing. Any renderer-side JS (the entire T1.9 threat model) could call
// `invoke("update_order_status", {...})` directly and rewrite any order's
// status in the database, or `invoke("update_settings", {...})` to rewrite
// the tax rate, with zero authentication -- a complete bypass of every
// permission/scope guarantee this sprint built, sitting right next to the
// real ones. Confirmed zero frontend call sites for any of the 12 (grepped
// `invoke("<name>"` across `src/` -- none), so they were dead as well as
// dangerous. Deleted entirely, not gated -- there was nothing to gate a
// legitimate caller for.

#[cfg(debug_assertions)]
#[tauri::command]
fn diagnose_db(state: State<Db>) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut tables = Vec::new();
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for name in rows.flatten() {
        tables.push(name);
    }
    Ok(format!("Tables [{}]: {}", tables.len(), tables.join(", ")))
}

// Diagnostics disclose schema/table info and must never be reachable in a release
// build, even by a renderer that calls invoke("diagnose_db") directly (frontend
// routing alone does not stop that — the command itself must refuse).
#[cfg(not(debug_assertions))]
#[tauri::command]
fn diagnose_db(_state: State<Db>) -> Result<String, String> {
    Err("diagnose_db is not available in release builds".to_string())
}

/// The frontend's `invoke` wrapper (`src/lib/invoke.ts`) calls this,
/// fire-and-forget, whenever any command call rejects. The frontend is the
/// one place that already knows the exact command name for every call, so
/// this is where "which command failed" gets attached to the log file the
/// SQLite/sync/license lines land in. No auth required -- this can't read
/// or write anything, it only writes a log line, and the error state it's
/// reporting on may itself be pre-login (the whole point of this bug class
/// is that ANY page can start failing).
#[tauri::command]
fn log_frontend_command_error(command: String, error: String) {
    obslog::log_frontend_command_error(&command, &error);
}

// `verify_manager_override` (unscoped, unaudited, arbitrary-LIMIT-1-row)
// removed -- replaced by `commands_v3::verify_manager_override_v3`
// (Batch 3b, Slice B verification), which is session-scoped to the
// requesting actor's own tenant/branch, tries every manager-rank candidate
// in that scope, and writes an audit entry on a successful grant. See that
// function's doc comment for the full rationale.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // P0 follow-up (2026-07-23): a rotating, persisted log file in
            // every build (not just debug) -- the "database is not there
            // anymore after ~1h" report was never diagnosable after the
            // fact because nothing was ever written down. LogDir target
            // writes to the OS app-log directory; size-based rotation
            // keeps it from growing unbounded over a long-lived install.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }))
                    .max_file_size(5_000_000)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                    .build(),
            )?;

            // Must run before ANY Connection::open in this process (rusqlite's
            // own safety contract for config_log) -- see obslog.rs.
            obslog::install_sqlite_error_log();
            obslog::log_app_start(app.package_info().version.to_string().as_str());

            let db_path = db_path(app.handle());
            let mut conn = Connection::open(&db_path).expect("Failed to open database");
            set_busy_timeout(&conn);
            init_db(&mut conn, &db_path).expect("Failed to initialize database");
            #[cfg(debug_assertions)]
            seed_default_staff(&conn).expect("Failed to seed default staff");
            app.manage(Db(Mutex::new(conn)));

            // AI onboarding state -- a SEPARATE connection to the SAME file
            // as Db's, above (P0 fix, 2026-07-23: this and app_conn below
            // used to open with zero PRAGMAs at all, meaning busy_timeout
            // was SQLite's default of 0 -- any write on this connection
            // that landed while Db's connection held a write lock failed
            // immediately with "database is locked" instead of waiting.
            // Reproduced: two connections to the same file, no
            // busy_timeout, concurrent writes -> up to ~70% of writes
            // failed with that exact error. See commands_v3.rs's (removed)
            // p0_two_connections_same_file_no_busy_timeout_concurrent_writes
            // soak test for the repro. journal_mode=WAL doesn't need
            // repeating here -- it's a property of the database FILE, not
            // the connection, and Db's connection above already set it.
            let queue_conn = Connection::open(&db_path).expect("Failed to open database for queue");
            set_busy_timeout(&queue_conn);
            let queue = UploadQueue::new_queue(queue_conn);
            let provider: Box<dyn ai::AiProvider + Send + Sync> = if cfg!(debug_assertions) {
                Box::new(MockAiProvider)
            } else {
                Box::new(NullAiProvider)
            };
            let app_conn = Connection::open(&db_path).expect("Failed to open database for AppState");
            set_busy_timeout(&app_conn);
            app.manage(AppState {
                db: Mutex::new(app_conn),
                queue: Mutex::new(queue),
                provider,
            });

            // Offline signed license, verified at boot and on a 6h timer.
            // Slice 1c wraps it in `CloudLicenseState`, which adds the
            // hybrid cloud+offline check on top -- see license/cloud.rs for
            // the precedence rules. Never on the hot path of a sale: every
            // command that cares reads `cached_status()`, a Mutex read of
            // whatever was last computed, not a fresh network call or
            // signature check.
            let license_dir = db_path.parent().expect("db_path must have a parent dir").to_path_buf();
            let license_state = license::store::LicenseState::init(license_dir.clone(), license::compiled_public_key());
            let cloud_config = license::cloud::load_config_from_file(&license_dir.join("cloud_config.json"));
            let transport = license::cloud::SupabaseCloudTransport::new(license::cloud::supabase_url(), license::cloud::supabase_anon_key());
            let cloud_license_state = license::cloud::CloudLicenseState::new(license_state, license_dir.clone(), cloud_config, Box::new(transport));
            app.manage(cloud_license_state);

            let offline_timer_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
                    if let Some(state) = offline_timer_handle.try_state::<license::cloud::CloudLicenseState>() {
                        let status = state.recheck_offline();
                        obslog::log_license_refresh("offline", &format!("{status:?}"));
                    }
                }
            });

            // Cloud check on its own, shorter cadence -- bounded by a 5s
            // per-call timeout inside the transport, so this never blocks
            // anything else even if the network is degraded rather than
            // fully down. Also fires once immediately at boot (best-effort,
            // not blocking startup) so a freshly-opened, online terminal
            // doesn't wait 5 minutes for its first authoritative check.
            let cloud_timer_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = cloud_timer_handle.try_state::<license::cloud::CloudLicenseState>() {
                    state.refresh_from_cloud().await;
                    obslog::log_license_refresh("cloud", &format!("{:?}", state.cached_status()));
                }
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                    if let Some(state) = cloud_timer_handle.try_state::<license::cloud::CloudLicenseState>() {
                        state.refresh_from_cloud().await;
                        obslog::log_license_refresh("cloud", &format!("{:?}", state.cached_status()));
                    }
                }
            });

            // Cloud sync outbox worker (CLOUD_AND_LICENSING_PLAN.md §5,
            // Slice 2a): drains sync_outbox on its own timer, batched, with
            // exponential backoff + jitter on failure. Slice 2c plugs a real
            // POST to `ingest_sales_facts` RPC into `send_batch` (sync.rs).
            // Never on the sale path: this is the ONLY thing that ever reads
            // `sync_outbox`.
            let sync_timer_handle = app.handle().clone();
            let sync_config_dir = db_path.parent().expect("db_path must have a parent dir").to_path_buf();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    if let Some(db) = sync_timer_handle.try_state::<Db>() {
                        let result = sync::run_tick(&db.0, 500, &sync_config_dir).await;
                        obslog::log_sync_tick_result(&result);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            diagnose_db,
            log_frontend_command_error,
            commands_v3::verify_manager_override_v3,
            commands_v3::login_v3,
            commands_v3::login_pin_v3,
            commands_v3::setup_owner_v3,
            commands_v3::needs_setup_v3,
            commands_v3::logout_v3,
            commands_v3::create_branch_v3,
            commands_v3::create_staff_v3,
            commands_v3::update_staff_v3,
            commands_v3::list_branches_v3,
            commands_v3::list_staff_v3,
            commands_v3::update_staff_profile_v3,
            commands_v3::set_staff_active_v3,
            commands_v3::list_orders_v3,
            commands_v3::list_kitchen_orders_v3,
            commands_v3::create_order_v3,
            commands_v3::update_order_status_v3,
            commands_v3::take_payment_v3,
            commands_v3::list_categories_v3,
            commands_v3::create_category_v3,
            commands_v3::update_category_v3,
            commands_v3::delete_category_v3,
            commands_v3::list_menu_items_v3,
            commands_v3::list_combo_components_v3,
            commands_v3::list_combo_meals_v3,
            commands_v3::list_combo_meal_items_v3,
            commands_v3::create_combo_meal_v3,
            commands_v3::update_combo_meal_v3,
            commands_v3::delete_combo_meal_v3,
            commands_v3::list_happy_hour_rules_v3,
            commands_v3::create_happy_hour_rule_v3,
            commands_v3::update_happy_hour_rule_v3,
            commands_v3::delete_happy_hour_rule_v3,
            commands_v3::set_happy_hour_rule_active_v3,
            commands_v3::list_branches_full_v3,
            commands_v3::create_branch_full_v3,
            commands_v3::update_branch_full_v3,
            commands_v3::set_branch_full_active_v3,
            commands_v3::update_branch_detail_field_v3,
            commands_v3::list_terminals_v3,
            commands_v3::get_tenant_today_stats_v3,
            commands_v3::get_terminal_counts_by_branch_v3,
            commands_v3::create_menu_item_v3,
            commands_v3::update_menu_item_v3,
            commands_v3::delete_menu_item_v3,
            commands_v3::set_menu_item_active_v3,
            commands_v3::upload_menu_item_photo_v3,
            commands_v3::delete_menu_item_photo_v3,
            commands_v3::get_menu_item_photo_v3,
            commands_v3::list_ingredients_v3,
            commands_v3::create_ingredient_v3,
            commands_v3::update_ingredient_v3,
            commands_v3::adjust_stock_v3,
            commands_v3::get_active_shift_v3,
            commands_v3::get_shift_stats_v3,
            commands_v3::list_shift_orders_v3,
            commands_v3::open_shift_v3,
            commands_v3::close_shift_v3,
            commands_v3::list_shifts_v3,
            commands_v3::force_close_shift_v3,
            commands_v3::list_attendance_v3,
            commands_v3::clock_in_v3,
            commands_v3::clock_out_v3,
            commands_v3::resolve_menu_price_v3,
            commands_v3::create_customer_v3,
            commands_v3::list_customers_v3,
            commands_v3::update_customer_v3,
            commands_v3::delete_customer_v3,
            commands_v3::get_customer_detail_v3,
            commands_v3::list_loyalty_cards_v3,
            commands_v3::issue_loyalty_card_v3,
            commands_v3::list_loyalty_transactions_v3,
            commands_v3::list_loyalty_tiers_v3,
            commands_v3::create_loyalty_tier_v3,
            commands_v3::update_loyalty_tier_v3,
            commands_v3::delete_loyalty_tier_v3,
            commands_v3::list_loyalty_rewards_v3,
            commands_v3::create_loyalty_reward_v3,
            commands_v3::set_loyalty_reward_active_v3,
            commands_v3::delete_loyalty_reward_v3,
            commands_v3::redeem_loyalty_reward_v3,
            commands_v3::list_debtors_v3,
            commands_v3::create_debtor_v3,
            commands_v3::update_debtor_v3,
            commands_v3::deactivate_debtor_v3,
            commands_v3::list_debt_entries_v3,
            commands_v3::record_debt_payment_v3,
            commands_v3::get_finance_revenue_v3,
            commands_v3::get_dashboard_summary_v3,
            commands_v3::get_tax_collected_v3,
            commands_v3::list_operational_costs_v3,
            commands_v3::create_operational_cost_v3,
            commands_v3::list_invoices_v3,
            commands_v3::create_invoice_v3,
            commands_v3::mark_invoice_paid_v3,
            commands_v3::get_sales_report_v3,
            commands_v3::get_chain_config_v3,
            commands_v3::update_chain_currency_v3,
            commands_v3::update_chain_tax_v3,
            commands_v3::get_discount_caps_v3,
            commands_v3::update_discount_caps_v3,
            commands_v3::get_legacy_branch_v3,
            commands_v3::save_legacy_branch_v3,
            commands_v3::set_printer_active_v3,
            commands_v3::update_printer_paper_width_v3,
            commands_v3::create_purchase_order_v3,
            commands_v3::create_purchase_order_and_bump_supplier_v3,
            commands_v3::create_purchase_order_with_items_v3,
            commands_v3::list_purchase_orders_v3,
            commands_v3::cancel_purchase_order_v3,
            commands_v3::list_purchase_order_items_v3,
            commands_v3::receive_purchase_order_v3,
            commands_v3::list_suppliers_v3,
            commands_v3::create_supplier_v3,
            commands_v3::update_supplier_v3,
            commands_v3::delete_supplier_v3,
            commands_v3::record_supplier_payment_v3,
            commands_v3::list_supplier_payments_v3,
            commands_v3::list_inventory_logs_v3,
            commands_v3::list_low_stock_ingredients_v3,
            commands_v3::create_driver_v3,
            commands_v3::update_driver_location_v3,
            commands_v3::list_drivers_v3,
            commands_v3::list_all_drivers_v3,
            commands_v3::list_available_drivers_v3,
            commands_v3::update_driver_v3,
            commands_v3::deactivate_driver_v3,
            commands_v3::create_printer_v3,
            commands_v3::list_printers_v3,
            commands_v3::list_active_printers_v3,
            commands_v3::list_delivery_logs_v3,
            commands_v3::create_delivery_log_v3,
            commands_v3::assign_driver_to_delivery_v3,
            commands_v3::update_delivery_status_v3,
            commands_v3::update_delivery_status_and_driver_v3,
            commands_v3::list_active_deliveries_v3,
            commands_v3::list_delivery_history_v3,
            commands_v3::list_driver_deliveries_v3,
            commands_v3::list_delivery_zones_v3,
            commands_v3::create_delivery_zone_v3,
            commands_v3::update_delivery_zone_v3,
            commands_v3::deactivate_delivery_zone_v3,
            commands_v3::change_own_password_v3,
            commands_v3::list_tables_v3,
            commands_v3::create_table_v3,
            commands_v3::rename_table_v3,
            commands_v3::delete_table_v3,
            commands_v3::create_full_order_v3,
            commands_v3::hold_order_v3,
            commands_v3::retrieve_held_order_v3,
            commands_v3::split_bill_v3,
            commands_v3::merge_tables_v3,
            commands_v3::unmerge_tables_v3,
            commands_v3::void_order_item_v3,
            commands_v3::transfer_order_v3,
            commands_v3::schedule_delayed_order_v3,
            commands_v3::activate_delayed_orders_v3,
            commands_v3::get_receipt_config_v3,
            commands_v3::lookup_loyalty_card_v3,
            commands_v3::earn_loyalty_points_v3,
            commands_v3::finalize_order_with_payment_v3,
            commands_v3::get_cached_license_status_v3,
            commands_v3::check_license_v3,
            commands_v3::renew_license_v3,
            commands_v3::activate_license_v3,
            commands_v3::get_device_id_v3,
            commands::queue_media,
            commands::list_uploads,
            commands::process_queue,
            commands::reset_failed_uploads,
            commands::clear_uploads,
            commands::apply_draft,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
