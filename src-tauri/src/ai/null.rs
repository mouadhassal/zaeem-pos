use super::*;

pub struct NullAiProvider;

impl AiProvider for NullAiProvider {
    fn menu_from_media(&self, _media: &[Media]) -> Result<DraftMenu, AiError> {
        Err(AiError::Unavailable(
            "NullAiProvider: no AI backend configured".into(),
        ))
    }

    fn anomalies(&self, _w: &ShiftWindow) -> Result<Vec<Anomaly>, AiError> {
        Err(AiError::Unavailable(
            "NullAiProvider: no AI backend configured".into(),
        ))
    }

    fn answer(&self, _q: &str, _s: &Snapshot) -> Result<Answer, AiError> {
        Err(AiError::Unavailable(
            "NullAiProvider: no AI backend configured".into(),
        ))
    }
}
