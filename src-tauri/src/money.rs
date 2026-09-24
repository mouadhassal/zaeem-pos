//! MoneyPolicy — the single source of truth for currency minor-unit scale.
//!
//! Per SCHEMA_V3.md §5 (blocker #1, 2026-07-16): `scale` must never be a literal
//! hardcoded inline wherever a Money value is written. Every writer -- the T1.1
//! migration backfill and every future Rust command -- calls `scale_for` instead.

/// Returns the number of minor units per major unit for a given ISO 4217-ish
/// currency code. SYP and IQD are pinned to 0 (not the ISO default) because in
/// current practice, post/near-hyperinflation, sub-unit denominations carry no
/// usable value and the product never charges or displays them -- this mirrors
/// ARCHITECTURE_V2.md §4's own worked example ("SYP: 0, USD: 2").
pub fn scale_for(currency: &str) -> u8 {
    match currency {
        "SYP" | "IQD" => 0,
        "KWD" | "BHD" | "OMR" | "JOD" => 3,
        // SAR, USD, AED, QAR, EGP, LBP, SDG, and anything unrecognized: ISO 4217 default.
        _ => 2,
    }
}

/// Converts a whole major-unit amount into `currency`'s minor units.
pub fn major_to_minor(major: i64, currency: &str) -> i64 {
    major.saturating_mul(10_i64.pow(scale_for(currency) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn major_to_minor_follows_scale() {
        assert_eq!(major_to_minor(500, "SYP"), 500);
        assert_eq!(major_to_minor(500, "USD"), 50_000);
        assert_eq!(major_to_minor(500, "KWD"), 500_000);
    }

    #[test]
    fn syp_and_iqd_are_zero_scale() {
        assert_eq!(scale_for("SYP"), 0);
        assert_eq!(scale_for("IQD"), 0);
    }

    #[test]
    fn three_decimal_gulf_currencies() {
        assert_eq!(scale_for("KWD"), 3);
        assert_eq!(scale_for("BHD"), 3);
        assert_eq!(scale_for("OMR"), 3);
        assert_eq!(scale_for("JOD"), 3);
    }

    #[test]
    fn default_two_decimal() {
        assert_eq!(scale_for("USD"), 2);
        assert_eq!(scale_for("SAR"), 2);
        assert_eq!(scale_for("SOMETHING_UNKNOWN"), 2);
    }
}
