//! 2026-07-27: the real `AiProvider` -- everything before this was either
//! `MockAiProvider` (hardcoded fake menus, debug builds only) or
//! `NullAiProvider` (always errors, what every release build actually
//! shipped with -- "menu onboarding" silently never worked).
//!
//! Deliberately does NOT call the AI vendor's API directly from this
//! desktop app: that would mean embedding a real API key inside a binary
//! anyone can extract from an installer. Instead this proxies through a
//! Supabase Edge Function (`ai-menu-extract`), which holds the real key
//! server-side (currently Google Gemini's free tier -- see that
//! function's own doc comment) and checks the caller's `device_token`
//! against the `license` table first -- the same gate `sync-pos` already
//! uses, so only a genuinely licensed, active terminal can trigger a
//! call. This Rust side has no idea which AI vendor is behind the
//! function at all, by design -- swapping vendors later is a Supabase
//! Edge Function change only, never a rebuild of the app.
use super::*;
use base64::Engine;
use std::path::PathBuf;

pub struct RemoteAiProvider {
    pub license_dir: PathBuf,
    pub supabase_url: String,
    pub supabase_anon_key: String,
}

impl RemoteAiProvider {
    fn device_token(&self) -> Option<String> {
        crate::license::cloud::load_config_from_file(&self.license_dir.join("cloud_config.json"))
            .map(|c| c.device_token)
    }
}

impl AiProvider for RemoteAiProvider {
    fn menu_from_media(&self, media: &[Media]) -> Result<DraftMenu, AiError> {
        let m = media
            .first()
            .ok_or_else(|| AiError::ExtractionFailed("no media provided".into()))?;

        // Claude's Messages API has no audio input -- rather than pretend
        // this works and fail confusingly server-side, this is a clear,
        // immediate, honest "not yet" right here.
        if matches!(m.kind, MediaKind::Audio) {
            return Err(AiError::Unavailable(
                "استخراج القائمة من التسجيل الصوتي غير مدعوم حالياً -- استخدم صورة أو ملف PDF".into(),
            ));
        }

        let device_token = self
            .device_token()
            .ok_or_else(|| AiError::Unavailable("no active license on this device -- activate a license first".into()))?;

        let bytes = std::fs::read(&m.path)?;
        let media_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let kind_str = match m.kind {
            MediaKind::Photo => "PHOTO",
            MediaKind::Pdf => "PDF",
            MediaKind::Audio => unreachable!("handled above"),
        };

        // Plain `reqwest::blocking`, not the async client the rest of this
        // app uses -- `AiProvider::menu_from_media` is a sync trait method
        // called from `UploadQueue::process_next`, itself called from a
        // plain (non-async) `#[tauri::command]`, so there's no ambient
        // tokio runtime to bridge into here (unlike lan.rs's
        // `resolve_actor_via_hub`, which has to handle both cases).
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .map_err(|e| AiError::Unavailable(e.to_string()))?;

        let resp = client
            .post(format!("{}/functions/v1/ai-menu-extract", self.supabase_url))
            .header("apikey", &self.supabase_anon_key)
            .header("Authorization", format!("Bearer {}", self.supabase_anon_key))
            .json(&serde_json::json!({
                "device_token": device_token,
                "media_base64": media_base64,
                "mime": m.mime,
                "kind": kind_str,
            }))
            .send()
            .map_err(|e| AiError::Unavailable(format!("could not reach AI service: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(AiError::ExtractionFailed(format!("AI service returned {status}: {body}")));
        }

        resp.json::<DraftMenu>()
            .map_err(|e| AiError::ExtractionFailed(format!("invalid AI response shape: {e}")))
    }

    fn anomalies(&self, _w: &ShiftWindow) -> Result<Vec<Anomaly>, AiError> {
        // Out of scope for this pass (menu onboarding only) -- honest
        // "not built yet", not a fake canned response.
        Err(AiError::Unavailable("anomaly detection is not implemented yet".into()))
    }

    fn answer(&self, _q: &str, _s: &Snapshot) -> Result<Answer, AiError> {
        Err(AiError::Unavailable("AI Q&A is not implemented yet".into()))
    }
}
