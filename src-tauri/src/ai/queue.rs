#![allow(dead_code)]

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UploadStatus {
    Queued,
    Processing,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadItem {
    pub id: String,
    pub kind: MediaKind,
    pub filename: String,
    pub status: UploadStatus,
    pub error: Option<String>,
    pub draft_menu: Option<DraftMenu>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadQueueItem {
    pub id: String,
    pub kind: String,
    pub filename: String,
    pub file_path: String,
    pub mime: String,
    pub status: String,
    pub error: Option<String>,
    pub draft_json: Option<String>,
}

pub struct UploadQueue {
    conn: Connection,
}

impl UploadQueue {
    pub fn new(db_path: &Path) -> Result<Self, AiError> {
        let conn = Connection::open(db_path)?;
        Self::init_tables(&conn)?;
        Ok(Self { conn })
    }

    pub fn new_queue(conn: Connection) -> Self {
        Self::init_tables(&conn).ok();
        Self { conn }
    }

    fn init_tables(conn: &Connection) -> Result<(), AiError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS upload_queue (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK(kind IN ('PHOTO','PDF','AUDIO')),
                filename TEXT NOT NULL,
                file_path TEXT NOT NULL,
                mime TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PROCESSING','DONE','FAILED')),
                error TEXT,
                draft_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        )?;
        Ok(())
    }

    pub fn enqueue(&mut self, kind: MediaKind, filename: &str, data: &[u8], mime: &str) -> Result<UploadItem, AiError> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = std::env::temp_dir().join("zaeem-uploads");
        std::fs::create_dir_all(&dir).ok();
        let ext = match kind {
            MediaKind::Photo => "jpg",
            MediaKind::Pdf => "pdf",
            MediaKind::Audio => "webm",
        };
        let file_path = dir.join(format!("{}.{}", id, ext));
        std::fs::write(&file_path, data)?;
        let path_str = file_path.to_string_lossy().to_string();
        let kind_str = match kind {
            MediaKind::Photo => "PHOTO",
            MediaKind::Pdf => "PDF",
            MediaKind::Audio => "AUDIO",
        };
        self.conn.execute(
            "INSERT INTO upload_queue (id, kind, filename, file_path, mime, status) VALUES (?1, ?2, ?3, ?4, ?5, 'QUEUED')",
            params![id, kind_str, filename, path_str, mime],
        )?;
        Ok(UploadItem {
            id,
            kind,
            filename: filename.to_string(),
            status: UploadStatus::Queued,
            error: None,
            draft_menu: None,
        })
    }

    pub fn list(&self) -> Result<Vec<UploadItem>, AiError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, filename, status, error, draft_json FROM upload_queue ORDER BY created_at ASC"
        )?;
        let items = stmt.query_map([], |row| {
            let kind_str: String = row.get(1)?;
            let status_str: String = row.get(3)?;
            let draft_raw: Option<String> = row.get(5)?;
            let draft_menu = draft_raw.and_then(|j| serde_json::from_str(&j).ok());
            Ok(UploadItem {
                id: row.get(0)?,
                kind: match kind_str.as_str() {
                    "PHOTO" => MediaKind::Photo,
                    "PDF" => MediaKind::Pdf,
                    _ => MediaKind::Audio,
                },
                filename: row.get(2)?,
                status: match status_str.as_str() {
                    "QUEUED" => UploadStatus::Queued,
                    "PROCESSING" => UploadStatus::Processing,
                    "DONE" => UploadStatus::Done,
                    _ => UploadStatus::Failed,
                },
                error: row.get(4)?,
                draft_menu,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn process_next<F: ?Sized + AiProvider>(&mut self, provider: &F) -> Result<Option<UploadItem>, AiError>
    {
        let item: Option<(String, String, String, String, String)> = self.conn.query_row(
            "SELECT id, kind, file_path, mime, filename FROM upload_queue WHERE status = 'QUEUED' LIMIT 1",
            [],
            |row| Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            )),
        ).ok();

        let (id, kind_str, file_path, mime, filename) = match item {
            Some(v) => v,
            None => return Ok(None),
        };

        self.conn.execute(
            "UPDATE upload_queue SET status = 'PROCESSING' WHERE id = ?1",
            params![id],
        )?;

        let kind = match kind_str.as_str() {
            "PHOTO" => MediaKind::Photo,
            "PDF" => MediaKind::Pdf,
            _ => MediaKind::Audio,
        };
        let _data = std::fs::read(&file_path)?;
        let media = vec![Media {
            id: id.clone(),
            kind,
            path: file_path.clone(),
            mime: mime.clone(),
        }];

        match provider.menu_from_media(&media) {
            Ok(draft) => {
                let json = serde_json::to_string(&draft).map_err(|e| AiError::ValidationFailed(e.to_string()))?;
                self.conn.execute(
                    "UPDATE upload_queue SET status = 'DONE', draft_json = ?1 WHERE id = ?2",
                    params![json, id],
                )?;
                Ok(Some(UploadItem {
                    id,
                    kind,
                    filename,
                    status: UploadStatus::Done,
                    error: None,
                    draft_menu: Some(draft),
                }))
            }
            Err(e) => {
                self.conn.execute(
                    "UPDATE upload_queue SET status = 'FAILED', error = ?1 WHERE id = ?2",
                    params![e.to_string(), id],
                )?;
                Ok(Some(UploadItem {
                    id,
                    kind,
                    filename,
                    status: UploadStatus::Failed,
                    error: Some(e.to_string()),
                    draft_menu: None,
                }))
            }
        }
    }

    pub fn reset_failed(&mut self) -> Result<usize, AiError> {
        let count = self.conn.execute(
            "UPDATE upload_queue SET status = 'QUEUED', error = NULL WHERE status = 'FAILED'",
            [],
        )?;
        Ok(count)
    }

    pub fn clear_done(&mut self) -> Result<usize, AiError> {
        let count = self.conn.execute(
            "DELETE FROM upload_queue WHERE status IN ('DONE', 'FAILED')",
            [],
        )?;
        Ok(count)
    }
}
