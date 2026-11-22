//! The activity log screen's reader. Every sensitive action already writes a tamper-proof entry to
//! `audit_log` (see `audit.rs`); this turns those entries into plain Arabic sentences -- who, when,
//! what changed -- for the owner. Read only: nothing here can change or remove an entry.

use crate::assistant::scope_predicate;
use crate::security::Scope;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::Value;

/// The kinds the owner can filter by: (id, Arabic label).
pub const KINDS: &[(&str, &str)] = &[
    ("price", "تغيير سعر"),
    ("menu", "تعديل القائمة"),
    ("discount", "خصم"),
    ("cancel", "إلغاء طلب"),
    ("void", "إلغاء صنف من طلب"),
    ("gift", "ضيافة"),
    ("edit_item", "تعديل صنف في طلب"),
    ("refund", "استرداد"),
    ("merge", "دمج"),
    ("transfer", "نقل طاولة"),
    ("split", "تقسيم فاتورة"),
    ("reprint", "إعادة طباعة إيصال"),
    ("override", "رمز المدير"),
    ("permission", "صلاحيات الموظفين"),
    ("staff", "الموظفون"),
    ("settings", "الإعدادات"),
    ("stock", "المخزون"),
    ("finance", "المالية والموردون"),
    ("customer", "الزبائن والديون"),
    ("shift", "الورديات"),
    ("order_flow", "سير الطلبات والدفع"),
    ("other", "أخرى"),
];

#[derive(Debug, Clone, Default)]
pub struct ActivityFilter {
    pub start_iso: String,
    pub end_iso: String,
    pub actor_id: Option<String>,
    pub kind: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ActivityRow {
    pub id: String,
    pub ts: String,
    pub actor_id: String,
    pub actor_name: String,
    pub action: String,
    pub kind: String,
    pub kind_label: String,
    pub entity_type: String,
    pub entity_id: String,
    /// What happened, in plain Arabic ("غيّر سعر «برغر» من 4,000 إلى 4,500").
    pub text: String,
    /// Extra facts (the reason given, the manager who approved...), when there are any.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ActorOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct ActivityReport {
    pub rows: Vec<ActivityRow>,
    /// More matched than `limit`: the oldest are not shown.
    pub truncated: bool,
    /// Everyone who has an entry in the period (for the person filter).
    pub actors: Vec<ActorOption>,
}

pub fn kind_label(kind: &str) -> &'static str {
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, l)| *l).unwrap_or("أخرى")
}

/// 4500 -> "4,500".
pub fn fmt_amount(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn role_name(role: &str) -> &str {
    match role {
        "OWNER" => "مالك",
        "MANAGER" | "ADMIN" => "مدير",
        "CASHIER" => "كاشير",
        "KITCHEN" => "مطبخ",
        "SERVER" => "نادل",
        "PLATFORM" => "إدارة المنصة",
        other => other,
    }
}

fn status_name(status: &str) -> &str {
    match status {
        "PENDING" => "مفتوح",
        "PREPARING" => "قيد التحضير",
        "READY" => "جاهز",
        "SERVED" => "مُقدَّم",
        "PAID" => "مدفوع",
        "CANCELLED" => "ملغى",
        "SCHEDULED" => "مجدول",
        other => other,
    }
}

fn method_name(m: &str) -> &str {
    match m {
        "CASH" => "نقداً",
        "CARD" => "بطاقة",
        "WALLET" => "محفظة",
        "CREDIT" => "دين",
        other => other,
    }
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str()).filter(|x| !x.trim().is_empty())
}

fn n(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}

fn b(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(|x| x.as_bool())
}

