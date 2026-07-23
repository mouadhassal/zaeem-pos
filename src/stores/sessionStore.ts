import { create } from "zustand";

/**
 * P0 fix (2026-07-23): a session expiring used to look identical to a
 * database error to the user -- every page's own catch block showed its
 * own generic "couldn't load" message, all at once, since every command
 * fails the same way once the session is gone. `src/lib/invoke.ts` sets
 * `expired: true` here the moment ANY command fails with "session
 * expired"; `SessionExpiredOverlay` (mounted once, at the app root)
 * renders a full-screen PIN re-entry prompt on top of whatever page was
 * showing -- not a navigation, so cart/order-in-progress state underneath
 * is untouched.
 */
interface SessionState {
  expired: boolean;
  setExpired: (expired: boolean) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  expired: false,
  setExpired: (expired) => set({ expired }),
}));
