use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

use super::*;
use super::queue::{UploadItem, UploadStatus};
use crate::audit;
use crate::repo::Repo;
use crate::security::{self, Permission};

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
    pub session_token: String,
    pub kind: String,
    pub filename: String,
    pub data: Vec<u8>,
    pub mime: String,
}

fn authenticate_ai_actor(state: &State<AppState>, session_token: &str) -> Result<security::Actor, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;
    security::authenticate(&conn, session_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn queue_media(
    state: State<AppState>,
    request: QueueMediaRequest,
) -> Result<UploadItem, String> {
    authenticate_ai_actor(&state, &request.session_token)?;
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
pub fn list_uploads(state: State<AppState>, session_token: String) -> Result<Vec<UploadItem>, String> {
    authenticate_ai_actor(&state, &session_token)?;
    let queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn process_queue(state: State<AppState>, session_token: String) -> Result<Vec<UploadItem>, String> {
    authenticate_ai_actor(&state, &session_token)?;
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
pub fn reset_failed_uploads(state: State<AppState>, session_token: String) -> Result<usize, String> {
    authenticate_ai_actor(&state, &session_token)?;
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.reset_failed().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_uploads(state: State<AppState>, session_token: String) -> Result<usize, String> {
    authenticate_ai_actor(&state, &session_token)?;
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.clear_done().map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct ApplyDraftRequest {
    pub session_token: String,
    pub draft: DraftMenu,
}

#[tauri::command]
pub fn apply_draft(
    state: State<AppState>,
    request: ApplyDraftRequest,
) -> Result<ApplyResult, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    apply_draft_impl(&mut conn, &request.session_token, request.draft)
}

/// Extracted from `apply_draft` so the test module (real `rusqlite::Connection`,
/// not a live `tauri::App` -- `AppState`'s `State<T>` can't be constructed
/// outside one) can exercise the T1.9 fix (auth + tenant-scoped writes)
/// directly, same pattern as `verify_manager_override_impl`.
pub(crate) fn apply_draft_impl(conn: &mut rusqlite::Connection, session_token: &str, draft: DraftMenu) -> Result<ApplyResult, String> {
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

    security::ensure_security_schema(conn).map_err(|e| e.to_string())?;
    let actor = security::authenticate(conn, session_token).map_err(|e| e.to_string())?;
    security::authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let repo = Repo::new(&tx);

    let mut cat_name_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut categories_created = 0usize;
    let mut items_created = 0usize;

    for cat in &draft.categories {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM categories WHERE tenant_id = ?1 AND name = ?2 AND is_active = 1",
                rusqlite::params![actor.tenant_id, cat.name],
                |row| row.get(0),
            )
            .ok();

        let cat_id = match existing {
            Some(id) => id,
            None => {
                let id = repo
                    .create_category(&actor.tenant_id, &cat.name, Some("#10b981"), cat.sort_order as i64, None)
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
        repo.create_menu_item(&actor.tenant_id, &item.ar_name, cat_id, item.price_cents, 0, None, None, None)
            .map_err(|e| format!("Failed to create item '{}': {}", item.ar_name, e))?;
        items_created += 1;
    }

    audit::append(
        &tx,
        &actor.device_id,
        &actor.tenant_id,
        actor.branch_id.as_deref(),
        &actor.id,
        audit::Action::MenuItemChanged,
        "ai_draft",
        "applied",
        None,
        Some(&serde_json::json!({ "categories_created": categories_created, "items_created": items_created })),
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("Failed to commit: {}", e))?;

    Ok(ApplyResult {
        categories_created,
        items_created,
    })
}
