use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::{Manager, State};
use super::shared::*;
use super::orders::sync_enqueue_operational_cost;

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 3 -- finance + reports.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_finance_revenue_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, start_iso: String, end_iso: String) -> Result<crate::repo::RevenueSummaryRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).finance_revenue_summary(&actor.scope(), &start_iso, &end_iso).map_err(|e| e.to_string())
}

/// T2.0 owner dashboard (plan §3): a single command, parameterized by the
/// caller's OWN scope -- `Scope::Tenant` (Owner) gets every branch of the
/// tenant, `Scope::Branch` (Manager, if ever nav-exposed to them) gets
/// exactly their one branch. Same query, same struct, no second command.
/// Gated the same as the rest of Finance (`Permission::ManageFinance`) --
/// today that's reachable from `OWNER_NAV` only, matching "OWNER: all
/// branches, money" vs "MANAGER: own branch, operations" from the plan.
#[tauri::command]
pub fn get_dashboard_summary_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, start_iso: String, end_iso: String) -> Result<crate::repo::DashboardSummaryRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).dashboard_summary(&actor.scope(), &start_iso, &end_iso).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tax_collected_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, since_iso: String) -> Result<i64, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).tax_collected_since(&actor.scope(), &since_iso).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_operational_costs_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::OperationalCostRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_operational_costs(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_operational_cost_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, category: String, amount_cents: i64, date: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    if amount_cents <= 0 {
        return Err("cost amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let cost_id = Repo::new(&tx).create_operational_cost(&tenant_id, &branch_id, &category, amount_cents, &date, notes.as_deref(), &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::OperationalCostRecorded, "operational_cost", &cost_id, None, Some(&serde_json::json!({ "category": category, "amount_cents": amount_cents }))).map_err(|e| e.to_string())?;
    // T2.0 plan §0 flag #4: operational_costs' first-ever sync wire-up.
    let license_status = license.cached_status();
    sync_enqueue_operational_cost(&tx, &tenant_id, &branch_id, &cost_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(cost_id)
}

#[tauri::command]
pub fn list_invoices_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::InvoiceRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_invoices(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_invoice_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, period_start: String, period_end: String, amount_cents: i64, due_date: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    if amount_cents <= 0 {
        return Err("invoice amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let invoice_id = Repo::new(&tx).create_invoice(&tenant_id, &branch_id, &period_start, &period_end, amount_cents, &due_date).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InvoiceChanged, "invoice", &invoice_id, None, Some(&serde_json::json!({ "amount_cents": amount_cents, "created": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(invoice_id)
}

#[tauri::command]
pub fn mark_invoice_paid_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, invoice_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).mark_invoice_paid(&actor.scope(), &invoice_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InvoiceChanged, "invoice", &invoice_id, Some(&serde_json::json!({ "status": "PENDING" })), Some(&serde_json::json!({ "status": "PAID" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Back-office command -- license-gated. See the note on `list_staff_v3`.
/// `range_end_iso` is optional (`None` = "up to now") so the existing
/// "today so far" call site keeps working unchanged; the Reports page's
/// new date-range picker passes a real closed window.
#[tauri::command]
pub fn get_sales_report_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, today_start_iso: String, range_end_iso: Option<String>) -> Result<crate::repo::SalesReportRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).sales_report(&actor.scope(), &today_start_iso, range_end_iso.as_deref()).map_err(|e| e.to_string())
}

/// 2026-08-04: the business assistant -- "you ask, it answers from your
/// own real data, and gives an actual recommendation, not just a number."
/// Same Manager+ rank as every other report (real revenue data). Two
/// separate Tauri-managed states: `Db` for the real snapshot query
/// (crate::assistant::build_snapshot, same repo-layer pattern as every
/// other `_v3` report command) and `ai::commands::AppState` for the AI
/// provider call -- deliberately does NOT hold the `Db` mutex while the
/// (up to 30s) network call to the AI service is in flight, so a slow/
/// down AI backend can never block a sale on another terminal sharing
/// this connection.
#[tauri::command]
pub fn ask_assistant_v3(
    state: State<Db>,
    ai_state: State<crate::ai::commands::AppState>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    question: String,
    start_iso: String,
    end_iso: String,
) -> Result<crate::ai::Answer, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;

    if question.trim().is_empty() {
        return Err("السؤال فارغ".into());
    }

    let snapshot = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        crate::assistant::build_snapshot(&conn, &actor.scope(), &start_iso, &end_iso).map_err(|e| e.to_string())?
    };

    ai_state.provider.answer(&question, &snapshot).map_err(|e| e.to_string())
}

/// 2026-08-02: fully-offline anomaly detection (void rate, cash variance,
/// void-then-resell pattern) -- see anomaly.rs's module doc for why this
/// deliberately never goes through an AI vendor. On-demand only (a
/// "فحص الآن" button), not a background job -- Manager+, same rank as
/// every other report.
#[tauri::command]
pub fn detect_anomalies_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::anomaly::AnomalyFinding>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::anomaly::detect_anomalies(&conn, &actor.scope(), 30).map_err(|e| e.to_string())
}

/// 2026-08-02: fully-offline demand forecasting (see forecast.rs's module
/// doc) -- day-of-week average over the last 8 weeks, plus an ingredient
/// tier for items that already have a recipe defined. On-demand only,
/// same Manager+ rank as every other report.
#[tauri::command]
pub fn forecast_demand_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<crate::forecast::DemandForecast, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::forecast::forecast_demand(&conn, &actor.scope()).map_err(|e| e.to_string())
}

/// 2026-08-02: manual database backup (see backup.rs's module doc for
/// why this exists at all -- there was previously no recovery path for
/// a dead machine or a corrupted DB file). Owner+ only -- this exports
/// every order/payment/customer record in the tenant, more sensitive
/// than any report read. Deliberately NEVER gated on the license, same
/// reasoning as the license commands themselves: an owner must always
/// be able to get their own data out, especially a lapsed one about to
/// lose service.
#[tauri::command]
pub fn backup_database_v3(state: State<Db>, session_token: String) -> Result<crate::backup::BackupInfo, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageBackups).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::backup::create_backup(&conn)
}

