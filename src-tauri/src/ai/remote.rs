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
//! function's own doc comment). This Rust side has no idea which AI
//! vendor is behind the function at all, by design -- swapping vendors
//! later is a Supabase Edge Function change only, never a rebuild of the
//! app.
//!
//! `device_token` is sent along when this device happens to have one
//! (from a cloud-aware activation) but is NOT required -- most real
//! licenses today are minted offline via `license_signer` (a bare signed
//! blob, no device_token, no Supabase row at all -- see
//! `ai-menu-extract`'s own doc comment for why that function doesn't
//! gate on it). Requiring it here would lock out every terminal actually
//! licensed the way this business really issues licenses.
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

        let device_token = self.device_token();

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

    /// Same proxy-through-Supabase shape as `menu_from_media` above (real key
    /// stays server-side, this binary never sees it) -- posts the question, a
    /// bounded business snapshot (crate::assistant) and the last few chat
    /// turns to the `ai-assistant` edge function and returns its text. One
    /// round trip, no tool loop. Every failure is turned into a plain Arabic
    /// sentence the owner can act on (`friendly_failure`).
    fn answer(&self, q: &str, s: &Snapshot, history: &[ChatTurn]) -> Result<Answer, AiError> {
        let device_token = self.device_token();

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .map_err(|e| AiError::Unavailable(e.to_string()))?;

        let resp = client
            .post(format!("{}/functions/v1/ai-assistant", self.supabase_url))
            .header("apikey", &self.supabase_anon_key)
            .header("Authorization", format!("Bearer {}", self.supabase_anon_key))
            .json(&serde_json::json!({
                "device_token": device_token,
                "question": q,
                "snapshot": s,
                "history": history,
            }))
            .send()
            .map_err(|e| AiError::Unavailable(friendly_transport_error(e.is_timeout(), e.is_connect())))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().unwrap_or_default();
            return Err(AiError::Unavailable(friendly_failure(status, &body)));
        }

        #[derive(serde::Deserialize)]
        struct AssistantResponse {
            answer: String,
        }
        let parsed: AssistantResponse = resp
            .json()
            .map_err(|_| AiError::Unavailable("وصل رد غير مفهوم من خدمة الذكاء الاصطناعي، حاول مجدداً".into()))?;
        if parsed.answer.trim().is_empty() {
            return Err(AiError::Unavailable("لم يستطع المساعد صياغة جواب لهذا السؤال، جرّب صياغة أخرى".into()));
        }

        // The edge function has no confidence signal; report none rather than a fake number.
        Ok(Answer { text: parsed.answer, confidence: None })
    }

    fn help(&self, q: &str, guide: &str, role: &str, history: &[ChatTurn]) -> Result<Answer, AiError> {
        self.help_request(q, guide, role, history)
    }
}

impl RemoteAiProvider {
    /// The help chat's round trip: same edge function, `mode: "help"`.
    fn help_request(&self, q: &str, guide: &str, role: &str, history: &[ChatTurn]) -> Result<Answer, AiError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| AiError::Unavailable(e.to_string()))?;
        let resp = client
            .post(format!("{}/functions/v1/ai-assistant", self.supabase_url))
            .header("apikey", &self.supabase_anon_key)
            .header("Authorization", format!("Bearer {}", self.supabase_anon_key))
            .json(&serde_json::json!({
                "mode": "help",
                "device_token": self.device_token(),
                "question": q,
                "guide": guide,
                "role": role,
                "history": history,
            }))
            .send()
            .map_err(|e| AiError::Unavailable(friendly_transport_error(e.is_timeout(), e.is_connect())))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().unwrap_or_default();
            return Err(AiError::Unavailable(friendly_failure(status, &body)));
        }
        #[derive(serde::Deserialize)]
        struct HelpResponse {
            answer: String,
        }
        let parsed: HelpResponse = resp
            .json()
            .map_err(|_| AiError::Unavailable("وصل رد غير مفهوم من خدمة الذكاء الاصطناعي، حاول مجدداً".into()))?;
        if parsed.answer.trim().is_empty() {
            return Err(AiError::Unavailable("لم يستطع المساعد صياغة جواب لهذا السؤال، جرّب صياغة أخرى".into()));
        }
        Ok(Answer { text: parsed.answer, confidence: None })
    }
}

