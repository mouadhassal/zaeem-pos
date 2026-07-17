//! Phase 2 Part 2 -- product photo storage. Local files on disk, keyed by
//! product id, tenant-namespaced. No cloud, no new crate dependency (a
//! ~20-line hand-rolled base64 encoder beats a new supply-chain dependency
//! for a non-money, non-security-critical asset path). Deliberately kept
//! in its own small module, same shape as `ai::queue` (I/O helpers, not
//! business logic -- `repo.rs` stays DB-only).

use std::path::PathBuf;

const MAX_PHOTO_BYTES: usize = 3 * 1024 * 1024; // 3MB -- these are 62px tile thumbnails, not gallery images.

#[derive(Debug)]
pub enum PhotoError {
    TooLarge { size: usize, max: usize },
    UnrecognizedFormat,
    Io(std::io::Error),
}

impl std::fmt::Display for PhotoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { size, max } => write!(f, "photo is {size} bytes, over the {max} byte limit"),
            Self::UnrecognizedFormat => write!(f, "unrecognized image format -- only JPEG, PNG, and WEBP are accepted"),
            Self::Io(e) => write!(f, "photo storage I/O error: {e}"),
        }
    }
}

impl From<std::io::Error> for PhotoError {
    fn from(e: std::io::Error) -> Self { Self::Io(e) }
}

/// Sniffs the real format from magic bytes -- never trusts a client-supplied
/// extension/mime string, the same "validate, don't trust" principle used
/// everywhere else in this codebase.
fn detect_extension(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 3 && data[0..3] == [0xFF, 0xD8, 0xFF] {
        return Some("jpg");
    }
    if data.len() >= 8 && data[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("png");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

fn mime_for_extension(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

fn photos_dir(app_data_dir: &std::path::Path, tenant_id: &str) -> PathBuf {
    app_data_dir.join("product_photos").join(tenant_id)
}

/// Writes `data` to `<app_data_dir>/product_photos/<tenant_id>/<item_id>.<ext>`,
/// removing any previously-stored photo for this item first (a re-upload
/// replaces, it doesn't accumulate orphan files under a growing counter).
/// Returns the absolute file path written, for persisting into
/// `menu_items.image_path`.
pub fn store_photo(app_data_dir: &std::path::Path, tenant_id: &str, item_id: &str, data: &[u8]) -> Result<PathBuf, PhotoError> {
    if data.len() > MAX_PHOTO_BYTES {
        return Err(PhotoError::TooLarge { size: data.len(), max: MAX_PHOTO_BYTES });
    }
    let ext = detect_extension(data).ok_or(PhotoError::UnrecognizedFormat)?;

    let dir = photos_dir(app_data_dir, tenant_id);
    std::fs::create_dir_all(&dir)?;

    // Remove any previous photo for this item under a different extension
    // (e.g. re-uploading a PNG over a previous JPEG) before writing the new one.
    for candidate_ext in ["jpg", "png", "webp"] {
        let candidate = dir.join(format!("{item_id}.{candidate_ext}"));
        if candidate.exists() {
            let _ = std::fs::remove_file(&candidate);
        }
    }

    let file_path = dir.join(format!("{item_id}.{ext}"));
    std::fs::write(&file_path, data)?;
    Ok(file_path)
}

/// Deletes the stored photo file for an item, if any (called when a photo
/// is explicitly removed, or the menu item itself is deleted).
pub fn delete_photo(app_data_dir: &std::path::Path, tenant_id: &str, item_id: &str) {
    let dir = photos_dir(app_data_dir, tenant_id);
    for ext in ["jpg", "png", "webp"] {
        let candidate = dir.join(format!("{item_id}.{ext}"));
        if candidate.exists() {
            let _ = std::fs::remove_file(&candidate);
        }
    }
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(B64_ALPHABET[(b0 >> 2) as usize] as char);
        out.push(B64_ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_ALPHABET[(b2 & 0x3F) as usize] as char } else { '=' });
    }
    out
}

/// Reads a stored photo back off disk and returns it as a `data:` URI ready
/// to drop straight into an `<img src>` -- no Tauri asset-protocol/CSP
/// configuration needed, works in any webview unconditionally. Returns
/// `None` (not an error) if the path is missing/unreadable/stale, so a
/// broken `image_path` just falls back to the category glyph, exactly like
/// "no photo set" already does -- never a broken-image icon or a failed list.
pub fn read_as_data_uri(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let ext = std::path::Path::new(path).extension()?.to_str()?.to_lowercase();
    let mime = mime_for_extension(&ext);
    Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_real_formats_and_rejects_everything_else() {
        assert_eq!(detect_extension(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(detect_extension(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Some("png"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(detect_extension(&webp), Some("webp"));
        assert_eq!(detect_extension(b"<?php system($_GET['c']); ?>"), None, "a disguised PHP/script payload must never be accepted as an image");
        assert_eq!(detect_extension(b"GIF89a"), None, "GIF is deliberately not in the accepted set");
    }

    #[test]
    fn store_read_and_replace_roundtrip() {
        let temp = std::env::temp_dir().join(format!("photo_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let jpeg_bytes = [0xFFu8, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5];
        let path = store_photo(&temp, "tenant-a", "item-1", &jpeg_bytes).unwrap();
        assert!(path.exists());
        assert_eq!(path.extension().unwrap(), "jpg");

        let data_uri = read_as_data_uri(path.to_str().unwrap()).unwrap();
        assert!(data_uri.starts_with("data:image/jpeg;base64,"));

        // Re-upload as PNG must remove the old JPEG file, not leave both.
        let png_bytes = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9];
        let path2 = store_photo(&temp, "tenant-a", "item-1", &png_bytes).unwrap();
        assert_eq!(path2.extension().unwrap(), "png");
        assert!(!path.exists(), "the previous JPEG file must be removed on re-upload, not orphaned");

        delete_photo(&temp, "tenant-a", "item-1");
        assert!(!path2.exists());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn oversized_photo_is_rejected() {
        let temp = std::env::temp_dir().join(format!("photo_test_oversize_{}", std::process::id()));
        let big = vec![0xFFu8; MAX_PHOTO_BYTES + 1];
        match store_photo(&temp, "tenant-a", "item-1", &big) {
            Err(PhotoError::TooLarge { .. }) => {}
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b"Zaeem"), "WmFlZW0=");
        assert_eq!(base64_encode(b"POS"), "UE9T");
        assert_eq!(base64_encode(b""), "");
    }
}