/// Top-level fields that differ between two JSON objects.
pub fn changed_fields(before: &Value, after: &Value) -> usize {
    let (Some(a), Some(c)) = (before.as_object(), after.as_object()) else { return 0 };
    let mut keys: Vec<&String> = a.keys().chain(c.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter().filter(|k| a.get(*k) != c.get(*k)).count()
}

/// What the lookups around an entry found: the name of the thing it is about, and for a menu item
/// the price it had before.
#[derive(Debug, Clone, Default)]
pub struct Names {
    /// «برغر», «B-0007», «طاولة 3»... (already without quotes).
    pub entity: Option<String>,
    pub previous_price_cents: Option<i64>,
}

fn quoted(name: &Option<String>, fallback: &str) -> String {
    match name {
        Some(n) if !n.trim().is_empty() => format!("«{n}»"),
        _ => fallback.to_string(),
    }
}

/// (kind, sentence, detail) for one entry. `before`/`after` are the entry's payloads (Null when absent).
pub fn describe(action: &str, entity_type: &str, before: &Value, after: &Value, names: &Names) -> (&'static str, String, Option<String>) {
    let who = |fallback: &str| quoted(&names.entity, fallback);
    let reason = s(after, "reason").map(|r| format!("السبب: {r}"));
    let sub = s(after, "action").unwrap_or("");
    match (action, entity_type) {
        ("OrderStatusChanged", "order") if sub == "cancel_order" => (
            "cancel",
            format!("ألغى الطلب {}{}", who("طلباً"), n(after, "value_cents").map(|v| format!(" (قيمته {})", fmt_amount(v))).unwrap_or_default()),
            reason,
        ),
        ("OrderStatusChanged", "order_item") if sub == "void" => ("void", format!("ألغى الصنف {} من طلب", who("صنفاً")), reason),
        ("OrderStatusChanged", "order_item") if sub == "gift" => ("gift", format!("جعل الصنف {} ضيافة", who("صنفاً")), reason),
        ("OrderStatusChanged", "order_item") if sub == "gift_removed" => ("gift", format!("أزال الضيافة عن الصنف {}", who("صنفاً")), reason),
        ("OrderStatusChanged", "order_item") if sub == "edit" => ("edit_item", format!("عدّل الصنف {} في طلب", who("صنفاً")), reason),
        ("OrderStatusChanged", "order") if sub == "merge_orders" => ("merge", format!("دمج فواتير في الطلب {}", who("جديد")), reason),
        ("OrderStatusChanged", "table") if sub == "merge" => ("merge", "دمج طاولات".to_string(), None),
        ("OrderStatusChanged", "table") if sub == "unmerge" => ("merge", "فكّ دمج طاولات".to_string(), None),
        ("OrderStatusChanged", "order") if sub == "transfer" => ("transfer", format!("نقل الطلب {} إلى طاولة أخرى", who("")), None),
        ("OrderStatusChanged", "order") if sub == "split" => ("split", format!("قسّم الطلب {} إلى {} فواتير", who(""), n(after, "child_count").unwrap_or(0)), None),
        ("OrderStatusChanged", "order") if sub == "receipt_reprinted" => ("reprint", format!("أعاد طباعة إيصال الطلب {}", who("")), None),
        ("OrderStatusChanged", "order") if sub == "pickup_no_show" => ("cancel", format!("سجّل أن زبون الطلب {} لم يحضر", who("")), reason),
        ("OrderStatusChanged", "order") if sub == "items_added" => ("order_flow", format!("أضاف أصنافاً إلى الطلب {}", who("")), None),
        ("OrderStatusChanged", "order") if sub == "delivery_driver_assigned" => ("order_flow", format!("عيّن سائقاً للطلب {}", who("")), None),
        ("OrderStatusChanged", "order") if sub == "delivery_status" => ("order_flow", format!("غيّر حالة توصيل الطلب {} إلى {}", who(""), s(after, "status").unwrap_or("؟")), s(after, "note").map(|x| x.to_string())),
        ("OrderStatusChanged", "order") if sub == "pickup_collected" || sub == "pickup_sent_to_kitchen" => ("order_flow", format!("طلب استلام {}", who("")), None),
        ("OrderStatusChanged", _) => {
            let to = s(after, "status").map(status_name).unwrap_or("حالة جديدة");
            ("order_flow", format!("غيّر حالة الطلب {} إلى {}", who(""), to), None)
        }
        ("OrderCreated", _) => ("order_flow", format!("أنشأ الطلب {}", who("")), n(after, "total_cents").map(|t| format!("القيمة: {}", fmt_amount(t)))),
        ("PaymentTaken", "order") => (
            "order_flow",
            format!("استلم دفعة {} على الطلب {}", n(after, "amount_cents").map(|a| format!("{} ({})", fmt_amount(a), method_name(s(after, "method").unwrap_or("")))).unwrap_or_default(), who("")),
            None,
        ),
        ("PaymentTaken", _) => ("finance", "سجّل تسوية سائق توصيل".to_string(), None),
        ("DiscountApplied", _) => (
            "discount",
            format!("طبّق خصماً {} على الطلب {}", n(after, "discount_cents").map(fmt_amount).unwrap_or_default(), who("")),
            b(after, "manager_override_used").filter(|x| *x).map(|_| "بموافقة المدير".to_string()),
        ),
        ("ManagerOverrideGranted", _) => ("override", format!("استُعمل رمز المدير {}", who("")), None),
        ("OrderRefunded", _) => (
            "refund",
            format!("استرد {} من الطلب {}", n(after, "amount_cents").map(fmt_amount).unwrap_or_default(), who("")),
            reason,
        ),
        ("MenuItemChanged", "menu_item") => {
            if let Some(price) = n(after, "price_cents") {
                match names.previous_price_cents {
                    Some(old) if old != price => ("price", format!("غيّر سعر {} من {} إلى {}", who("صنف"), fmt_amount(old), fmt_amount(price)), None),
                    Some(_) => ("menu", format!("عدّل بيانات الصنف {} (السعر {})", who(""), fmt_amount(price)), None),
                    None => ("menu", format!("أضاف أو عدّل الصنف {} بسعر {}", s(after, "name").map(|n| format!("«{n}»")).unwrap_or_else(|| who("")), fmt_amount(price)), None),
                }
            } else if b(after, "deleted") == Some(true) {
                ("menu", format!("حذف الصنف {}", who("")), None)
            } else if let Some(active) = b(after, "is_active") {
                ("menu", format!("{} الصنف {}", if active { "فعّل" } else { "أوقف" }, who("")), None)
            } else {
                ("menu", format!("عدّل الصنف {}", who("")), None)
            }
        }
        ("MenuItemChanged", "category") => ("menu", format!("عدّل الفئة {}", who("")), None),
        ("MenuItemChanged", "option_group") => ("menu", format!("عدّل خيارات الأصناف {}", s(after, "name").map(|n| format!("«{n}»")).unwrap_or_default()), None),
        ("MenuItemChanged", _) => ("menu", "عدّل القائمة".to_string(), None),
        ("ComboMealChanged", _) => ("menu", "عدّل وجبة كومبو".to_string(), None),
        ("HappyHourRuleChanged", _) => ("menu", "عدّل عرض الساعة السعيدة".to_string(), None),
        ("StaffCreated", _) => (
            "staff",
            format!("أضاف {} «{}»", s(after, "role").map(role_name).unwrap_or("حساباً"), s(after, "name").unwrap_or("")),
            None,
        ),
        ("StaffRoleUpdated", _) => {
            if let Some(role) = s(after, "role") {
                ("permission", format!("غيّر دور {} إلى {}", who("موظف"), role_name(role)), None)
            } else if let Some(active) = b(after, "is_active") {
                ("staff", format!("{} حساب {}", if active { "فعّل" } else { "أوقف" }, who("موظف")), None)
            } else {
                ("staff", format!("عدّل بيانات {}", who("موظف")), b(after, "pin_changed").filter(|x| *x).map(|_| "غيّر الرمز السري".to_string()))
            }
        }
        ("PasswordChanged", _) => ("staff", "غيّر كلمة المرور".to_string(), None),
        ("SettingsChanged", "role_access") => ("permission", "غيّر صلاحيات الأدوار".to_string(), Some(format!("عدد البنود التي تغيّرت: {}", changed_fields(before, after)))),
        ("SettingsChanged", "staff_access") => ("permission", format!("غيّر صلاحيات {}", who("موظف")), Some(format!("عدد البنود التي تغيّرت: {}", changed_fields(before, after)))),
        ("SettingsChanged", "ops_settings") => ("permission", "غيّر ما يراه الكاشير من سجل الطلبات".to_string(), None),
        ("SettingsChanged", "chain_config") => {
            if let Some(pct) = n(after, "discount_cap_cashier_percent") {
                ("settings", format!("غيّر حدود الخصم (الكاشير {pct}%)"), None)
            } else if n(after, "tax_rate_cents").is_some() {
                ("settings", "غيّر الضريبة".to_string(), None)
            } else if let Some(c) = s(after, "currency") {
                ("settings", format!("غيّر العملة إلى {c}"), None)
            } else if let Some(c) = s(after, "chain_name") {
                ("settings", format!("غيّر اسم المنشأة إلى «{c}»"), None)
            } else {
                ("settings", "غيّر إعدادات المنشأة".to_string(), None)
            }
        }
        ("SettingsChanged", "attendance") | ("SettingsChanged", "attendance_settings") | ("SettingsChanged", "fingerprint_enrolment") | ("SettingsChanged", "roster_entry") => {
            ("staff", "عدّل الحضور أو الدوام".to_string(), s(after, "reason").map(|r| format!("السبب: {r}")))
        }
        ("SettingsChanged", "printer") => ("settings", format!("عدّل إعدادات طابعة {}", who("")), None),
        ("SettingsChanged", e) if e.starts_with("payroll") => ("finance", "عدّل الرواتب".to_string(), None),
        ("SettingsChanged", "delivery_driver") | ("SettingsChanged", "delivery_settings") => ("settings", "عدّل إعدادات التوصيل".to_string(), None),
        ("SettingsChanged", _) => ("settings", "غيّر الإعدادات".to_string(), None),
        ("BranchCreated", _) | ("BranchChanged", _) => ("settings", format!("عدّل الفرع {}", who("")), None),
        ("InventoryAdjusted", _) => (
            "stock",
            match (n(after, "change_amount"), n(after, "waste")) {
                (Some(c), _) => format!("عدّل مخزون {} ({:+})", who("مادة"), c),
                (_, Some(w)) => format!("سجّل هالكاً من {} ({w})", who("مادة")),
                _ => format!("عدّل المخزون {}", who("")),
            },
            reason,
        ),
        ("ShiftOpened", _) => ("shift", "فتح وردية".to_string(), n(after, "starting_cash_cents").map(|c| format!("نقد البداية: {}", fmt_amount(c)))),
        ("ShiftClosed", _) => (
            "shift",
            if b(after, "forced") == Some(true) { "أغلق وردية بالقوة".to_string() } else { "أغلق وردية".to_string() },
            n(after, "difference_cents").filter(|d| *d != 0).map(|d| format!("فرق الصندوق: {}", fmt_amount(d))),
        ),
        ("CustomerChanged", _) => ("customer", if b(after, "deleted") == Some(true) { format!("حذف الزبون {}", who("")) } else { format!("عدّل بيانات الزبون {}", who("")) }, None),
        ("DebtRecorded", _) => (
            "customer",
            match n(after, "amount_cents") {
                Some(a) => format!("سجّل تسديد دين {} من {}", fmt_amount(a), who("زبون")),
                None => format!("عدّل سجل الدين {}", who("")),
            },
            None,
        ),
        ("LoyaltyCardIssued", _) | ("LoyaltyTierChanged", _) | ("LoyaltyRewardChanged", _) | ("LoyaltyPointsRedeemed", _) => ("customer", "عدّل الولاء أو النقاط".to_string(), None),
        ("OperationalCostRecorded", _) | ("InvoiceChanged", _) | ("SupplierChanged", _) | ("SupplierPaymentRecorded", _) | ("PurchaseOrderChanged", _) | ("PurchaseOrderReceived", _) => (
            "finance",
            match (s(after, "category"), n(after, "amount_cents")) {
                (Some(c), Some(a)) => format!("سجّل مصروفاً «{c}» بقيمة {}", fmt_amount(a)),
                (None, Some(a)) => format!("سجّل مبلغاً {}", fmt_amount(a)),
                _ => "عدّل المصروفات أو الموردين".to_string(),
            },
            None,
        ),
        _ => ("other", format!("عملية {action}"), None),
    }
}

/// The names behind an entry's ids, looked up in the local database.
fn lookup_names(conn: &Connection, action: &str, entity_type: &str, entity_id: &str, ts: &str, after: &Value) -> Names {
    let one = |sql: &str| -> Option<String> { conn.query_row(sql, params![entity_id], |r| r.get::<_, Option<String>>(0)).ok().flatten() };
    let entity = match entity_type {
        "staff" => one("SELECT name FROM staff WHERE id = ?1"),
        "menu_item" => one("SELECT name FROM menu_items WHERE id = ?1"),
        "category" => one("SELECT name FROM categories WHERE id = ?1"),
        "table" => one("SELECT name FROM tables WHERE id = ?1"),
        "customer" => one("SELECT name FROM customers WHERE id = ?1"),
        "debtor" => one("SELECT name FROM debtors WHERE id = ?1"),
        "ingredient" => one("SELECT name FROM ingredients WHERE id = ?1"),
        "printer" => one("SELECT name FROM printers WHERE id = ?1"),
        "order" => one("SELECT series || '-' || printf('%04d', seq) FROM order_numbers WHERE order_id = ?1"),
        "order_item" => one("SELECT m.name FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.id = ?1"),
        _ => None,
    };
    let mut names = Names { entity, previous_price_cents: None };
    if action == "MenuItemChanged" && entity_type == "menu_item" && n(after, "price_cents").is_some() {
        if let Ok(mut stmt) = conn.prepare("SELECT after_json FROM audit_log WHERE entity_type = 'menu_item' AND entity_id = ?1 AND action = 'MenuItemChanged' AND julianday(ts) < julianday(?2) ORDER BY julianday(ts) DESC, seq DESC LIMIT 30") {
            if let Ok(rows) = stmt.query_map(params![entity_id, ts], |r| r.get::<_, Option<String>>(0)) {
                for json in rows.flatten().flatten() {
                    if let Some(p) = serde_json::from_str::<Value>(&json).ok().and_then(|v| n(&v, "price_cents")) {
                        names.previous_price_cents = Some(p);
                        break;
                    }
                }
            }
        }
    }
    names
}

pub fn list(conn: &Connection, scope: &Scope, filter: &ActivityFilter) -> Result<ActivityReport, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let (pred, mut args) = scope_predicate(scope);
    let pred = pred.replace("tenant_id", "a.tenant_id").replace("branch_id", "a.branch_id");
    let (ia, ib) = (args.len() + 1, args.len() + 2);
    args.push(filter.start_iso.clone());
    args.push(filter.end_iso.clone());
    let limit = filter.limit.clamp(1, 1000);
    let mut report = ActivityReport::default();

    // Everyone with an entry in the period, for the person filter.
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT DISTINCT a.actor_id, COALESCE(st.name, a.actor_id) FROM audit_log a LEFT JOIN staff st ON st.id = a.actor_id \
                 WHERE {pred} AND julianday(a.ts) >= julianday(?{ia}) AND julianday(a.ts) <= julianday(?{ib}) ORDER BY 2"
            ))
            .map_err(e)?;
        report.actors = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok(ActorOption { id: r.get(0)?, name: r.get(1)? }))
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
    }

    let mut actor_clause = String::new();
    if let Some(actor) = filter.actor_id.as_deref().filter(|a| !a.is_empty()) {
        args.push(actor.to_string());
        actor_clause = format!(" AND a.actor_id = ?{}", args.len());
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT a.id, a.ts, a.actor_id, COALESCE(st.name, 'غير معروف'), a.action, a.entity_type, a.entity_id, a.before_json, a.after_json \
             FROM audit_log a LEFT JOIN staff st ON st.id = a.actor_id \
             WHERE {pred} AND julianday(a.ts) >= julianday(?{ia}) AND julianday(a.ts) <= julianday(?{ib}){actor_clause} \
             ORDER BY julianday(a.ts) DESC, a.seq DESC LIMIT 6000"
        ))
        .map_err(e)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, Option<String>>(7)?, r.get::<_, Option<String>>(8)?))
        })
        .map_err(e)?;
    for row in rows {
        let (id, ts, actor_id, actor_name, action, entity_type, entity_id, before_json, after_json) = row.map_err(e)?;
        let before: Value = before_json.as_deref().and_then(|j| serde_json::from_str(j).ok()).unwrap_or(Value::Null);
        let after: Value = after_json.as_deref().and_then(|j| serde_json::from_str(j).ok()).unwrap_or(Value::Null);
        let names = lookup_names(conn, &action, &entity_type, &entity_id, &ts, &after);
        let (kind, text, detail) = describe(&action, &entity_type, &before, &after, &names);
        if filter.kind.as_deref().filter(|k| !k.is_empty()).is_some_and(|k| k != kind) {
            continue;
        }
        if report.rows.len() >= limit {
            report.truncated = true;
            break;
        }
        report.rows.push(ActivityRow { id, ts, actor_id, actor_name, action, kind: kind.to_string(), kind_label: kind_label(kind).to_string(), entity_type, entity_id, text, detail });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn none() -> Names {
        Names::default()
    }

    fn named(n: &str) -> Names {
        Names { entity: Some(n.into()), previous_price_cents: None }
    }

    #[test]
    fn money_has_thousand_separators() {
        assert_eq!(fmt_amount(0), "0");
        assert_eq!(fmt_amount(999), "999");
        assert_eq!(fmt_amount(4500), "4,500");
        assert_eq!(fmt_amount(1234567), "1,234,567");
        assert_eq!(fmt_amount(-2500), "-2,500");
    }

    #[test]
    fn a_price_change_says_from_and_to() {
        let after = json!({ "name": "برغر", "price_cents": 4500 });
        let (kind, text, _) = describe("MenuItemChanged", "menu_item", &Value::Null, &after, &Names { entity: Some("برغر".into()), previous_price_cents: Some(4000) });
        assert_eq!(kind, "price");
        assert_eq!(text, "غيّر سعر «برغر» من 4,000 إلى 4,500");
        let (kind, _, _) = describe("MenuItemChanged", "menu_item", &Value::Null, &after, &Names { entity: Some("برغر".into()), previous_price_cents: Some(4500) });
        assert_eq!(kind, "menu", "same price: a name or cost edit");
        let (kind, text, _) = describe("MenuItemChanged", "menu_item", &Value::Null, &after, &named("برغر"));
        assert_eq!((kind, text.as_str()), ("menu", "أضاف أو عدّل الصنف «برغر» بسعر 4,500"));
    }

    #[test]
    fn cancellations_voids_gifts_merges_and_transfers_read_as_sentences() {
        let (k, t, d) = describe("OrderStatusChanged", "order", &Value::Null, &json!({ "action": "cancel_order", "reason": "الزبون غادر", "value_cents": 12000 }), &named("B-0007"));
        assert_eq!((k, t.as_str(), d.as_deref()), ("cancel", "ألغى الطلب «B-0007» (قيمته 12,000)", Some("السبب: الزبون غادر")));
        let (k, t, d) = describe("OrderStatusChanged", "order_item", &Value::Null, &json!({ "action": "void", "reason": "خطأ" }), &named("كولا"));
        assert_eq!((k, t.as_str(), d.as_deref()), ("void", "ألغى الصنف «كولا» من طلب", Some("السبب: خطأ")));
        assert_eq!(describe("OrderStatusChanged", "order_item", &Value::Null, &json!({ "action": "gift" }), &named("كولا")).0, "gift");
        assert_eq!(describe("OrderStatusChanged", "order", &Value::Null, &json!({ "action": "merge_orders" }), &named("B-0001")).0, "merge");
        assert_eq!(describe("OrderStatusChanged", "table", &Value::Null, &json!({ "action": "unmerge" }), &none()).0, "merge");
        assert_eq!(describe("OrderStatusChanged", "order", &Value::Null, &json!({ "action": "transfer" }), &none()).0, "transfer");
        assert_eq!(describe("OrderStatusChanged", "order", &Value::Null, &json!({ "action": "receipt_reprinted" }), &none()).0, "reprint");
        let (k, t, _) = describe("OrderStatusChanged", "order", &json!({ "status": "PENDING" }), &json!({ "status": "READY" }), &named("A-0002"));
        assert_eq!((k, t.as_str()), ("order_flow", "غيّر حالة الطلب «A-0002» إلى جاهز"));
    }

    #[test]
    fn discounts_refunds_and_permissions() {
        let (k, t, d) = describe("DiscountApplied", "order", &Value::Null, &json!({ "discount_cents": 500, "manager_override_used": true }), &named("B-0003"));
        assert_eq!((k, t.as_str(), d.as_deref()), ("discount", "طبّق خصماً 500 على الطلب «B-0003»", Some("بموافقة المدير")));
        assert_eq!(describe("OrderRefunded", "order", &Value::Null, &json!({ "amount_cents": 3000, "reason": "بارد" }), &named("B-0003")).1, "استرد 3,000 من الطلب «B-0003»");
        let (k, t, d) = describe("SettingsChanged", "role_access", &json!({ "a": 1, "b": 2 }), &json!({ "a": 1, "b": 3, "c": 4 }), &none());
        assert_eq!((k, t.as_str(), d.as_deref()), ("permission", "غيّر صلاحيات الأدوار", Some("عدد البنود التي تغيّرت: 2")));
        let (k, t, _) = describe("StaffRoleUpdated", "staff", &json!({ "role_rank": 1 }), &json!({ "role": "MANAGER", "role_rank": 2 }), &named("عمر"));
        assert_eq!((k, t.as_str()), ("permission", "غيّر دور «عمر» إلى مدير"));
        let (_, t, _) = describe("StaffRoleUpdated", "staff", &Value::Null, &json!({ "is_active": false }), &named("عمر"));
        assert_eq!(t, "أوقف حساب «عمر»");
    }

    #[test]
    fn unknown_actions_still_get_a_sentence_and_every_kind_has_a_label() {
        let (k, t, _) = describe("SomethingNew", "x", &Value::Null, &Value::Null, &none());
        assert_eq!(k, "other");
        assert!(t.contains("SomethingNew"));
        for (id, label) in KINDS {
            assert_eq!(kind_label(id), *label);
        }
        assert_eq!(kind_label("nope"), "أخرى");
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE menu_items (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE order_numbers (order_id TEXT PRIMARY KEY, series TEXT, seq INTEGER);
             CREATE TABLE audit_log (device_id TEXT, seq INTEGER, id TEXT, ts TEXT, tenant_id TEXT, branch_id TEXT, actor_id TEXT, action TEXT, entity_type TEXT, entity_id TEXT, before_json TEXT, after_json TEXT);
             INSERT INTO staff VALUES ('boss', 'المالك'), ('u1', 'ليلى');
             INSERT INTO menu_items VALUES ('m1', 'برغر');
             INSERT INTO order_numbers VALUES ('o1', 'B', 7);
             INSERT INTO audit_log VALUES
              ('d', 1, 'a1', '2026-11-05T09:00:00Z', 't', NULL, 'boss', 'MenuItemChanged', 'menu_item', 'm1', NULL, '{\"name\":\"برغر\",\"price_cents\":4000}'),
              ('d', 2, 'a2', '2026-11-05T10:00:00Z', 't', 'b', 'boss', 'MenuItemChanged', 'menu_item', 'm1', NULL, '{\"name\":\"برغر\",\"price_cents\":4500}'),
              ('d', 3, 'a3', '2026-11-05T11:00:00Z', 't', 'b', 'u1', 'OrderStatusChanged', 'order', 'o1', NULL, '{\"action\":\"cancel_order\",\"reason\":\"خطأ\",\"value_cents\":9000}'),
              ('d', 4, 'a4', '2026-11-05T12:00:00Z', 't', 'b', 'u1', 'OrderCreated', 'order', 'o1', NULL, '{\"order_type\":\"DINE_IN\",\"total_cents\":9000}'),
              ('d', 5, 'a5', '2026-11-05T13:00:00Z', 'other', 'b', 'u1', 'OrderCreated', 'order', 'o9', NULL, '{}'),
              ('d', 6, 'a6', '2026-11-01T13:00:00Z', 't', 'b', 'u1', 'OrderCreated', 'order', 'o1', NULL, '{}');",
        )
        .unwrap();
        conn
    }

    fn owner() -> Scope {
        Scope::Tenant { tenant_id: "t".into() }
    }

    fn filter() -> ActivityFilter {
        ActivityFilter { start_iso: "2026-11-05T00:00:00Z".into(), end_iso: "2026-11-05T23:59:59Z".into(), limit: 100, ..Default::default() }
    }

    #[test]
    fn the_log_lists_newest_first_with_names_and_the_previous_price() {
        let r = list(&db(), &owner(), &filter()).unwrap();
        assert_eq!(r.rows.len(), 4, "the other tenant's entry and the old one are not here");
        assert_eq!(r.rows[0].action, "OrderCreated");
        assert_eq!(r.rows[0].actor_name, "ليلى");
        let price = r.rows.iter().find(|x| x.kind == "price").unwrap();
        assert_eq!(price.text, "غيّر سعر «برغر» من 4,000 إلى 4,500");
        assert_eq!(price.actor_name, "المالك");
        let cancel = r.rows.iter().find(|x| x.kind == "cancel").unwrap();
        assert_eq!(cancel.text, "ألغى الطلب «B-0007» (قيمته 9,000)");
        assert_eq!(r.actors.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["المالك", "ليلى"]);
        assert!(!r.truncated);
    }

    #[test]
    fn filters_by_person_kind_and_limit() {
        let by_person = list(&db(), &owner(), &ActivityFilter { actor_id: Some("boss".into()), ..filter() }).unwrap();
        assert_eq!(by_person.rows.len(), 2);
        assert_eq!(by_person.actors.len(), 2, "the person list stays complete while filtering");
        let by_kind = list(&db(), &owner(), &ActivityFilter { kind: Some("cancel".into()), ..filter() }).unwrap();
        assert_eq!(by_kind.rows.len(), 1);
        let limited = list(&db(), &owner(), &ActivityFilter { limit: 2, ..filter() }).unwrap();
        assert_eq!((limited.rows.len(), limited.truncated), (2, true));
    }
}
