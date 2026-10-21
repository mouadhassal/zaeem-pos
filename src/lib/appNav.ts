/**
 * Lets a screen send the user to another sidebar screen (App.tsx listens).
 * Goes through the same permission check as a sidebar tap.
 */
export const APP_NAVIGATE_EVENT = "wenzdes-navigate";

export function navigateTo(viewId: string): void {
  window.dispatchEvent(new CustomEvent<string>(APP_NAVIGATE_EVENT, { detail: viewId }));
}
