import { defineConfig } from "vitest/config";

// Scoped to src/ only -- e2e/specs/*.spec.ts are WebDriver/mocha specs
// (wdio.conf.ts runs them against a real launched app window), not vitest
// tests; without this exclude, vitest's default glob picks them up too
// and fails on mocha's `describe` not being defined.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
