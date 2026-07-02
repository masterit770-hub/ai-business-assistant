import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// JOURNEY-PURITY LINT — the F1 class-killer, enforced statically (docs aren't enforcement).
//
// THE RULE (see docs/testing/INDEX.md §"Journey purity"):
//   A journey may only MUTATE product state through the REAL UI (Playwright interactions).
//   A raw fetch() to /api/* is allowed ONLY for
//     (a) READ-ONLY assertion probes (GET — never flagged here), or
//     (b) an explicitly-exempted mutation carrying a `// purity-exempt: <reason>` comment
//         within the few lines above it (e.g. lifecycle's apiAsk asks — a deliberate,
//         documented SDK-budget choice; teardown deletes; SDK-scenario ingest setup).
//
// WHY (tonight's live case, 2026-07-02): space→chat assignment was API-driven inside the
// journeys (a raw POST /api/spaces/sessions via `apiAssignSession`). So when the real UI wire
// that registers a chat into its Knowledge Space was MISSING, the journeys stayed GREEN —
// they had assigned the session themselves through the API, masking the broken product path.
// The bug (F1: a space's chat list was permanently empty for real users) shipped behind green
// tests. A journey that mutates through the API instead of the UI cannot catch a broken UI
// wire — it IS the wire. This lint makes every such shortcut visible and forces it to either
// move to the real UI or be justified in writing.
//
// SCOPE / RATCHET: the rule is ENFORCED for every journey NOT in LEGACY_UNMIGRATED below —
// that includes the two files the rule was born from (knowledge-spaces.mjs, lifecycle.mjs)
// and any NEW journey added later (a new file is enforced by default, so the floor only
// rises). The legacy set is a documented migration ledger, NOT a waiver: those files predate
// the rule and are owned by other work tonight; as each is next edited, annotate its
// mutations (or move them to the real UI) and delete it from the set.

const JOURNEYS_DIR = fileURLToPath(new URL("../journeys/", import.meta.url));

// Pre-existing journeys whose API mutations predate this rule and are not annotated yet.
// Each carries the reason its mutations are (for now) legitimate infra, so a future editor
// knows what to convert. NOT a free pass — see "RATCHET" above.
const LEGACY_UNMIGRATED = new Set<string>([
  "lib.mjs",              // shared harness: uploadFileBytes() is a sanctioned zero-SDK ingest primitive
  "answer-surface.mjs",   // DELETE /api/documents — test teardown of uploaded probe docs
  "per-chat-scoping.mjs", // DELETE /api/documents — test teardown of uploaded probe docs
  "prompts-persist.mjs",  // PUT /api/settings — prompt capture/restore (finally) + the settings write under test
  "ingest-formats.mjs",   // DELETE /api/documents — test teardown of uploaded probe docs
  "model-modes.mjs",      // PUT /api/settings (mode switch) + POST /api/ask (400-validation probe)
  "bulk-delete.mjs",      // POST /api/ask — seeds throwaway chat sessions for the bulk-delete UI test
  // Concurrent WIP tonight (task #10, Local-mode journey — owned by another engineer, still
  // uncommitted). Its only mutation is POST /api/test-connection (a provider connection PING,
  // not a state change). OWNER TODO: add `// purity-exempt: connection-test ping (no state
  // change)` on that fetch, then delete this entry so the file is fully enforced.
  "local-mode.mjs",
]);

// A mutating fetch is identified by its `method:` option (POST/PUT/PATCH/DELETE). GET probes
// carry no method and are never flagged — read-only assertion probes are always allowed.
const MUTATION = /\bmethod\s*:\s*["'`]?(POST|PUT|PATCH|DELETE)\b/i;
const EXEMPT = /purity-exempt\s*:/i;
// How many lines above the `method:` line to scan for the exemption comment. 4 covers a
// comment placed directly above a multi-line `fetch(url, { method: ... })` call.
const LOOKBACK = 4;

type Hit = { line: number; verb: string; exempt: boolean; text: string };

function mutationsIn(src: string): Hit[] {
  const lines = src.split(/\r?\n/);
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MUTATION);
    if (!m) continue;
    let exempt = false;
    for (let j = Math.max(0, i - LOOKBACK); j <= i; j++) {
      if (EXEMPT.test(lines[j])) {
        exempt = true;
        break;
      }
    }
    hits.push({ line: i + 1, verb: m[1].toUpperCase(), exempt, text: lines[i].trim().slice(0, 100) });
  }
  return hits;
}

function journeyFiles(): string[] {
  return readdirSync(JOURNEYS_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
}

// ── Enforced files: every API mutation must be UI-driven or carry a purity-exempt reason ──
for (const file of journeyFiles()) {
  if (LEGACY_UNMIGRATED.has(file)) continue;
  test(`journey purity — ${file}: every API mutation is UI-driven or purity-exempt`, () => {
    const src = readFileSync(JOURNEYS_DIR + file, "utf8");
    const unexempt = mutationsIn(src).filter((h) => !h.exempt);
    assert.deepEqual(
      unexempt.map((h) => `${file}:${h.line} ${h.verb} — ${h.text}`),
      [],
      `${file} has raw fetch() mutation(s) with no "// purity-exempt: <reason>" comment above them.\n` +
        `Journeys must MUTATE product state through the REAL UI (so a broken UI wire is caught), not via\n` +
        `raw fetch() to /api/*. Either drive the change through Playwright, or (if the API mutation is a\n` +
        `deliberate, documented choice — an SDK-budget ask, test setup, or teardown) add a\n` +
        `\`// purity-exempt: <reason>\` comment on the line(s) above it. See docs/testing/INDEX.md.`
    );
  });
}

// ── Ratchet guard: the F1 regression files must be ENFORCED, never grandfathered ──
// This is what stops the rule from silently decaying: if someone drops knowledge-spaces.mjs
// or lifecycle.mjs into LEGACY_UNMIGRATED to "make the lint pass", this fails loudly.
test("journey purity — the F1 regression files are ENFORCED (not grandfathered)", () => {
  const files = new Set(journeyFiles());
  for (const f of ["knowledge-spaces.mjs", "lifecycle.mjs"]) {
    assert.ok(files.has(f), `${f} is missing from tests/journeys/ — the purity rule cannot cover it`);
    assert.ok(
      !LEGACY_UNMIGRATED.has(f),
      `${f} must NOT be in LEGACY_UNMIGRATED — it is the file the journey-purity rule was born from`
    );
  }
});