#[tauri::command]
pub fn list_backups_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::backup::BackupInfo>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageBackups).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::backup::list_backups(&conn)
}

/// 2026-09-13 audit fix: exposes the real background-scheduler config
/// (frequency, off-machine secondary path, last automatic run) to Settings
/// -- see `backup.rs`'s module doc for the scheduler itself.
#[tauri::command]
pub fn get_backup_settings_v3(state: State<Db>, session_token: String) -> Result<crate::backup::BackupSettings, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageBackups).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::backup::get_backup_settings(&conn)
}

#[tauri::command]
pub fn update_backup_settings_v3(state: State<Db>, session_token: String, secondary_path: Option<String>, frequency_hours: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageBackups).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::backup::update_backup_settings(&conn, secondary_path, frequency_hours)
}

/// 2026-08-02: manual, opt-in "send a diagnostic report" -- see
/// diagnostics.rs's module doc. No extra permission gate beyond being
/// logged in at all: reporting a bug is something any floor role should
/// be able to do, not just a manager, and the log text itself is never
/// sensitive payment data.
#[tauri::command]
pub fn send_diagnostics_report_v3(app: tauri::AppHandle, state: State<Db>, session_token: String) -> Result<crate::diagnostics::DiagnosticsResult, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    crate::diagnostics::send_report(
        &log_dir,
        &crate::license::cloud::supabase_url(),
        &crate::license::cloud::supabase_anon_key(),
        &actor.tenant_id,
        &actor.device_id,
        app.package_info().version.to_string().as_str(),
    )
}

/// 2026-08-02: payment-reconciliation safety net -- see reconcile.rs's
/// module doc. Manager+, same rank as every other report; on-demand only.
#[tauri::command]
pub fn reconcile_orders_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<crate::reconcile::ReconciliationReport, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    crate::reconcile::reconcile(&conn, &actor.scope()).map_err(|e| e.to_string())
}

