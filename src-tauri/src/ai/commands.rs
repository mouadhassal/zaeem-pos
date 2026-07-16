use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

use super::*;
use super::queue::{UploadItem, UploadStatus};

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub queue: Mutex<UploadQueue>,
    pub provider: Box<dyn AiProvider + Send + Sync>,
}

#[derive(Debug, Serialize)]
pub struct ApplyResult {
    pub categories_created: usize,
    pub items_created: usize,
}

#[derive(Debug, Deserialize)]
pub struct QueueMediaRequest {
    pub kind: String,
    pub filename: String,
    pub data: Vec<u8>,
    pub mime: String,
}

#[tauri::command]
pub fn queue_media(
    state: State<AppState>,
    request: QueueMediaRequest,
) -> Result<UploadItem, String> {
    let kind = match request.kind.to_uppercase().as_str() {
        "PHOTO" => MediaKind::Photo,
        "PDF" => MediaKind::Pdf,
        "AUDIO" => MediaKind::Audio,
        _ => return Err("Invalid media kind. Use PHOTO, PDF, or AUDIO.".into()),
    };
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    let item = queue
        .enqueue(kind, &request.filename, &request.data, &request.mime)
        .map_err(|e| e.to_string())?;
    Ok(item)
}

#[tauri::command]
pub fn list_uploads(state: State<AppState>) -> Result<Vec<UploadItem>, String> {
    let queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn process_queue(state: State<AppState>) -> Result<Vec<UploadItem>, String> {
    let mut results = Vec::new();
    loop {
        let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
        let provider: &dyn AiProvider = &*state.provider;
        match queue.process_next(provider) {
            Ok(Some(item)) => results.push(item),
            Ok(None) => break,
            Err(e) => {
                results.push(UploadItem {
                    id: "error".into(),
                    kind: MediaKind::Photo,
                    filename: "error".into(),
                    status: UploadStatus::Failed,
                    error: Some(e.to_string()),
                    draft_menu: None,
                });
                break;
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn reset_failed_uploads(state: State<AppState>) -> Result<usize, String> {
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.reset_failed().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_uploads(state: State<AppState>) -> Result<usize, String> {
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.clear_done().map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct ApplyDraftRequest {
    pub draft: DraftMenu,
}

#[tauri::command]
pub fn apply_draft(
    state: State<AppState>,
    request: ApplyDraftRequest,
) -> Result<ApplyResult, String> {
    let draft = request.draft;

    if draft.items.is_empty() {
        return Err("Draft has no items".into());
    }
    if draft.categories.is_empty() {
        return Err("Draft has no categories".into());
    }
    for item in &draft.items {
        if item.price_cents < 0 {
            return Err(format!("Negative price for '{}'", item.ar_name));
        }
        if item.ar_name.trim().is_empty() {
            return Err("Item has empty name".into());
        }
        let has_cat = draft.categories.iter().any(|c| c.name == item.category_name);
        if !has_cat {
            return Err(format!("Category '{}' not found in draft categories", item.category_name));
        }
    }

    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut cat_name_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut categories_created = 0usize;
    let mut items_created = 0usize;

    for cat in &draft.categories {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM categories WHERE name = ?1 AND is_active = 1",
                params![cat.name],
                |row| row.get(0),
            )
            .ok();

        let cat_id = match existing {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO categories (id, name, color, sort_order, is_active, sync_version, last_modified, sync_status)
                     VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, 'synced')",
                    params![id, cat.name, "#10b981", cat.sort_order, now],
                )
                .map_err(|e| format!("Failed to create category '{}': {}", cat.name, e))?;
                categories_created += 1;
                id
            }
        };
        cat_name_to_id.insert(cat.name.clone(), cat_id);
    }

    for item in &draft.items {
        let cat_id = cat_name_to_id
            .get(&item.category_name)
            .expect("category should exist by now");
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO menu_items (id, name, price_cents, cost_cents, category_id, is_active, sync_version, last_modified, sync_status)
             VALUES (?1, ?2, ?3, 0, ?4, 1, 1, ?5, 'synced')",
            params![id, item.ar_name, item.price_cents, cat_id, now],
        )
        .map_err(|e| format!("Failed to create item '{}': {}", item.ar_name, e))?;
        items_created += 1;
    }

    tx.commit().map_err(|e| format!("Failed to commit: {}", e))?;

    Ok(ApplyResult {
        categories_created,
        items_created,
    })
}
