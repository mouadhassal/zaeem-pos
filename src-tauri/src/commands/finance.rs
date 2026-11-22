//! Finance ledger commands: expense reports and settings, rent contracts, receipt photos and
//! the cost-of-sales classes. All back-office (hub only, no LAN forwarding). The pure logic lives
//! in `crate::finance`.

use super::orders::sync_enqueue_operational_cost;
use super::shared::*;
use crate::audit;
use crate::finance::{self, CostFields, CostFilter, RentInput};
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::{Manager, State};

/// Totals of the expenses grouped by `category`, `period` (month) or `cost_centre`, with the same
/// optional filters as the list.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn get_cost_report_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, group_by: String, start_date: Option<String>, end_date: Option<String>, category: Option<String>, cost_centre: Option<String>) -> Result<finance::CostReport, String> {
    get_cost_report_v3_impl(&state, &license, session_token, group_by, start_date, end_date, category, cost_centre)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn get_cost_report_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, group_by: String, start_date: Option<String>, end_date: Option<String>, category: Option<String>, cost_centre: Option<String>) -> Result<finance::CostReport, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let filter = CostFilter { from: start_date, to: end_date, category, cost_centre };
    finance::cost_report(&conn, &actor.scope(), &filter, &group_by)
}

#[tauri::command]
pub fn get_finance_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<finance::FinanceSettings, String> {
    get_finance_settings_v3_impl(&state, &license, session_token)
}

pub(crate) fn get_finance_settings_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<finance::FinanceSettings, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(finance::load_settings(&conn))
}

/// The owner's choices: how costs that name a month are counted (`accrual` / `payment`) and the
/// expense categories they added to the built-in list.
#[tauri::command]
pub fn save_finance_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, cost_basis: String, custom_categories: Vec<String>) -> Result<finance::FinanceSettings, String> {
    save_finance_settings_v3_impl(&state, &license, session_token, cost_basis, custom_categories)
}

pub(crate) fn save_finance_settings_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, cost_basis: String, custom_categories: Vec<String>) -> Result<finance::FinanceSettings, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = finance::load_settings(&tx);
    finance::save_settings(&tx, &cost_basis, &custom_categories)?;
    let after = finance::load_settings(&tx);
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "finance_settings", &actor.tenant_id, Some(&serde_json::json!({ "cost_basis": before.cost_basis, "custom": before.custom_categories })), Some(&serde_json::json!({ "cost_basis": after.cost_basis, "custom": after.custom_categories }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(after)
}

// ---------------------------------------------------------------------------
// Rent
// ---------------------------------------------------------------------------

fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Every rent contract with what has fallen due, what was paid and what is left, month by month.
#[tauri::command]
pub fn list_rent_contracts_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<finance::RentContract>, String> {
    list_rent_contracts_v3_impl(&state, &license, session_token)
}

pub(crate) fn list_rent_contracts_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<Vec<finance::RentContract>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    finance::rent_contracts(&conn, &actor.scope(), &today_local())
}

