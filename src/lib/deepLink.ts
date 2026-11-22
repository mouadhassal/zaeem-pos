// A tap on a dashboard card opens the detailed report: the right page and, when the page has tabs, the right tab.
// The page asks for the tab once, as it opens (`takePendingTab`), so a later manual visit starts on its usual tab.
import { navigateTo } from "./appNav";

const MAX_AGE_MS = 3000;
let pending: { page: string; tab: string; at: number } | null = null;

/** Opens a sidebar page on one of its tabs (the page's own permission check still applies). */
export function openPageTab(page: string, tab?: string): void {
  pending = tab ? { page, tab, at: Date.now() } : null;
  navigateTo(page);
}

/** The tab a card asked this page to open on, if it is one of `valid`; otherwise `fallback`. */
export function takePendingTab<T extends string>(page: string, valid: readonly T[], fallback: T, now: number = Date.now()): T {
  const p = pending;
  pending = null;
  if (p && p.page === page && now - p.at <= MAX_AGE_MS && (valid as readonly string[]).includes(p.tab)) return p.tab as T;
  return fallback;
}
