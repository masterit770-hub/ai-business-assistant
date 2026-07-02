import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRODUCTION_FRONTEND_URL } from "../../src/lib/backend-redirect.ts";

// PROD-URL PIN — the enforcement that makes the journey harness incapable of silently
// certifying the WRONG deployment. The .mjs journey/eval files can't import the .ts
// constant at runtime, so their default BASE is a copy-pasted string literal that can
// drift. This test READS those files as text, extracts each default URL, and asserts:
//   (1) every harness default === PRODUCTION_FRONTEND_URL (the single source of truth), and
//   (2) the stale deployment host "nucleus-woad" appears in NONE of them (nor the README).
// So the next deployment rename fails HERE the moment a harness default is left behind —
// instead of a green run that "passed" against a dead deployment.
//
// (F6, 2026-07-02: lib.mjs/rail-render.mjs/golden-evals.mjs + README all defaulted to the
// stale https://nucleus-woad.vercel.app while the live app is https://nucleus-770.vercel.app.)

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const HARNESS_FILES = [
  { name: "tests/journeys/lib.mjs", path: abs("../journeys/lib.mjs") },
  { name: "tests/journeys/rail-render.mjs", path: abs("../journeys/rail-render.mjs") },
  { name: "tests/evals/golden-evals.mjs", path: abs("../evals/golden-evals.mjs") },
];
const README = { name: "README.md", path: abs("../../README.md") };

// The default BASE line in each harness is `process.env.<VAR> || "<url>"`. Pull the URL
// literal that the harness falls back to when NUCLEUS_BASE/RENDER_BASE/EVAL_BASE is unset.
function extractDefaultBase(src: string): string | null {
  const m = src.match(/process\.env\.\w+\s*\|\|\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

const PROD_HOST = new URL(PRODUCTION_FRONTEND_URL).host; // "nucleus-770.vercel.app"

for (const f of HARNESS_FILES) {
  test(`${f.name}: default BASE === PRODUCTION_FRONTEND_URL`, () => {
    const src = readFileSync(f.path, "utf8");
    const got = extractDefaultBase(src);
    assert.ok(got, `could not find a "process.env.* || <url>" default in ${f.name}`);
    assert.equal(
      got,
      PRODUCTION_FRONTEND_URL,
      `${f.name} default BASE is "${got}" but must be the single source of truth "${PRODUCTION_FRONTEND_URL}"`
    );
  });
}

test("README.md documents the live production host", () => {
  const src = readFileSync(README.path, "utf8");
  assert.ok(
    src.includes(PROD_HOST),
    `README.md must document the live host "${PROD_HOST}"`
  );
});

test('no harness/README references the stale "nucleus-woad" deployment', () => {
  const offenders: string[] = [];
  for (const f of [...HARNESS_FILES, README]) {
    if (readFileSync(f.path, "utf8").includes("nucleus-woad")) offenders.push(f.name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these still reference the stale nucleus-woad deployment: ${offenders.join(", ")}`
  );
});