/// Creates a contract (no `contract_id`) or edits one.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_rent_contract_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, contract_id: Option<String>, label: String, period: String, amount_cents: i64, start_date: String, end_date: Option<String>, active: bool) -> Result<String, String> {
    save_rent_contract_v3_impl(&state, &license, session_token, contract_id, label, period, amount_cents, start_date, end_date, active)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn save_rent_contract_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, contract_id: Option<String>, label: String, period: String, amount_cents: i64, start_date: String, end_date: Option<String>, active: bool) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };
    let mut input = RentInput { label, period, amount_cents, start_date, end_date, active };
    input.validate(&today_local())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = finance::save_rent_contract(&tx, &tenant_id, &branch_id, &actor.scope(), contract_id.as_deref(), &input)?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::SettingsChanged, "rent_contract", &id, None, Some(&serde_json::json!({ "label": input.label, "period": input.period, "amount_cents": input.amount_cents, "active": input.active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Pays rent: an expense (إيجار) linked to the contract, for the month named in `accrual_period`
/// (default: the month of the payment date).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn record_rent_payment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, contract_id: String, amount_cents: i64, date: Option<String>, accrual_period: Option<String>, payment_method: Option<String>, reference_no: Option<String>, notes: Option<String>) -> Result<String, String> {
    record_rent_payment_v3_impl(&state, &license, session_token, contract_id, amount_cents, date, accrual_period, payment_method, reference_no, notes)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_rent_payment_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, contract_id: String, amount_cents: i64, date: Option<String>, accrual_period: Option<String>, payment_method: Option<String>, reference_no: Option<String>, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let fields = CostFields {
        amount_cents,
        date: date.filter(|d| !d.trim().is_empty()).unwrap_or_else(today_local),
        accrual_period,
        payment_method,
        reference_no,
        notes,
        ..Default::default()
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (cost_id, tenant_id, branch_id) = finance::record_rent_payment(&tx, &actor.scope(), &actor.id, &contract_id, fields)?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::OperationalCostRecorded, "operational_cost", &cost_id, None, Some(&serde_json::json!({ "category": finance::RENT_CATEGORY, "amount_cents": amount_cents, "rent_contract": contract_id }))).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_operational_cost(&tx, &tenant_id, &branch_id, &cost_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(cost_id)
}

// ---------------------------------------------------------------------------
// Receipt photo
// ---------------------------------------------------------------------------

/// Attaches (or replaces) the receipt photo of an expense. Same storage as the menu photos
/// (JPEG, PNG or WEBP, up to 3 MB), kept under the expense's id.
#[tauri::command]
pub fn upload_cost_attachment_v3(app: tauri::AppHandle, state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, cost_id: String, photo_bytes: Vec<u8>) -> Result<(), String> {
    let app_data_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    upload_cost_attachment_v3_impl(&app_data_dir, &state, &license, session_token, cost_id, photo_bytes)
}

pub(crate) fn upload_cost_attachment_v3_impl(app_data_dir: &std::path::Path, state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, cost_id: String, photo_bytes: Vec<u8>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        finance::cost_owner(&conn, &actor.scope(), &cost_id)?;
    }
    let file_path = crate::photos::store_photo(app_data_dir, &actor.tenant_id, &cost_id, &photo_bytes).map_err(|e| e.to_string())?;
    let path_str = file_path.to_string_lossy().to_string();
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = finance::set_attachment(&tx, &actor.scope(), &cost_id, Some(&path_str))?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::OperationalCostRecorded, "operational_cost", &cost_id, None, Some(&serde_json::json!({ "attachment": true, "bytes": photo_bytes.len() }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The receipt photo as a `data:` URI, or nothing when there is none (or the file is gone).
#[tauri::command]
pub fn get_cost_attachment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, cost_id: String) -> Result<Option<String>, String> {
    get_cost_attachment_v3_impl(&state, &license, session_token, cost_id)
}

pub(crate) fn get_cost_attachment_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, cost_id: String) -> Result<Option<String>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let path = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        finance::attachment_path(&conn, &actor.scope(), &cost_id)?
    };
    Ok(path.as_deref().and_then(crate::photos::read_as_data_uri))
}

// ---------------------------------------------------------------------------
// Cost classes
// ---------------------------------------------------------------------------

/// Sets what kind of cost of sales a menu category is (FOOD, BEVERAGE, SHISHA, OTHER; empty = FOOD).
#[tauri::command]
pub fn set_category_cost_class_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, category_id: String, cost_class: Option<String>) -> Result<(), String> {
    set_category_cost_class_v3_impl(&state, &license, session_token, category_id, cost_class)
}

