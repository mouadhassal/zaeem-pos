//! Per-domain split of the former `commands_v3.rs` monolith. Every
//! `#[tauri::command]` function here is byte-for-byte identical to its
//! original in `commands_v3.rs` -- this is purely a mechanical
//! reorganization by domain, not a behavior change. See `commands_v3.rs`
//! itself for the (still-live) integration test suite, which stayed
//! behind because it tests business logic directly via `security::`/
//! `repo::Repo`, not through these command wrappers.

pub mod shared;
pub mod auth;
pub mod orders;
pub mod menu;
pub mod branches;
pub mod inventory;
pub mod shifts;
pub mod staff;
pub mod debt;
pub mod reports;
pub mod settings;
pub mod customers;
pub mod loyalty;
pub mod suppliers;
pub mod license;
pub mod lan_rpc;
