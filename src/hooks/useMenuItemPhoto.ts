import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// P0 fix (2026-07-18): list_menu_items_v3 used to embed every item's photo
// as a full base64 data: URI in the list response -- 5 items with 2MB
// photos each measured at 415ms of blocking time (inside the app-wide DB
// mutex) and a 13.3MB payload. It now returns a lightweight "HAS_PHOTO"
// marker instead, and this hook fetches the real photo separately, lazily,
// one item at a time, only for items that are actually mounted on screen --
// the grid renders instantly with glyphs and photos fill in as each
// resolves. Cached in-memory (module-level, keyed by item id) so switching
// categories or re-rendering never re-fetches an already-loaded photo.
const photoCache = new Map<string, string | null>();

export function useMenuItemPhoto(itemId: string, hasPhoto: boolean, sessionToken: string | null): string | null {
  const [photo, setPhoto] = useState<string | null>(() => (hasPhoto ? photoCache.get(itemId) ?? null : null));

  useEffect(() => {
    if (!hasPhoto || !sessionToken) {
      setPhoto(null);
      return;
    }
    const cached = photoCache.get(itemId);
    if (cached !== undefined) {
      setPhoto(cached);
      return;
    }
    let cancelled = false;
    invoke<string | null>("get_menu_item_photo_v3", { sessionToken, itemId })
      .then((dataUri) => {
        photoCache.set(itemId, dataUri);
        if (!cancelled) setPhoto(dataUri);
      })
      .catch(() => {
        photoCache.set(itemId, null);
        if (!cancelled) setPhoto(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, hasPhoto, sessionToken]);

  return photo;
}

/** Called after a photo upload/delete so the next render re-fetches instead of serving a stale cache entry. */
export function invalidateMenuItemPhotoCache(itemId: string) {
  photoCache.delete(itemId);
}
