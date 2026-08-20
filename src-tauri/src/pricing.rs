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

/// 2026-08-02: replaces two hardcoded constants
/// (`VOID_MANAGER_OVERRIDE_THRESHOLD_CENTS` in commands_v3.rs, and a
/// client-only `DIFF_THRESHOLD_CENTS` in shift/page.tsx) that were both
/// picked assuming small everyday prices -- wrong by orders of magnitude
/// for a currency whose real menu prices run in the thousands. Now a real,
/// Owner-configurable `chain_config` value, same shape as `DiscountCaps`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ManagerThresholds {
    /// A void of a line at or above this amount requires a manager PIN.
    pub void_threshold_cents: i64,
    /// A shift-close cash discrepancy at or above this magnitude (either
    /// direction) requires a manager PIN.
    pub shift_diff_threshold_cents: i64,
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

/// Server-side port of `src/lib/taxCalculator.ts::calculateTax` -- see
/// `_platform_plan_reconciliation.md` §3.3: previously the Rust command
/// layer only checked `subtotal_cents`/`tax_cents` for non-negativity and
/// trusted whatever the frontend sent, with tax computed exclusively in
/// TypeScript. This is the authoritative recomputation that closes that
/// trust boundary -- callers must reach the exact same numbers a caller
/// following the rules would, and a hostile/modified client can no longer
/// dictate its own tax or total. Semantics, rounding, and the "discount
/// before tax" order of operations are ported line-for-line from the
/// TypeScript so both layers agree on every order created before this
/// existed (any that still round-trip through the old command params).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxMode {
    Inclusive,
    Exclusive,
}

