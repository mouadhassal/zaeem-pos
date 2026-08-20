//! Order status transition validation -- ZAEEM_POS_PLATFORM_PLAN.md §3.2,
//! reconciled against reality in `_platform_plan_reconciliation.md`'s "§3.2
//! Order lifecycle" section: this codebase's real status mechanism
//! (`order_status_event` + `order_current`, see `repo.rs::replay_order_status`
//! / `append_order_status_event`) is event-sourced and audit-logged, but had
//! NO transition validation at all -- `update_order_status_v3_impl` would
//! append any string a caller with `Permission::UpdateOrderStatus` sent, with
//! no check that it's a legal successor of the current status. This module
//! is that check, added for the first time (not a refactor of an existing
//! if/else chain -- there isn't one).
//!
//! Scope, stated plainly: this is a hardcoded graph for the one vertical
//! this app currently serves (restaurant/KDS), not the plan's generic
//! pack-declared-graph engine (§3.2's TOML-driven `[[transition]]` model) --
//! that's real future kernel/pack work, correctly gated behind a later
//! phase by the plan itself. Same "don't build the unused abstraction yet"
//! call already made for `item_kind`'s 3-of-8 kind scoping (v23 migration).
//!
//! The graph below is not guessed from the plan's restaurant lifecycle
//! example (`open -> sent-to-kitchen -> preparing -> ready -> served ->
//! paid -> closed`) -- it's reverse-engineered from the actual, sole real
//! caller of `update_order_status_v3` today: `src/app/kds/page.tsx`'s
//! `STATUS_FLOW` map (`PENDING -> PREPARING -> READY -> SERVED`). Every
//! other status this schema knows about is reached through a DIFFERENT,
//! separate write path that does NOT go through this command or this
//! guard:
//! - `PAID` is written directly by `Repo::take_payment` (`repo.rs`, calls
//!   `append_order_status_event` itself, bypassing this command entirely).
//! - `CANCELLED` is written via direct `UPDATE orders SET status =
//!   'CANCELLED' ...` in `repo.rs` (table-merge/split-bill parent-order
//!   cancellation) -- bypasses `order_status_event` entirely, a pre-existing
//!   duality this module does not attempt to fix.
//! - `DRAFT` (held orders) and `SCHEDULED` (delayed orders) are initial
//!   statuses set by direct `INSERT`/`UPDATE` in `repo.rs`
//!   (`hold_order`/`activate_delayed_orders`), never through
//!   `append_order_status_event`, and are never shown in the KDS UI
//!   (`list_kitchen_orders` filters `status IN ('PENDING','PREPARING',
//!   'READY')`), so they never reach this guard in practice.
//!
//! Because none of those are reachable through `update_order_status_v3`
//! today, they are deliberately NOT edges in this graph. If a future
//! caller needs e.g. "cancel from KDS," that's a real product decision to
//! make explicitly, not something to smuggle in as a permissive default.
//!
//! Same-status transitions (A -> A) ARE allowed as a no-op: the KDS UI's
//! own "إعادة" (revert-to-preparing) button at READY has a pre-existing
//! parameter-passing bug (`handleStatusChange(order.id, "PREPARING")` looks
//! up `STATUS_FLOW["PREPARING"]` = `"READY"`, so it resends READY instead
//! of actually reverting to PREPARING as its label implies) -- flagged as a
//! real frontend bug worth fixing separately, out of scope here. Allowing
//! A -> A as a no-op means that existing button keeps working (functions
//! as a silent refresh instead of erroring) rather than this validation
//! pass turning a pre-existing UI bug into a hard error for kitchen staff
//! mid-service.

/// Returns `Ok(())` if `new_status` is a legal transition from
/// `current_status`, else an `Err` with an Arabic message safe to surface
/// directly to KDS staff (matches this codebase's existing
/// user-facing-error convention, e.g. `commands_v3.rs`'s shift-open check).
pub fn validate_order_status_transition(current_status: &str, new_status: &str) -> Result<(), String> {
    if current_status == new_status {
        return Ok(());
    }

    let legal = matches!(
        (current_status, new_status),
        ("PENDING", "PREPARING") | ("PREPARING", "READY") | ("READY", "SERVED")
    );

    if legal {
        Ok(())
    } else {
        Err(format!(
            "لا يمكن تغيير حالة الطلب من {current_status} إلى {new_status} -- هذا الانتقال غير مسموح"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_full_kds_happy_path_in_sequence() {
        assert!(validate_order_status_transition("PENDING", "PREPARING").is_ok());
        assert!(validate_order_status_transition("PREPARING", "READY").is_ok());
        assert!(validate_order_status_transition("READY", "SERVED").is_ok());
    }

    #[test]
    fn allows_same_status_as_a_no_op() {
        assert!(validate_order_status_transition("READY", "READY").is_ok());
        assert!(validate_order_status_transition("PENDING", "PENDING").is_ok());
    }

    #[test]
    fn rejects_skipping_a_stage() {
        let err = validate_order_status_transition("PENDING", "READY").unwrap_err();
        assert!(err.contains("PENDING") && err.contains("READY"));
    }

    #[test]
    fn rejects_moving_backward() {
        assert!(validate_order_status_transition("SERVED", "PREPARING").is_err());
        assert!(validate_order_status_transition("READY", "PENDING").is_err());
    }

    #[test]
    fn rejects_a_status_this_command_never_legitimately_reaches() {
        // PAID/CANCELLED are real statuses in this schema, but reached
        // through entirely different write paths (take_payment,
        // direct-SQL cancellation) -- not through this command/guard.
        assert!(validate_order_status_transition("SERVED", "PAID").is_err());
        assert!(validate_order_status_transition("PENDING", "CANCELLED").is_err());
    }

    #[test]
    fn rejects_a_fabricated_status_string() {
        assert!(validate_order_status_transition("PENDING", "not-a-real-status").is_err());
    }
}
