import { defineConfig } from "vitest/config";

// Scoped to src/ only -- e2e/specs/*.spec.ts are WebDriver/mocha specs
// (wdio.conf.ts runs them against a real launched app window), not vitest
// tests; without this exclude, vitest's default glob picks them up too
// and fails on mocha's `describe` not being defined.
export default defineConfig({
  test: {
    environment: "node",
    // authStore.ts touches `window`/`localStorage` at module load
    // (isBrowserPreview) and inside checkSession -- Node has neither, so
    // those are stubbed in vitest.setup.ts to represent a normal built app.
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});