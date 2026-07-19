//! Minimal Hybrid Logical Clock for ordering sync facts (CLOUD_AND_LICENSING_
//! PLAN.md §5 / Slice 2a). Deliberately NOT a full cross-device HLC with
//! clock-skew correction -- that machinery exists to resolve causality
//! between MULTIPLE writers of the same row, which never happens here: the
//! branch device is the sole source of truth for its own facts (nothing else
//! ever writes to another device's rows). The only thing this needs to
//! guarantee is a monotonically increasing value for facts from THIS device,
//! even when two facts are created in the same millisecond -- a plain
//! timestamp can't do that, hence the logical counter.
//!
//! Format: `{physical_ms:013}.{logical_counter:010}`, lexicographically
//! sortable as a plain string.

use std::sync::atomic::{AtomicI64, Ordering};

static COUNTER: AtomicI64 = AtomicI64::new(0);

pub fn next() -> String {
    let physical_ms = chrono::Utc::now().timestamp_millis();
    let counter = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{physical_ms:013}.{counter:010}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successive_calls_are_strictly_increasing() {
        let a = next();
        let b = next();
        let c = next();
        assert!(a < b, "{a} should sort before {b}");
        assert!(b < c, "{b} should sort before {c}");
    }

    #[test]
    fn is_lexicographically_sortable_as_a_plain_string() {
        let mut values: Vec<String> = (0..50).map(|_| next()).collect();
        let sorted = {
            let mut v = values.clone();
            v.sort();
            v
        };
        // The order they were generated in must already be the sorted order --
        // proves the string format itself carries the ordering, no numeric
        // parsing required downstream (e.g. a `ORDER BY hlc` in Postgres).
        assert_eq!(values, sorted);
        values.clear();
    }
}
