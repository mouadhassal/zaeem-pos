import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import { marketplaceReorderUrl, MARKETPLACE_URL, DEFAULT_MARKETPLACE_URL } from "./marketplace";

describe("marketplaceReorderUrl", () => {
  it("defaults to the production marketplace", () => {
    expect(MARKETPLACE_URL).toBe(DEFAULT_MARKETPLACE_URL);
    expect(marketplaceReorderUrl()).toBe("https://market.wenzdes.com/ar/buyer/reorder?source=pos");
  });

  it("adds the licensed branch when known", () => {
    expect(marketplaceReorderUrl("0b6c-uuid", "https://staging.example")).toBe(
      "https://staging.example/ar/buyer/reorder?source=pos&branch=0b6c-uuid",
    );
  });
});
