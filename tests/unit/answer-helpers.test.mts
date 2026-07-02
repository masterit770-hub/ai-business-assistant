import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCitation,
  buildCopyText,
  formatCostLine,
  sourceLines,
  classifyAskError,
} from "../../src/components/assistant/answer-helpers.ts";
import { friendlyAskError } from "../../src/lib/engine/error-message.ts";
import { sqlToken, pdfToken } from "../../src/lib/engine/citations.ts";

// Real-shaped evidence mirroring a hybrid grounded turn: one structured contract row +
// one document passage. The `token` on each item is exactly what the engine stamps, and
// it is exactly the chip text in the answer — so resolveCitation is an exact-token lookup.
const evidence = {
  rows: [
    {
      table: "contracts",
      id: 12,
      token: sqlToken("contracts", 12),
      data: { vendor: "Acme Facilities", annual_cost: 48000, expires: "2026-08-01" },
    },
  ],
  chunks: [
    {
      doc: "family-court",
      page: 24,
      token: pdfToken("family-court", 24),
      text: "The custody arrangement grants primary residence to the petitioner.",
      score: 0.81,
    },
  ],
};

// ── resolveCitation: the citation-token → evidence resolver (the #1 traceability fix) ──

test("resolves a [P:...] chip to the matching passage chunk's text + doc/page", () => {
  const r = resolveCitation(pdfToken("family-court", 24), evidence);
  assert.equal(r?.kind, "passage");
  assert.equal(r && r.kind === "passage" && r.doc, "family-court");
  assert.equal(r && r.kind === "passage" && r.page, 24);
  assert.match(
    (r && r.kind === "passage" && r.text) || "",
    /custody arrangement/
  );
});

test("resolves a [S:...] chip to the matching row's data (field/value pairs)", () => {
  const r = resolveCitation(sqlToken("contracts", 12), evidence);
  assert.equal(r?.kind, "row");
  assert.equal(r && r.kind === "row" && r.table, "contracts");
  assert.equal(r && r.kind === "row" && r.id, 12);
  assert.deepEqual(
    r && r.kind === "row" ? r.data : null,
    { vendor: "Acme Facilities", annual_cost: 48000, expires: "2026-08-01" }
  );
});

test("a token with no matching evidence item resolves to null (chip stays inert)", () => {
  assert.equal(resolveCitation(pdfToken("family-court", 99), evidence), null);
  assert.equal(resolveCitation(sqlToken("contracts", 999), evidence), null);
  assert.equal(resolveCitation("[P:nope#1]", { rows: [], chunks: [] }), null);
  assert.equal(resolveCitation("garbage", evidence), null);
});

// ── source list + copy payload ──────────────────────────────────────────────

test("sourceLines numbers rows then chunks with eN", () => {
  const lines = sourceLines(evidence);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^e1\b/);
  assert.match(lines[0], /contracts#12/);
  assert.match(lines[1], /^e2\b/);
  assert.match(lines[1], /family-court p\.24/);
});

