//! Restaurant operations: item options ("without onion", "extra cheese"),
//! comps ("on the house") and order-line edits. Delivery lives in
//! `delivery.rs`. Plain functions over a `Connection` so the command layer
//! and the tests use the exact same code. Tables: Migration AE.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::repo::{OrderItemInput, OrderModifierInput};

// ---------------------------------------------------------------------------
// Item options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct OptionChoice {
    pub id: String,
    pub name: String,
    pub price_cents: i64,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OptionTarget {
    /// 'ITEM' or 'CATEGORY'
    pub target_type: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionGroup {
    pub id: String,
    pub name: String,
    /// 'MULTI' (tick any) or 'SINGLE' (pick one)
    pub selection: String,
    pub required: bool,
    pub sort_order: i64,
    pub is_active: bool,
    pub choices: Vec<OptionChoice>,
    pub targets: Vec<OptionTarget>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OptionChoiceInput {
    pub name: String,
    pub price_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OptionGroupInput {
    pub id: Option<String>,
    pub name: String,
    pub selection: String,
    pub required: bool,
    pub sort_order: i64,
    pub is_active: bool,
    pub choices: Vec<OptionChoiceInput>,
    pub targets: Vec<OptionTarget>,
}

const MAX_NAME_CHARS: usize = 80;

/// Every option group of the tenant with its choices and targets. The POS
/// loads this once with `only_active = true`; the menu screen uses `false`.
pub fn list_option_groups(conn: &Connection, tenant_id: &str, only_active: bool) -> Result<Vec<OptionGroup>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, selection, required, sort_order, is_active FROM option_groups \
             WHERE tenant_id = ?1 AND (?2 = 0 OR is_active = 1) ORDER BY sort_order, name",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, i64, i64, i64)> = stmt
        .query_map(params![tenant_id, only_active as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut choice_stmt = conn
        .prepare(
            "SELECT id, name, price_cents, sort_order FROM option_choices \
             WHERE group_id = ?1 AND (?2 = 0 OR is_active = 1) ORDER BY sort_order, name",
        )
        .map_err(|e| e.to_string())?;
    let mut target_stmt = conn
        .prepare("SELECT target_type, target_id FROM option_group_targets WHERE group_id = ?1 ORDER BY target_type, target_id")
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(rows.len());
    for (id, name, selection, required, sort_order, is_active) in rows {
        let choices: Vec<OptionChoice> = choice_stmt
            .query_map(params![id, only_active as i64], |r| {
                Ok(OptionChoice { id: r.get(0)?, name: r.get(1)?, price_cents: r.get(2)?, sort_order: r.get(3)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let targets: Vec<OptionTarget> = target_stmt
            .query_map(params![id], |r| Ok(OptionTarget { target_type: r.get(0)?, target_id: r.get(1)? }))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        out.push(OptionGroup { id, name, selection, required: required != 0, sort_order, is_active: is_active != 0, choices, targets });
    }
    Ok(out)
}

/// Creates or fully replaces a group (its choices and targets are rewritten
/// together). Orders already taken keep the option names/prices they were
/// sold with -- they never point back at a choice row.
pub fn save_option_group(conn: &Connection, tenant_id: &str, input: &OptionGroupInput) -> Result<String, String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err("اسم المجموعة مطلوب".to_string());
    }
    if !matches!(input.selection.as_str(), "MULTI" | "SINGLE") {
        return Err("selection must be MULTI or SINGLE".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for c in &input.choices {
        let n = c.name.trim();
        if n.is_empty() || n.chars().count() > MAX_NAME_CHARS {
            return Err("اسم الخيار مطلوب".to_string());
        }
        if c.price_cents < 0 {
            return Err("سعر الخيار لا يمكن أن يكون سالباً".to_string());
        }
        if !seen.insert(n.to_string()) {
            return Err(format!("الخيار \"{n}\" مكرر في نفس المجموعة"));
        }
    }
    for t in &input.targets {
        if !matches!(t.target_type.as_str(), "ITEM" | "CATEGORY") {
            return Err("target_type must be ITEM or CATEGORY".to_string());
        }
    }

    let id = match &input.id {
        Some(id) => {
            let owned: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM option_groups WHERE id = ?1 AND tenant_id = ?2", params![id, tenant_id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if !owned {
                return Err("option group not found".to_string());
            }
            conn.execute(
                "UPDATE option_groups SET name = ?1, selection = ?2, required = ?3, sort_order = ?4, is_active = ?5 WHERE id = ?6",
                params![name, input.selection, input.required as i64, input.sort_order, input.is_active as i64, id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM option_choices WHERE group_id = ?1", params![id]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM option_group_targets WHERE group_id = ?1", params![id]).map_err(|e| e.to_string())?;
            id.clone()
        }
        None => {
            let id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO option_groups (id, tenant_id, name, selection, required, sort_order, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, tenant_id, name, input.selection, input.required as i64, input.sort_order, input.is_active as i64],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };

    for (i, c) in input.choices.iter().enumerate() {
        conn.execute(
            "INSERT INTO option_choices (id, group_id, name, price_cents, sort_order, is_active) VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            params![uuid::Uuid::now_v7().to_string(), id, c.name.trim(), c.price_cents, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    for t in &input.targets {
        conn.execute(
            "INSERT OR IGNORE INTO option_group_targets (group_id, target_type, target_id) VALUES (?1, ?2, ?3)",
            params![id, t.target_type, t.target_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

pub fn delete_option_group(conn: &Connection, tenant_id: &str, group_id: &str) -> Result<(), String> {
    let owned: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM option_groups WHERE id = ?1 AND tenant_id = ?2", params![group_id, tenant_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !owned {
        return Err("option group not found".to_string());
    }
    conn.execute("DELETE FROM option_choices WHERE group_id = ?1", params![group_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM option_group_targets WHERE group_id = ?1", params![group_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM option_groups WHERE id = ?1", params![group_id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// The server is the authority on what an option costs. A modifier the
/// client sends is matched by name against the active choices that apply to
/// this menu item (directly or through its category): a match is charged the
/// catalogue price, anything else is a free-text note and costs nothing. A
/// tampered client can therefore neither discount an order with a negative
/// modifier nor invent a price.
///
/// Modifiers already stored on an order (`locked`) keep the price they were
/// sold at -- re-pricing an open tab must not change it because the owner
/// edited the menu in the meantime.
pub fn price_modifiers(
    conn: &Connection,
    tenant_id: &str,
    menu_item_id: &str,
    modifiers: &[OrderModifierInput],
) -> Result<Vec<OrderModifierInput>, String> {
    if modifiers.is_empty() {
        return Ok(Vec::new());
    }
    let category_id: Option<String> = conn
        .query_row("SELECT category_id FROM menu_items WHERE id = ?1", params![menu_item_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let mut stmt = conn
        .prepare(
            "SELECT c.price_cents FROM option_choices c \
             JOIN option_groups g ON g.id = c.group_id \
             JOIN option_group_targets t ON t.group_id = g.id \
             WHERE g.tenant_id = ?1 AND g.is_active = 1 AND c.is_active = 1 AND c.name = ?2 \
               AND ((t.target_type = 'ITEM' AND t.target_id = ?3) OR (t.target_type = 'CATEGORY' AND t.target_id = ?4)) \
             ORDER BY g.sort_order, c.sort_order LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(modifiers.len());
    for m in modifiers {
        let name = m.name.trim();
        if name.is_empty() {
            continue;
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err("اسم الخيار طويل جداً".to_string());
        }
        if m.locked {
            out.push(OrderModifierInput { name: name.to_string(), price_cents: m.price_cents.max(0), locked: true });
            continue;
        }
        let price: i64 = stmt
            .query_row(params![tenant_id, name, menu_item_id, category_id.clone().unwrap_or_default()], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        out.push(OrderModifierInput { name: name.to_string(), price_cents: price, locked: false });
    }
    Ok(out)
}

/// Records who gave a gift: `comp_by` is always the logged-in user, never a
/// value the client sent. Called on every path that creates order lines.
pub fn stamp_comps(items: &mut [OrderItemInput], actor_id: &str) {
    for item in items.iter_mut() {
        item.comp_by = if item.comped { Some(actor_id.to_string()) } else { None };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE menu_items (id TEXT PRIMARY KEY, category_id TEXT);
             CREATE TABLE option_groups (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, selection TEXT NOT NULL DEFAULT 'MULTI' CHECK (selection IN ('MULTI','SINGLE')), required INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE option_choices (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0), sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE option_group_targets (group_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (group_id, target_type, target_id));
             INSERT INTO menu_items VALUES ('sandwich', 'cat-sandwich'), ('cola', 'cat-drinks');",
        )
        .unwrap();
        c
    }

    fn group(name: &str, choices: &[(&str, i64)], targets: &[(&str, &str)]) -> OptionGroupInput {
        OptionGroupInput {
            id: None,
            name: name.to_string(),
            selection: "MULTI".to_string(),
            required: false,
            sort_order: 0,
            is_active: true,
            choices: choices.iter().map(|(n, p)| OptionChoiceInput { name: n.to_string(), price_cents: *p }).collect(),
            targets: targets.iter().map(|(t, i)| OptionTarget { target_type: t.to_string(), target_id: i.to_string() }).collect(),
        }
    }

    fn m(name: &str, price: i64) -> OrderModifierInput {
        OrderModifierInput { name: name.to_string(), price_cents: price, locked: false }
    }

    #[test]
    fn group_roundtrip_and_replace() {
        let c = conn();
        let id = save_option_group(&c, "t1", &group("إضافات", &[("بدون بصل", 0), ("زيادة جبنة", 2000)], &[("CATEGORY", "cat-sandwich")])).unwrap();
        let groups = list_option_groups(&c, "t1", false).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].choices.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["بدون بصل", "زيادة جبنة"]);
        assert_eq!(groups[0].targets.len(), 1);

        let mut edit = group("إضافات", &[("بدون كاتشب", 0)], &[("ITEM", "sandwich")]);
        edit.id = Some(id);
        save_option_group(&c, "t1", &edit).unwrap();
        let groups = list_option_groups(&c, "t1", false).unwrap();
        assert_eq!(groups.len(), 1, "editing must not duplicate the group");
        assert_eq!(groups[0].choices.len(), 1);
        assert_eq!(groups[0].targets[0].target_type, "ITEM");
    }

    #[test]
    fn other_tenants_cannot_touch_or_see_a_group() {
        let c = conn();
        let id = save_option_group(&c, "t1", &group("g", &[("a", 0)], &[])).unwrap();
        assert!(list_option_groups(&c, "t2", false).unwrap().is_empty());
        let mut edit = group("hijack", &[("a", 0)], &[]);
        edit.id = Some(id.clone());
        assert!(save_option_group(&c, "t2", &edit).is_err());
        assert!(delete_option_group(&c, "t2", &id).is_err());
        assert_eq!(list_option_groups(&c, "t1", false).unwrap().len(), 1);
    }

    #[test]
    fn validation_rejects_bad_input() {
        let c = conn();
        assert!(save_option_group(&c, "t1", &group("  ", &[("a", 0)], &[])).is_err());
        assert!(save_option_group(&c, "t1", &group("g", &[("a", -5)], &[])).is_err());
        assert!(save_option_group(&c, "t1", &group("g", &[("a", 0), ("a", 100)], &[])).is_err(), "duplicate names in one group");
        assert!(save_option_group(&c, "t1", &group("g", &[("", 0)], &[])).is_err());
        let mut bad = group("g", &[("a", 0)], &[]);
        bad.selection = "ANY".to_string();
        assert!(save_option_group(&c, "t1", &bad).is_err());
    }

    #[test]
    fn inactive_groups_hidden_from_the_pos_list() {
        let c = conn();
        let mut g = group("g", &[("a", 0)], &[]);
        g.is_active = false;
        save_option_group(&c, "t1", &g).unwrap();
        assert!(list_option_groups(&c, "t1", true).unwrap().is_empty());
        assert_eq!(list_option_groups(&c, "t1", false).unwrap().len(), 1);
    }

    #[test]
    fn modifier_price_comes_from_the_catalogue_not_the_client() {
        let c = conn();
        save_option_group(&c, "t1", &group("g", &[("بدون بصل", 0), ("زيادة جبنة", 2000)], &[("CATEGORY", "cat-sandwich")])).unwrap();
        // The client lies: cheese for 1, and a -5000 "discount" note.
        let priced = price_modifiers(&c, "t1", "sandwich", &[m("زيادة جبنة", 1), m("خصم خاص", -5000), m("بدون بصل", 999)]).unwrap();
        assert_eq!(priced[0].price_cents, 2000, "catalogue price wins");
        assert_eq!(priced[1].price_cents, 0, "unknown option is a free note, never a negative");
        assert_eq!(priced[2].price_cents, 0, "a free choice stays free");
    }

    #[test]
    fn options_only_apply_to_their_own_items_and_categories() {
        let c = conn();
        save_option_group(&c, "t1", &group("g", &[("زيادة جبنة", 2000)], &[("CATEGORY", "cat-sandwich")])).unwrap();
        let on_cola = price_modifiers(&c, "t1", "cola", &[m("زيادة جبنة", 2000)]).unwrap();
        assert_eq!(on_cola[0].price_cents, 0, "cheese is not an option for a cola");
        save_option_group(&c, "t1", &group("g2", &[("ثلج", 500)], &[("ITEM", "cola")])).unwrap();
        assert_eq!(price_modifiers(&c, "t1", "cola", &[m("ثلج", 0)]).unwrap()[0].price_cents, 500);
        assert_eq!(price_modifiers(&c, "t1", "sandwich", &[m("ثلج", 0)]).unwrap()[0].price_cents, 0);
    }

    #[test]
    fn stored_modifier_keeps_its_sold_price_after_the_menu_changes() {
        let c = conn();
        // The cheese option was deleted after the order was taken.
        let locked = OrderModifierInput { name: "زيادة جبنة".to_string(), price_cents: 2000, locked: true };
        let priced = price_modifiers(&c, "t1", "sandwich", &[locked]).unwrap();
        assert_eq!(priced[0].price_cents, 2000);
        let negative = OrderModifierInput { name: "x".to_string(), price_cents: -1, locked: true };
        assert_eq!(price_modifiers(&c, "t1", "sandwich", &[negative]).unwrap()[0].price_cents, 0);
    }

    #[test]
    fn deleted_and_deactivated_choices_stop_being_priced() {
        let c = conn();
        let id = save_option_group(&c, "t1", &group("g", &[("زيادة جبنة", 2000)], &[("CATEGORY", "cat-sandwich")])).unwrap();
        delete_option_group(&c, "t1", &id).unwrap();
        assert_eq!(price_modifiers(&c, "t1", "sandwich", &[m("زيادة جبنة", 2000)]).unwrap()[0].price_cents, 0);
        assert!(list_option_groups(&c, "t1", false).unwrap().is_empty());
    }

    #[test]
    fn blank_and_overlong_modifier_names() {
        let c = conn();
        assert!(price_modifiers(&c, "t1", "sandwich", &[m("   ", 0)]).unwrap().is_empty());
        assert!(price_modifiers(&c, "t1", "sandwich", &[m(&"x".repeat(200), 0)]).is_err());
    }
}
