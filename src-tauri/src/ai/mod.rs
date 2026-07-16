#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Media {
    pub id: String,
    pub kind: MediaKind,
    pub path: String,
    pub mime: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MediaKind {
    Photo,
    Pdf,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftMenu {
    pub categories: Vec<DraftCategory>,
    pub items: Vec<DraftItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftCategory {
    pub name: String,
    pub sort_order: u32,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftItem {
    pub ar_name: String,
    pub en_name: Option<String>,
    pub price_cents: i64,
    pub category_name: String,
    pub modifiers: Vec<DraftModifier>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftModifier {
    pub ar_name: String,
    pub price_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anomaly {
    pub item_name: String,
    pub description: String,
    pub severity: AnomalySeverity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AnomalySeverity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub text: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub total_revenue_cents: i64,
    pub order_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftWindow {
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub total_cents: i64,
}

#[derive(Debug)]
pub enum AiError {
    Unavailable(String),
    ExtractionFailed(String),
    ValidationFailed(String),
    Io(std::io::Error),
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(msg) => write!(f, "AI unavailable: {}", msg),
            Self::ExtractionFailed(msg) => write!(f, "extraction failed: {}", msg),
            Self::ValidationFailed(msg) => write!(f, "validation failed: {}", msg),
            Self::Io(e) => write!(f, "I/O error: {}", e),
        }
    }
}

impl std::error::Error for AiError {}

impl From<std::io::Error> for AiError {
    fn from(e: std::io::Error) -> Self { Self::Io(e) }
}

impl From<rusqlite::Error> for AiError {
    fn from(e: rusqlite::Error) -> Self {
        Self::ExtractionFailed(format!("database error: {}", e))
    }
}

pub trait AiProvider: Send + Sync {
    fn menu_from_media(&self, media: &[Media]) -> Result<DraftMenu, AiError>;
    fn anomalies(&self, w: &ShiftWindow) -> Result<Vec<Anomaly>, AiError>;
    fn answer(&self, q: &str, s: &Snapshot) -> Result<Answer, AiError>;
}

mod null;
mod mock;
mod queue;
pub mod commands;

pub use null::NullAiProvider;
pub use mock::MockAiProvider;
pub use queue::UploadQueue;
