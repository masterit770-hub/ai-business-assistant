import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Component-test runner. Deliberately SCOPED to tests/components/** so it never
// touches the node-based unit suite (tests/unit/*.test.mts, run by `npm test` via
// node --test) or the integration evals (tests/evals/*.mjs, run by node directly).
// Those layers are intentionally NOT vitest — this config owns only the component
// layer (one stateful UI component rendered in isolation; props → state →
// interaction → render), per docs/testing/INDEX.md.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" → "./src/*" path alias so component imports resolve.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/components/setup.ts"],
    // Only the component layer. (Unit + eval layers run on their own node runners.)
    include: ["tests/components/**/*.test.tsx"],
    css: false,
    restoreMocks: true,
  },
});
