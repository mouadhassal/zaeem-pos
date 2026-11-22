//! Credit customers (the debt book) tied to the customers list.
//!
//! * A **debtor** may be linked to a **customer** (`debtors.customer_id`, nullable: an old debtor stays unlinked and
//!   keeps working exactly as before). A debtor is linked by phone (or e-mail): an existing customer with the same
//!   number is reused, otherwise one is made.
//! * The **statement** lists every credit invoice (a `DEBT` entry, one per credit sale, plus the opening balance) with
//!   what was settled against it and what is still owed, and every entry in time order with the running balance.
//! * A **settlement** is a `PAYMENT` entry. It may name one credit invoice (`order_id`), which then must be open and
//!   not overpaid, or it may be general: a general payment is counted against the oldest open invoices first, so the
//!   statement always shows a remaining amount per invoice. Refunds of a credit order are `PAYMENT` entries carrying
//!   that order's id, so they settle their own invoice the same way.
//!
//! Money is whole pounds in `*_cents` columns, like everywhere else.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Only the digits of a phone number.
pub fn digits(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Two phone numbers are the same person's when their digits match, or when their last nine digits do (a number written
/// with or without the country code).
pub fn same_phone(a: &str, b: &str) -> bool {
    let (da, db) = (digits(a), digits(b));
    if da.len() < 6 || db.len() < 6 {
        return false;
    }
    if da == db {
        return true;
    }
    if da.len() >= 9 && db.len() >= 9 {
        return da[da.len() - 9..] == db[db.len() - 9..];
    }
    false
}

/// The customer of this business who has this phone (or, failing a phone, this e-mail).
pub fn find_customer(conn: &Connection, tenant_id: &str, phone: Option<&str>, email: Option<&str>) -> Result<Option<(String, String)>, String> {
    if let Some(p) = phone.map(str::trim).filter(|p| !p.is_empty()) {
        let mut stmt = conn
            .prepare("SELECT id, name, phone FROM customers WHERE tenant_id = ?1 AND phone IS NOT NULL AND phone != '' ORDER BY last_modified")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![tenant_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, name, their) = row.map_err(|e| e.to_string())?;
            if same_phone(p, &their) {
                return Ok(Some((id, name)));
            }
        }
    }
    if let Some(e) = email.map(str::trim).filter(|e| !e.is_empty()) {
        let found: Option<(String, String)> = conn
            .query_row(
                "SELECT id, name FROM customers WHERE tenant_id = ?1 AND lower(email) = lower(?2) LIMIT 1",
                params![tenant_id, e],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        return Ok(found);
    }
    Ok(None)
}

/// What linking a debtor ended up doing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DebtorLink {
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    /// A new customer was made for this debtor.
    pub created: bool,
}