pub(crate) fn set_category_cost_class_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, category_id: String, cost_class: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    finance::set_category_cost_class(&tx, &actor.tenant_id, &category_id, cost_class.as_deref())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, None, Some(&serde_json::json!({ "cost_class": cost_class }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Cost of the items sold in the range per cost class, and labour, each as a share of net sales.
#[tauri::command]
pub fn get_cost_of_sales_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, start_iso: String, end_iso: String, tz_offset_minutes: Option<i64>) -> Result<finance::CostOfSales, String> {
    get_cost_of_sales_v3_impl(&state, &license, session_token, start_iso, end_iso, tz_offset_minutes)
}

pub(crate) fn get_cost_of_sales_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, start_iso: String, end_iso: String, tz_offset_minutes: Option<i64>) -> Result<finance::CostOfSales, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    finance::cost_of_sales(&conn, &actor.scope(), &start_iso, &end_iso, tz_offset_minutes.unwrap_or(0)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Remote back office: the arms a second till's back-office commands take on the hub
// (see `lan_rpc_office.rs`). Each arm calls the same `_impl` the local command wraps.
// ---------------------------------------------------------------------------

#[allow(unused_variables, clippy::let_unit_value)]
pub(crate) fn dispatch_remote_office(db: &Db, license: &crate::license::cloud::CloudLicenseState, command: &str, args: &serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    use super::lan_rpc::lan_arg;
    let value = match command {
        "get_cost_report_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let group_by: String = lan_arg(args, "groupBy")?;
            let start_date: Option<String> = lan_arg(args, "startDate")?;
            let end_date: Option<String> = lan_arg(args, "endDate")?;
            let category: Option<String> = lan_arg(args, "category")?;
            let cost_centre: Option<String> = lan_arg(args, "costCentre")?;
            let r = get_cost_report_v3_impl(db, license, session_token, group_by, start_date, end_date, category, cost_centre)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_finance_settings_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = get_finance_settings_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "save_finance_settings_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let cost_basis: String = lan_arg(args, "costBasis")?;
            let custom_categories: Vec<String> = lan_arg(args, "customCategories")?;
            let r = save_finance_settings_v3_impl(db, license, session_token, cost_basis, custom_categories)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "list_rent_contracts_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = list_rent_contracts_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "save_rent_contract_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let contract_id: Option<String> = lan_arg(args, "contractId")?;
            let label: String = lan_arg(args, "label")?;
            let period: String = lan_arg(args, "period")?;
            let amount_cents: i64 = lan_arg(args, "amountCents")?;
            let start_date: String = lan_arg(args, "startDate")?;
            let end_date: Option<String> = lan_arg(args, "endDate")?;
            let active: bool = lan_arg(args, "active")?;
            let r = save_rent_contract_v3_impl(db, license, session_token, contract_id, label, period, amount_cents, start_date, end_date, active)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "record_rent_payment_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let contract_id: String = lan_arg(args, "contractId")?;
            let amount_cents: i64 = lan_arg(args, "amountCents")?;
            let date: Option<String> = lan_arg(args, "date")?;
            let accrual_period: Option<String> = lan_arg(args, "accrualPeriod")?;
            let payment_method: Option<String> = lan_arg(args, "paymentMethod")?;
            let reference_no: Option<String> = lan_arg(args, "referenceNo")?;
            let notes: Option<String> = lan_arg(args, "notes")?;
            let r = record_rent_payment_v3_impl(db, license, session_token, contract_id, amount_cents, date, accrual_period, payment_method, reference_no, notes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "upload_cost_attachment_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let cost_id: String = lan_arg(args, "costId")?;
            let photo_bytes: Vec<u8> = lan_arg(args, "photoBytes")?;
            let r = upload_cost_attachment_v3_impl(&crate::lan::rpc_app_data_dir()?, db, license, session_token, cost_id, photo_bytes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_cost_attachment_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let cost_id: String = lan_arg(args, "costId")?;
            let r = get_cost_attachment_v3_impl(db, license, session_token, cost_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "set_category_cost_class_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let category_id: String = lan_arg(args, "categoryId")?;
            let cost_class: Option<String> = lan_arg(args, "costClass")?;
            let r = set_category_cost_class_v3_impl(db, license, session_token, category_id, cost_class)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_cost_of_sales_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let start_iso: String = lan_arg(args, "startIso")?;
            let end_iso: String = lan_arg(args, "endIso")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = get_cost_of_sales_v3_impl(db, license, session_token, start_iso, end_iso, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
