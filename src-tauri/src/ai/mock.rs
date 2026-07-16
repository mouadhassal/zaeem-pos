use super::*;

pub struct MockAiProvider;

impl AiProvider for MockAiProvider {
    fn menu_from_media(&self, media: &[Media]) -> Result<DraftMenu, AiError> {
        if media.is_empty() {
            return Err(AiError::ExtractionFailed("no media provided".into()));
        }

        let photo_count = media.iter().filter(|m| matches!(m.kind, MediaKind::Photo)).count();
        let audio_count = media.iter().filter(|m| matches!(m.kind, MediaKind::Audio)).count();

        if audio_count > 0 && photo_count == 0 {
            return Ok(Self::voice_menu());
        }

        Ok(match photo_count {
            1 => Self::simple_menu(),
            2.. => Self::full_menu(),
            _ => Self::simple_menu(),
        })
    }

    fn anomalies(&self, w: &ShiftWindow) -> Result<Vec<Anomaly>, AiError> {
        Ok(vec![
            Anomaly {
                item_name: "مشروب غازي".into(),
                description: format!(
                    "price dropped 40% vs shift avg of {} per item",
                    if w.total_cents > 0 { w.total_cents / 100 } else { 0 }
                ),
                severity: AnomalySeverity::Medium,
            },
        ])
    }

    fn answer(&self, q: &str, _s: &Snapshot) -> Result<Answer, AiError> {
        Ok(Answer {
            text: format!("Mock response to: {}", q),
            confidence: 0.75,
        })
    }
}

impl MockAiProvider {
    fn simple_menu() -> DraftMenu {
        DraftMenu {
            categories: vec![
                DraftCategory { name: "مشروبات".into(), sort_order: 1, confidence: 0.95 },
                DraftCategory { name: "مقبلات".into(), sort_order: 0, confidence: 0.88 },
            ],
            items: vec![
                DraftItem {
                    ar_name: "كولا".into(),
                    en_name: Some("Cola".into()),
                    price_cents: 500,
                    category_name: "مشروبات".into(),
                    modifiers: vec![],
                    confidence: 0.98,
                },
                DraftItem {
                    ar_name: "عصير برتقال طازج".into(),
                    en_name: Some("Fresh Orange Juice".into()),
                    price_cents: 1200,
                    category_name: "مشروبات".into(),
                    modifiers: vec![
                        DraftModifier { ar_name: "سكر إضافي".into(), price_cents: 0 },
                        DraftModifier { ar_name: "ثلج إضافي".into(), price_cents: 0 },
                    ],
                    confidence: 0.82,
                },
                DraftItem {
                    ar_name: "حمص باللحم".into(),
                    en_name: Some("Hummus with Meat".into()),
                    price_cents: 2800,
                    category_name: "مقبلات".into(),
                    modifiers: vec![],
                    confidence: 0.91,
                },
            ],
        }
    }

    fn full_menu() -> DraftMenu {
        DraftMenu {
            categories: vec![
                DraftCategory { name: "أطباق رئيسية".into(), sort_order: 0, confidence: 0.92 },
                DraftCategory { name: "مقبلات".into(), sort_order: 1, confidence: 0.90 },
                DraftCategory { name: "مشروبات".into(), sort_order: 2, confidence: 0.97 },
                DraftCategory { name: "حلويات".into(), sort_order: 3, confidence: 0.78 },
            ],
            items: vec![
                DraftItem {
                    ar_name: "شاورما دجاج".into(),
                    en_name: Some("Chicken Shawarma".into()),
                    price_cents: 3500,
                    category_name: "أطباق رئيسية".into(),
                    modifiers: vec![
                        DraftModifier { ar_name: "خبز صامولي".into(), price_cents: 0 },
                        DraftModifier { ar_name: "خبز عربي".into(), price_cents: 0 },
                    ],
                    confidence: 0.95,
                },
                DraftItem {
                    ar_name: "شاورما لحم".into(),
                    en_name: Some("Meat Shawarma".into()),
                    price_cents: 3800,
                    category_name: "أطباق رئيسية".into(),
                    modifiers: vec![],
                    confidence: 0.93,
                },
                DraftItem {
                    ar_name: "فتوش".into(),
                    en_name: Some("Fattoush Salad".into()),
                    price_cents: 1800,
                    category_name: "مقبلات".into(),
                    modifiers: vec![DraftModifier { ar_name: "دجاج إضافي".into(), price_cents: 800 }],
                    confidence: 0.87,
                },
                DraftItem {
                    ar_name: "كولا دايت".into(),
                    en_name: Some("Diet Cola".into()),
                    price_cents: 500,
                    category_name: "مشروبات".into(),
                    modifiers: vec![],
                    confidence: 0.99,
                },
                DraftItem {
                    ar_name: "كنافة".into(),
                    en_name: Some("Kunafa".into()),
                    price_cents: 2200,
                    category_name: "حلويات".into(),
                    modifiers: vec![
                        DraftModifier { ar_name: "مع آيس كريم".into(), price_cents: 500 },
                    ],
                    confidence: 0.72,
                },
            ],
        }
    }

    fn voice_menu() -> DraftMenu {
        DraftMenu {
            categories: vec![
                DraftCategory { name: "مشروبات".into(), sort_order: 0, confidence: 0.70 },
            ],
            items: vec![
                DraftItem {
                    ar_name: "مشروب غازي".into(),
                    en_name: None,
                    price_cents: 300,
                    category_name: "مشروبات".into(),
                    modifiers: vec![],
                    confidence: 0.55,
                },
            ],
        }
    }
}