/// Links a debtor to a customer. With `customer_id` that customer is used (it must be this business's). Without one,
/// the customer with the debtor's phone (or e-mail) is used, and when there is none `create_if_missing` decides whether
/// one is made from the debtor's own name and contact. The caller has already checked who may touch this debtor.
pub fn link_debtor_to_customer(conn: &Connection, tenant_id: &str, debtor_id: &str, customer_id: Option<&str>, create_if_missing: bool) -> Result<DebtorLink, String> {
    let (name, phone, email, debtor_tenant): (String, Option<String>, Option<String>, String) = conn
        .query_row("SELECT name, phone, email, tenant_id FROM debtors WHERE id = ?1", params![debtor_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("المدين غير موجود")?;
    if debtor_tenant != tenant_id {
        return Err("المدين غير موجود".into());
    }
    let (id, cname, created) = if let Some(cid) = customer_id {
        let cname: Option<String> = conn
            .query_row("SELECT name FROM customers WHERE id = ?1 AND tenant_id = ?2", params![cid, tenant_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(cname) = cname else { return Err("الزبون غير موجود".into()) };
        (cid.to_string(), cname, false)
    } else if let Some((id, cname)) = find_customer(conn, tenant_id, phone.as_deref(), email.as_deref())? {
        (id, cname, false)
    } else if create_if_missing {
        if phone.as_deref().map(str::trim).unwrap_or("").is_empty() && email.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err("لا يمكن إنشاء زبون بلا هاتف أو بريد".into());
        }
        let id = crate::repo::Repo::new(conn)
            .create_customer(tenant_id, &name, phone.as_deref().filter(|p| !p.trim().is_empty()), email.as_deref().filter(|e| !e.trim().is_empty()), None, None, None)
            .map_err(|e| e.to_string())?;
        (id, name, true)
    } else {
        return Ok(DebtorLink { customer_id: None, customer_name: None, created: false });
    };
    conn.execute("UPDATE debtors SET customer_id = ?1, last_modified = datetime('now') WHERE id = ?2", params![id, debtor_id]).map_err(|e| e.to_string())?;
    Ok(DebtorLink { customer_id: Some(id), customer_name: Some(cname), created })
}

/// Takes the link off (the debtor and the customer both stay).
pub fn unlink_debtor(conn: &Connection, tenant_id: &str, debtor_id: &str) -> Result<(), String> {
    let n = conn
        .execute("UPDATE debtors SET customer_id = NULL, last_modified = datetime('now') WHERE id = ?1 AND tenant_id = ?2", params![debtor_id, tenant_id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("المدين غير موجود".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/// One `debt_entries` row, as the allocation reads it.
#[derive(Debug, Clone)]
pub struct RawEntry {
    pub id: String,
    pub order_id: Option<String>,
    pub amount_cents: i64,
    pub is_debt: bool,
    pub created_at: String,
    pub notes: Option<String>,
}

/// One credit invoice (a credit sale, or the opening balance) and what is left of it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InvoiceLine {
    pub entry_id: String,
    pub order_id: Option<String>,
    /// The order's number on the till ("ص-12"), when there is one.
    pub order_label: Option<String>,
    pub date: String,
    pub amount_cents: i64,
    pub paid_cents: i64,
    pub remaining_cents: i64,
    /// The opening balance typed when the debtor was created (no order behind it).
    pub opening: bool,
}

/// Works out what is left of every invoice. A payment that names an order settles that order's invoice (anything it
/// cannot settle there goes general); a general payment settles the oldest open invoices first. Entries may come in
/// any order, and the same entries always give the same answer.
pub fn allocate(entries: &[RawEntry]) -> Vec<InvoiceLine> {
    let mut sorted: Vec<&RawEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    let mut lines: Vec<InvoiceLine> = sorted
        .iter()
        .filter(|e| e.is_debt)
        .map(|e| InvoiceLine {
            entry_id: e.id.clone(),
            order_id: e.order_id.clone(),
            order_label: None,
            date: e.created_at.chars().take(10).collect(),
            amount_cents: e.amount_cents,
            paid_cents: 0,
            remaining_cents: e.amount_cents,
            opening: e.order_id.is_none(),
        })
        .collect();
    let mut general = 0i64;
    for p in sorted.iter().filter(|e| !e.is_debt) {
        let mut left = p.amount_cents;
        if let Some(order) = p.order_id.as_deref() {
            for l in lines.iter_mut().filter(|l| l.order_id.as_deref() == Some(order) && l.remaining_cents > 0) {
                let take = left.min(l.remaining_cents);
                l.paid_cents += take;
                l.remaining_cents -= take;
                left -= take;
            }
        }
        general += left;
    }
    for l in lines.iter_mut() {
        if general <= 0 {
            break;
        }
        let take = general.min(l.remaining_cents);
        l.paid_cents += take;
        l.remaining_cents -= take;
        general -= take;
    }
    lines
}

pub fn load_entries(conn: &Connection, debtor_id: &str) -> Result<Vec<RawEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT id, order_id, amount_cents, type, created_at, notes FROM debt_entries WHERE debtor_id = ?1 ORDER BY created_at, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![debtor_id], |r| {
            Ok(RawEntry { id: r.get(0)?, order_id: r.get(1)?, amount_cents: r.get(2)?, is_debt: r.get::<_, String>(3)? == "DEBT", created_at: r.get(4)?, notes: r.get(5)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// A payment may name an invoice only when it is open, and never for more than is left on it.
pub fn check_settlement(entries: &[RawEntry], order_id: &str, amount_cents: i64) -> Result<(), String> {
    let lines = allocate(entries);
    let mine: Vec<&InvoiceLine> = lines.iter().filter(|l| l.order_id.as_deref() == Some(order_id)).collect();
    if mine.is_empty() {
        return Err("هذه الفاتورة ليست على هذا المدين".into());
    }
    let remaining: i64 = mine.iter().map(|l| l.remaining_cents).sum();
    if remaining <= 0 {
        return Err("هذه الفاتورة مسدّدة بالكامل".into());
    }
    if amount_cents > remaining {
        return Err(format!("المتبقي من هذه الفاتورة {remaining} فقط"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementEntry {
    pub id: String,
    /// DEBT | PAYMENT
    pub kind: String,
    pub order_id: Option<String>,
    pub order_label: Option<String>,
    pub amount_cents: i64,
    pub notes: Option<String>,
    pub created_at: String,
    /// What the debtor owed after this entry.
    pub balance_after_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebtStatement {
    pub debtor_id: String,
    pub debtor_name: String,
    pub phone: Option<String>,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub balance_cents: i64,
    pub total_debt_cents: i64,
    pub total_paid_cents: i64,
    /// Every credit invoice, oldest first, with what is left of it.
    pub invoices: Vec<InvoiceLine>,
    /// Every entry, oldest first, with the running balance.
    pub entries: Vec<StatementEntry>,
}

/// The statement of one debtor. The caller has already checked the debtor is theirs to see.
pub fn debt_statement(conn: &Connection, tenant_id: &str, debtor_id: &str) -> Result<DebtStatement, String> {
    let (name, phone, customer_id, balance, total_debt, total_paid): (String, Option<String>, Option<String>, i64, i64, i64) = conn
        .query_row(
            "SELECT name, phone, customer_id, balance_cents, total_debt_cents, total_paid_cents FROM debtors WHERE id = ?1 AND tenant_id = ?2",
            params![debtor_id, tenant_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("المدين غير موجود")?;
    let customer_name: Option<String> = match customer_id.as_deref() {
        Some(c) => conn.query_row("SELECT name FROM customers WHERE id = ?1", params![c], |r| r.get(0)).optional().map_err(|e| e.to_string())?,
        None => None,
    };
    let raw = load_entries(conn, debtor_id)?;
    let order_ids: Vec<String> = raw.iter().filter_map(|e| e.order_id.clone()).collect();
    let numbers = crate::order_history::numbers_for(conn, tenant_id, &order_ids).map_err(|e| e.to_string())?;
    let label_of = |o: &Option<String>| o.as_deref().and_then(|id| numbers.get(id)).map(|n| n.label.clone());
    let mut invoices = allocate(&raw);
    for l in invoices.iter_mut() {
        l.order_label = label_of(&l.order_id);
    }
    let mut running = 0i64;
    let entries = raw
        .iter()
        .map(|e| {
            running += if e.is_debt { e.amount_cents } else { -e.amount_cents };
            StatementEntry {
                id: e.id.clone(),
                kind: if e.is_debt { "DEBT" } else { "PAYMENT" }.to_string(),
                order_id: e.order_id.clone(),
                order_label: label_of(&e.order_id),
                amount_cents: e.amount_cents,
                notes: e.notes.clone(),
                created_at: e.created_at.clone(),
                balance_after_cents: running,
            }
        })
        .collect();
    Ok(DebtStatement { debtor_id: debtor_id.to_string(), debtor_name: name, phone, customer_id, customer_name, balance_cents: balance, total_debt_cents: total_debt, total_paid_cents: total_paid, invoices, entries })
}

/// What the customer page shows: every debtor linked to the customer, with its statement, and the total owed.
#[derive(Debug, Clone, Serialize)]
pub struct CustomerDebt {
    pub customer_id: String,
    pub balance_cents: i64,
    pub statements: Vec<DebtStatement>,
}

pub fn customer_debt(conn: &Connection, tenant_id: &str, customer_id: &str) -> Result<CustomerDebt, String> {
    let owned: Option<i64> = conn
        .query_row("SELECT 1 FROM customers WHERE id = ?1 AND tenant_id = ?2", params![customer_id, tenant_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if owned.is_none() {
        return Err("الزبون غير موجود".into());
    }
    let mut stmt = conn
        .prepare("SELECT id FROM debtors WHERE customer_id = ?1 AND tenant_id = ?2 ORDER BY name")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![customer_id, tenant_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut statements = Vec::new();
    for id in ids {
        statements.push(debt_statement(conn, tenant_id, &id)?);
    }
    let balance_cents = statements.iter().map(|s| s.balance_cents).sum();
    Ok(CustomerDebt { customer_id: customer_id.to_string(), balance_cents, statements })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, order: Option<&str>, amount: i64, debt: bool, at: &str) -> RawEntry {
        RawEntry { id: id.into(), order_id: order.map(str::to_string), amount_cents: amount, is_debt: debt, created_at: at.into(), notes: None }
    }

    #[test]
    fn phones_match_with_or_without_the_country_code() {
        assert!(same_phone("0933 123 456", "0933123456"));
        assert!(same_phone("+963933123456", "0933123456"));
        assert!(same_phone("00963-933-123-456", "933123456"));
        assert!(!same_phone("0933123456", "0944123456"));
        assert!(!same_phone("123", "123"), "too short to mean anyone");
        assert!(!same_phone("", "0933123456"));
    }

    #[test]
    fn a_payment_for_one_invoice_settles_only_that_invoice() {
        let entries = vec![
            e("d1", Some("o1"), 10_000, true, "2026-11-01T10:00:00Z"),
            e("d2", Some("o2"), 6_000, true, "2026-11-02T10:00:00Z"),
            e("p1", Some("o2"), 2_500, false, "2026-11-03T10:00:00Z"),
        ];
        let lines = allocate(&entries);
        assert_eq!((lines[0].paid_cents, lines[0].remaining_cents), (0, 10_000));
        assert_eq!((lines[1].paid_cents, lines[1].remaining_cents), (2_500, 3_500));
    }

    #[test]
    fn a_general_payment_settles_the_oldest_invoices_first_and_the_remainders_add_up_to_the_balance() {
        let entries = vec![
            e("d0", None, 4_000, true, "2026-10-20T10:00:00Z"), // opening balance
            e("d1", Some("o1"), 10_000, true, "2026-11-01T10:00:00Z"),
            e("d2", Some("o2"), 6_000, true, "2026-11-02T10:00:00Z"),
            e("p1", None, 7_000, false, "2026-11-03T10:00:00Z"),
        ];
        let lines = allocate(&entries);
        assert!(lines[0].opening && lines[0].remaining_cents == 0, "the opening balance goes first");
        assert_eq!(lines[1].remaining_cents, 7_000, "3,000 of the 7,000 left after the opening 4,000 went to the first invoice");
        assert_eq!(lines[2].remaining_cents, 6_000);
        let balance: i64 = 4_000 + 10_000 + 6_000 - 7_000;
        assert_eq!(lines.iter().map(|l| l.remaining_cents).sum::<i64>(), balance);
    }

    #[test]
    fn full_and_partial_settlement_of_one_invoice_is_checked() {
        let entries = vec![e("d1", Some("o1"), 10_000, true, "2026-11-01T10:00:00Z"), e("d2", Some("o2"), 5_000, true, "2026-11-02T10:00:00Z")];
        assert!(check_settlement(&entries, "o1", 4_000).is_ok(), "partial");
        assert!(check_settlement(&entries, "o1", 10_000).is_ok(), "full");
        assert!(check_settlement(&entries, "o1", 10_001).unwrap_err().contains("10000"), "never more than is left");
        assert!(check_settlement(&entries, "nope", 1).is_err(), "not this debtor's invoice");
        let after = vec![entries[0].clone(), entries[1].clone(), e("p1", Some("o1"), 10_000, false, "2026-11-03T10:00:00Z")];
        assert!(check_settlement(&after, "o1", 1).unwrap_err().contains("مسدّدة"));
        // A general payment that already covered the invoice leaves nothing to settle on it either.
        let general = vec![entries[0].clone(), e("p1", None, 10_000, false, "2026-11-03T10:00:00Z")];
        assert!(check_settlement(&general, "o1", 1).is_err());
    }

    #[test]
    fn a_refund_of_a_credit_order_settles_its_own_invoice() {
        // Refunds are PAYMENT entries carrying the order id.
        let entries = vec![e("d1", Some("o1"), 8_000, true, "2026-11-01T10:00:00Z"), e("r1", Some("o1"), 3_000, false, "2026-11-01T12:00:00Z")];
        assert_eq!(allocate(&entries)[0].remaining_cents, 5_000);
    }

    #[test]
    fn allocation_does_not_depend_on_the_order_entries_arrive_in() {
        let mut entries = vec![
            e("d1", Some("o1"), 10_000, true, "2026-11-01T10:00:00Z"),
            e("d2", Some("o2"), 6_000, true, "2026-11-02T10:00:00Z"),
            e("p1", None, 12_000, false, "2026-11-03T10:00:00Z"),
        ];
        let a = allocate(&entries);
        entries.reverse();
        assert_eq!(a, allocate(&entries));
        assert_eq!(a.iter().map(|l| l.remaining_cents).collect::<Vec<_>>(), vec![0, 4_000]);
    }
}