impl TaxMode {
    /// `chain_config.tax_mode` is a free-text column ("inclusive"/
    /// "exclusive"); anything else defaults to Exclusive, matching
    /// `taxCalculator.ts::getDefaultTaxConfig`'s own fallback default.
    pub fn from_str(s: &str) -> Self {
        if s == "inclusive" { TaxMode::Inclusive } else { TaxMode::Exclusive }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TaxConfig {
    pub mode: TaxMode,
    pub tax_rate_cents: i64,
    pub secondary_tax_rate_cents: i64,
    pub service_charge_rate_cents: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaxBreakdown {
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub secondary_tax_cents: i64,
    pub service_charge_cents: i64,
    pub total_cents: i64,
}

impl TaxBreakdown {
    /// The single combined figure the `orders` table actually has a column
    /// for (`tax_cents`) -- `create_full_order_v3`'s frontend caller has
    /// always folded these three into one number before sending it
    /// (`orderService.ts::createOrder`: `taxCents + secondaryTaxCents +
    /// serviceChargeCents`); this is that same fold, done server-side.
    pub fn combined_tax_cents(&self) -> i64 {
        self.tax_cents + self.secondary_tax_cents + self.service_charge_cents
    }
}

/// Round-half-up for non-negative integers, matching JS `Math.round`'s
/// behavior for the always-non-negative amounts this module deals in
/// (`Math.round(n / d)` == `floor((2n + d) / (2d))`). Plain integer
/// division truncates toward zero, which is wrong at the .5 boundary --
/// this crate's rust-version (1.77.2, see `check_discount_cap`'s own
/// comment) doesn't have `div_ceil` stabilized in a form usable here
/// either, so this is a small hand-rolled equivalent, not a missing-API
/// workaround copy-pasted from elsewhere.
fn round_div(numerator: i64, denominator: i64) -> i64 {
    debug_assert!(denominator > 0);
    (2 * numerator + denominator) / (2 * denominator)
}

/// Line-for-line port of `taxCalculator.ts::calculateTax`. `item_total_cents`
/// is the raw, pre-discount sum of `(unit_price_cents + modifiers) *
/// quantity` across an order's items -- callers must NOT pre-subtract the
/// discount themselves; this function applies it internally, exactly once,
/// against the taxable base (discount changes what tax is owed on, taxing
/// the pre-discount total would overcharge tax on money the customer never
/// paid -- same comment as the TS test file).
pub fn calculate_tax(item_total_cents: i64, discount_cents: i64, config: &TaxConfig) -> TaxBreakdown {
    let effective_total = std::cmp::max(0, item_total_cents - discount_cents);

    match config.mode {
        TaxMode::Inclusive => {
            let divisor = 10_000 + config.tax_rate_cents;
            let tax_cents = if config.tax_rate_cents > 0 {
                round_div(effective_total * config.tax_rate_cents, divisor)
            } else {
                0
            };
            let subtotal_cents = effective_total - tax_cents;

            let secondary_tax_cents = if config.secondary_tax_rate_cents > 0 {
                round_div(subtotal_cents * config.secondary_tax_rate_cents, 10_000)
            } else {
                0
            };
            let service_charge_cents = if config.service_charge_rate_cents > 0 {
                round_div(subtotal_cents * config.service_charge_rate_cents, 10_000)
            } else {
                0
            };

            let total_cents = subtotal_cents + tax_cents + secondary_tax_cents + service_charge_cents;
            TaxBreakdown { subtotal_cents, tax_cents, secondary_tax_cents, service_charge_cents, total_cents }
        }
        TaxMode::Exclusive => {
            let subtotal_cents = effective_total;
            let tax_cents = if config.tax_rate_cents > 0 {
                round_div(effective_total * config.tax_rate_cents, 10_000)
            } else {
                0
            };
            let secondary_tax_cents = if config.secondary_tax_rate_cents > 0 {
                round_div(effective_total * config.secondary_tax_rate_cents, 10_000)
            } else {
                0
            };
            let service_charge_cents = if config.service_charge_rate_cents > 0 {
                round_div(effective_total * config.service_charge_rate_cents, 10_000)
            } else {
                0
            };

            let total_cents = subtotal_cents + tax_cents + secondary_tax_cents + service_charge_cents;
            TaxBreakdown { subtotal_cents, tax_cents, secondary_tax_cents, service_charge_cents, total_cents }
        }
    }
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

    // Ported 1:1 from taxCalculator.test.ts -- same fixtures, same expected
    // numbers, proving the Rust engine agrees with the frontend's own
    // reference implementation rather than just being internally consistent.
    fn exclusive_1500() -> TaxConfig {
        TaxConfig { mode: TaxMode::Exclusive, tax_rate_cents: 1500, secondary_tax_rate_cents: 0, service_charge_rate_cents: 0 }
    }
    fn inclusive_1500() -> TaxConfig {
        TaxConfig { mode: TaxMode::Inclusive, tax_rate_cents: 1500, secondary_tax_rate_cents: 0, service_charge_rate_cents: 0 }
    }

    #[test]
    fn exclusive_mode_adds_tax_on_top_of_the_item_total() {
        let r = calculate_tax(10_000, 0, &exclusive_1500());
        assert_eq!(r.subtotal_cents, 10_000);
        assert_eq!(r.tax_cents, 1_500);
        assert_eq!(r.total_cents, 11_500);
    }

    #[test]
    fn inclusive_mode_backs_the_tax_out_of_the_item_total_instead_of_adding_it() {
        let r = calculate_tax(11_500, 0, &inclusive_1500());
        assert_eq!(r.subtotal_cents, 10_000);
        assert_eq!(r.tax_cents, 1_500);
        assert_eq!(r.total_cents, 11_500);
    }

    #[test]
    fn applies_the_discount_before_computing_tax_not_after() {
        let r = calculate_tax(10_000, 2_000, &exclusive_1500());
        assert_eq!(r.subtotal_cents, 8_000);
        assert_eq!(r.tax_cents, 1_200);
        assert_eq!(r.total_cents, 9_200);
    }

    #[test]
    fn clamps_a_discount_larger_than_the_item_total_to_zero_instead_of_going_negative() {
        let r = calculate_tax(5_000, 9_000, &exclusive_1500());
        assert_eq!(r.subtotal_cents, 0);
        assert_eq!(r.tax_cents, 0);
        assert_eq!(r.total_cents, 0);
    }

    #[test]
    fn stacks_secondary_tax_and_service_charge_on_the_exclusive_subtotal() {
        let config = TaxConfig { mode: TaxMode::Exclusive, tax_rate_cents: 1000, secondary_tax_rate_cents: 500, service_charge_rate_cents: 1000 };
        let r = calculate_tax(10_000, 0, &config);
        assert_eq!(r.tax_cents, 1_000);
        assert_eq!(r.secondary_tax_cents, 500);
        assert_eq!(r.service_charge_cents, 1_000);
        assert_eq!(r.total_cents, 12_500);
        assert_eq!(r.combined_tax_cents(), 2_500);
    }

    #[test]
    fn charges_zero_tax_when_the_rate_is_zero() {
        let config = TaxConfig { mode: TaxMode::Exclusive, tax_rate_cents: 0, secondary_tax_rate_cents: 0, service_charge_rate_cents: 0 };
        let r = calculate_tax(10_000, 0, &config);
        assert_eq!(r.tax_cents, 0);
        assert_eq!(r.total_cents, 10_000);
    }

    #[test]
    fn round_div_matches_js_math_round_at_the_half_cent_boundary() {
        // 15% of 10 = 1.5 -- Math.round(1.5) === 2, not banker's-rounds-to-2-anyway;
        // pick a case where round-to-even and round-half-up actually disagree:
        // 5% of 50 = 2.5 -> Math.round(2.5) === 3.
        let config = TaxConfig { mode: TaxMode::Exclusive, tax_rate_cents: 500, secondary_tax_rate_cents: 0, service_charge_rate_cents: 0 };
        let r = calculate_tax(50, 0, &config);
        assert_eq!(r.tax_cents, 3);
    }
}