/// Arabic text for a network-level failure (no HTTP status at all).
pub(crate) fn friendly_transport_error(timed_out: bool, connect_failed: bool) -> String {
    if timed_out {
        "استغرق الرد وقتاً طويلاً، حاول مجدداً".into()
    } else if connect_failed {
        "لا يوجد اتصال بالإنترنت. يحتاج المساعد الذكي إلى الاتصال ليجيب".into()
    } else {
        "تعذّر الوصول إلى خدمة الذكاء الاصطناعي، تأكد من الاتصال وحاول مجدداً".into()
    }
}

/// Arabic text for an HTTP failure from the edge function. The function's own
/// Arabic `error` text is used when it sent one (licence / limit messages are
/// written for exactly this screen); otherwise a sentence per status class.
pub(crate) fn friendly_failure(status: u16, body: &str) -> String {
    let server_msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str().map(str::to_owned)))
        .filter(|m| m.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)));
    match status {
        401 => format!(
            "{}. إن كان هذا الجهاز مفعّلاً بمفتاح قديم فأعد تفعيله بمفتاح ترخيص جديد من WENZDES",
            server_msg.unwrap_or_else(|| "هذه الميزة تحتاج جهازاً مفعّلاً بترخيص WENZDES".into())
        ),
        403 | 429 => server_msg.unwrap_or_else(|| {
            if status == 429 { "تم الوصول إلى الحد المسموح لاستخدام الذكاء الاصطناعي، حاول لاحقاً".into() } else { "لا يوجد ترخيص فعّال لهذا الجهاز".into() }
        }),
        413 => "حجم البيانات كبير على المساعد، اختر فترة أقصر".into(),
        503 => "المساعد الذكي متوقف مؤقتاً من جهة الخادم، حاول بعد قليل".into(),
        500..=599 => "حدث عطل مؤقت في خدمة الذكاء الاصطناعي، حاول بعد قليل".into(),
        _ => server_msg.unwrap_or_else(|| "تعذّر الحصول على جواب من المساعد الذكي، حاول مجدداً".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn licence_errors_keep_the_servers_arabic_and_never_show_raw_json() {
        let m = friendly_failure(401, r#"{"error":"هذه الميزة تحتاج جهازاً مفعّلاً بترخيص WENZDES"}"#);
        assert!(m.contains("تحتاج جهازاً مفعّلاً") && m.contains("مفتاح ترخيص جديد"), "{m}");
        assert!(!m.contains('{') && !m.contains("401"));
        assert_eq!(friendly_failure(403, r#"{"error":"لا يوجد ترخيص فعّال لهذا الجهاز"}"#), "لا يوجد ترخيص فعّال لهذا الجهاز");
        assert!(friendly_failure(429, r#"{"error":"تم الوصول إلى الحد المسموح لاستخدام الذكاء الاصطناعي، حاول مجدداً غداً"}"#).contains("غداً"));
    }

    #[test]
    fn english_or_missing_bodies_get_a_plain_arabic_sentence() {
        assert!(friendly_failure(503, r#"{"error":"AI is not configured on the server yet"}"#).contains("متوقف مؤقتاً"));
        assert!(friendly_failure(500, "Internal error").contains("عطل مؤقت"));
        assert!(friendly_failure(429, "").contains("الحد المسموح"));
        assert!(friendly_failure(418, "<html>").contains("تعذّر الحصول"));
    }

    #[test]
    fn network_failures_are_told_apart() {
        assert!(friendly_transport_error(true, false).contains("وقتاً طويلاً"));
        assert!(friendly_transport_error(false, true).contains("لا يوجد اتصال"));
        assert!(friendly_transport_error(false, false).contains("تعذّر الوصول"));
    }
}
