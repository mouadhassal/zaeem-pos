//! Discount cap enforcement -- the last T1.9 gap. `create_order_v3` and
//! `create_full_order_v3` accepted any `discount_cents` a caller sent, with
//! no server-side ceiling: a cashier (or any renderer invoking the command
//! directly, T1.9's whole threat model) could apply a 100% discount and
//! walk out with the till. This module is the enforcement; the commands
//! that call it own the audit write (see commands_v3.rs's
//! `create_order_v3`/`create_full_order_v3`).
//!
//! Note on placement: AGENTS.md/the task both said `core::pricing`, but
//! there is no `core/` directory anywhere in this codebase -- it's
//! aspirational structure from `ARCHITECTURE_V2.md`, which does not exist
//! in the repo either (searched). Every other module (`money.rs`,
//! `security.rs`, `audit.rs`) is a flat sibling of `lib.rs`, so this one is
//! too, for consistency with what's actually here rather than a doc that
//! isn't.

use crate::security::Role;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct DiscountCaps {
    pub cashier_percent: i64,
    pub manager_percent: i64,
    pub owner_percent: i64,
}

impl DiscountCaps {
    /// The cap that applies to a given role. Kitchen/Server have no
    /// discount permission at all (see `security::Permission` -- they can't
    /// reach `create_order_v3`'s discount path in the first place), so they
    /// fall through to the cashier cap as a conservative default rather
    /// than panicking on an unmatched role.
    pub fn for_role(&self, role: Role) -> i64 {
        match role {
            Role::Owner | Role::Platform => self.owner_percent,
            Role::Manager => self.manager_percent,
            Role::Cashier | Role::Kitchen | Role::Server => self.cashier_percent,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct DiscountOverCap {
    /// Ceiling percent, rounded up to a whole percent, so the error reads
    /// naturally ("you asked for 37%, the cap is 10%") even though the
    /// underlying comparison is done in cents to avoid rounding artifacts.
    pub requested_percent: i64,
    pub cap_percent: i64,
}

impl std::fmt::Display for DiscountOverCap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "discount of {}% exceeds your cap of {}% -- ask a manager for an override", self.requested_percent, self.cap_percent)
    }
}

/// Whether `discount_cents` against `subtotal_cents` is within `cap_percent`.
/// Compared as `discount * 100 <= subtotal * cap` (cross-multiplied
/// integers) rather than computing a percentage first, so there's no
/// float and no rounding direction to get subtly wrong at the boundary --
/// exactly cap-percent discounts always pass, never fail-by-one-cent.
pub fn check_discount_cap(subtotal_cents: i64, discount_cents: i64, cap_percent: i64) -> Result<(), DiscountOverCap> {
    if discount_cents <= 0 {
        return Ok(());
    }
    if subtotal_cents <= 0 {
        // Any positive discount against a zero/negative subtotal is
        // unconditionally over any real cap -- there's nothing to discount.
        return Err(DiscountOverCap { requested_percent: 100, cap_percent });
    }
    if discount_cents.saturating_mul(100) > subtotal_cents.saturating_mul(cap_percent) {
        // Manual ceiling division (`(a + b - 1) / b`) -- `i64::div_ceil` is
        // still unstable on this crate's pinned rust-version (1.77.2).
        let numerator = discount_cents * 100;
        let requested_percent = (numerator + subtotal_cents - 1) / subtotal_cents;
        return Err(DiscountOverCap { requested_percent, cap_percent });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> DiscountCaps {
        DiscountCaps { cashier_percent: 10, manager_percent: 50, owner_percent: 100 }
    }

    #[test]
    fn each_role_maps_to_its_configured_cap() {
        let c = caps();
        assert_eq!(c.for_role(Role::Cashier), 10);
        assert_eq!(c.for_role(Role::Manager), 50);
        assert_eq!(c.for_role(Role::Owner), 100);
        assert_eq!(c.for_role(Role::Platform), 100);
    }

    #[test]
    fn at_or_under_cap_is_allowed() {
        // Exactly 10% of a 10,000-cent subtotal.
        assert!(check_discount_cap(10_000, 1_000, 10).is_ok());
        assert!(check_discount_cap(10_000, 999, 10).is_ok());
        assert!(check_discount_cap(10_000, 0, 10).is_ok());
    }

    #[test]
    fn one_cent_over_cap_is_rejected() {
        let result = check_discount_cap(10_000, 1_001, 10);
        assert_eq!(result, Err(DiscountOverCap { requested_percent: 11, cap_percent: 10 }));
    }

    #[test]
    fn hundred_percent_discount_rejected_for_cashier_cap() {
        let result = check_discount_cap(10_000, 10_000, 10);
        assert_eq!(result, Err(DiscountOverCap { requested_percent: 100, cap_percent: 10 }));
    }

    #[test]
    fn hundred_percent_discount_allowed_for_owner_cap() {
        assert!(check_discount_cap(10_000, 10_000, 100).is_ok());
    }

    #[test]
    fn zero_subtotal_with_positive_discount_is_rejected() {
        let result = check_discount_cap(0, 500, 50);
        assert!(result.is_err());
    }
}
