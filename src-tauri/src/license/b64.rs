//! Minimal standard-alphabet base64, used only for encoding/decoding the
//! signature and pubkey bytes in the license file. Not a security primitive
//! itself (ed25519-dalek does the actual crypto) -- same
//! no-extra-dependency-for-plumbing choice already made in `photos.rs`.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(b2 & 0x3F) as usize] as char } else { '=' });
    }
    out
}

pub fn decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let s = s.trim_end_matches('=');
    let bytes = s.as_bytes();
    if bytes.iter().any(|&c| val(c).is_none()) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 3);
    for chunk in bytes.chunks(4) {
        let v: Vec<u8> = chunk.iter().map(|&c| val(c).unwrap()).collect();
        out.push((v[0] << 2) | (v.get(1).copied().unwrap_or(0) >> 4));
        if v.len() > 2 {
            out.push((v[1] << 4) | (v[2] >> 2));
        }
        if v.len() > 3 {
            out.push((v[2] << 6) | v[3]);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_arbitrary_bytes() {
        for len in [0usize, 1, 2, 3, 4, 5, 31, 32, 63, 64, 100] {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 % 256) as u8).collect();
            let encoded = encode(&data);
            let decoded = decode(&encoded).unwrap();
            assert_eq!(decoded, data, "roundtrip failed at len {len}");
        }
    }

    #[test]
    fn matches_known_vectors() {
        assert_eq!(encode(b"Zaeem"), "WmFlZW0=");
        assert_eq!(decode("WmFlZW0=").unwrap(), b"Zaeem");
    }

    #[test]
    fn rejects_invalid_characters() {
        assert_eq!(decode("not valid base64!!"), None);
    }
}