test("buildCopyText includes the answer text and a Sources block", () => {
  const result = {
    question: "q",
    route: { sources: ["structured"], docFilter: null, rationale: "" },
    answer: "Acme expires soon [S:contracts#12].",
    evidence,
    validation: { ok: true, reasons: [] },
  } as Parameters<typeof buildCopyText>[0];
  const txt = buildCopyText(result);
  assert.match(txt, /Acme expires soon/);
  assert.match(txt, /Sources:/);
  assert.match(txt, /contracts#12/);
});

test("buildCopyText for a general answer (no evidence) is just the answer text", () => {
  const result = {
    question: "q",
    route: { sources: [], docFilter: null, rationale: "" },
    answer: "Paris is the capital of France.",
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
  } as Parameters<typeof buildCopyText>[0];
  assert.equal(buildCopyText(result), "Paris is the capital of France.");
});

// ── cost line (#6) ──────────────────────────────────────────────────────────

test("formatCostLine shows real tokens + USD when priced", () => {
  const result = {
    inspector: { cost: { promptTokens: 1000, completionTokens: 240, usd: 0.003 } },
  } as Parameters<typeof formatCostLine>[0];
  assert.equal(formatCostLine(result), "· 1,240 tokens · $0.003");
});

test("formatCostLine falls back to 'cost n/a' when nothing is known", () => {
  const noInspector = {} as Parameters<typeof formatCostLine>[0];
  assert.equal(formatCostLine(noInspector), "· cost n/a");
  const noUsage = {
    inspector: { cost: { usd: null } },
  } as Parameters<typeof formatCostLine>[0];
  assert.equal(formatCostLine(noUsage), "· cost n/a");
});

test("formatCostLine shows tokens even when USD is unpriced", () => {
  const result = {
    inspector: { cost: { promptTokens: 500, completionTokens: 100, usd: null } },
  } as Parameters<typeof formatCostLine>[0];
  assert.equal(formatCostLine(result), "· 600 tokens");
});

// ── error classifiers (#5) — server-side friendlyAskError + client classifyAskError ──

test("friendlyAskError maps a rate-limit / usage-limit blob to the clear Claude-limit line", () => {
  const LIMIT_MSG = "The Claude API key has reached its usage limit — please try again later.";
  assert.equal(
    friendlyAskError(new Error("gemini (gemini-2.5-flash) 429: RESOURCE_EXHAUSTED quota")),
    LIMIT_MSG
  );
  assert.equal(
    friendlyAskError(new Error("deepseek (deepseek-chat) 429: Too Many Requests")),
    LIMIT_MSG
  );
  // The broadened regex also catches the wrapped Fly-agent / Anthropic shapes.
  assert.equal(
    friendlyAskError(new Error('Fly agent returned 500: {"error":"agent error: overloaded_error"}')),
    LIMIT_MSG
  );
});

test("friendlyAskError maps an auth failure to the clear 'fix your key in Settings → Models' line (key isn't working, no answer)", () => {
  // The message was sharpened to the client's required wording: it names the fix location
  // (Settings → Models) AND makes plain that NO answer was produced — so a failed model
  // can never look like a real answer. It must NOT be the calm generic line.
  for (const blob of [
    "gemini (gemini-2.5-flash) 401: API key not valid",
    "openai (gpt-4o) 403: permission denied",
  ]) {
    const line = friendlyAskError(new Error(blob));
    assert.match(line, /Settings → Models/i, blob);
    assert.match(line, /key isn'?t (set or isn'?t )?working|isn'?t set or isn'?t working/i, blob);
    assert.match(line, /no answer/i, blob);
    assert.doesNotMatch(line, /something went wrong/i, blob);
    // Never leaks the raw provider blob.
    assert.doesNotMatch(line, /gemini|gpt-4o|401|403|permission denied|not valid/i, blob);
  }
});

test("friendlyAskError maps a timeout/abort to the took-too-long line", () => {
  assert.equal(friendlyAskError(new Error("fetch timed out")), "That took too long — try again.");
});

test("friendlyAskError never leaks a raw provider body for an unknown error", () => {
  const out = friendlyAskError(new Error("deepseek (deepseek-chat) 500: <html>boom</html>"));
  assert.equal(out, "Something went wrong generating the answer — try again.");
  assert.doesNotMatch(out, /html|deepseek|500/);
});

test("classifyAskError turns the res.json()-before-ok symptom into a calm generic line", () => {
  assert.equal(
    classifyAskError(new Error("Unexpected token < in JSON at position 0")),
    "Something went wrong generating the answer — try again."
  );
});

test("classifyAskError passes a friendly server sentence through unchanged", () => {
  // A clean human sentence with no status code / provider blob / limit trigger word
  // passes through untouched (the server already mapped it).
  const friendly = "That took too long — try again.";
  assert.equal(classifyAskError(new Error(friendly)), friendly);
});

test("classifyAskError maps a wrapped usage-limit failure to the clear Claude-limit line", () => {
  const LIMIT_MSG = "The Claude API key has reached its usage limit — please try again later.";
  assert.equal(
    classifyAskError(new Error('Fly agent returned 500: {"error":"agent error: 429 rate_limit_error"}')),
    LIMIT_MSG
  );
  assert.equal(
    classifyAskError(new Error('Fly agent returned 500: {"error":"Your credit balance is too low"}')),
    LIMIT_MSG
  );
});
