import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getModelMode,
  getModelConfig,
  getSettings,
  setSetting,
  DEFAULTS,
} from "../../src/lib/engine/settings.ts";
import {
  LocalNotConfiguredError,
  LocalUnreachableError,
  isLocalNotConfigured,
  isLocalUnreachable,
} from "../../src/lib/engine/llm.ts";
import { localGuidanceText, answerQuestion } from "../../src/lib/engine/answer.ts";

// These drive the REAL settings layer (in-memory store when Supabase isn't
// configured, which is the test environment) — the same getSetting/setSetting the
// engine reads at request time. So the round-trip is the actual code path, not a
// stub.

test("model_mode defaults to cloud (the unchanged, working backend)", async () => {
  // Clear any prior override first so the default is what we assert.
  await setSetting("model_mode", "");
  assert.equal(await getModelMode(), "cloud");
  assert.equal(DEFAULTS.model_mode, "cloud");
});

test("settings round-trip: PUT model_mode=local then GET returns local; flip back to cloud", async () => {
  await setSetting("model_mode", "local");
  assert.equal(await getModelMode(), "local");
  let all = await getSettings();
  assert.equal(all.model_mode, "local");

  // flip back
  await setSetting("model_mode", "cloud");
  assert.equal(await getModelMode(), "cloud");
  all = await getSettings();
  assert.equal(all.model_mode, "cloud");
});

test("settings round-trip: model_mode=hipaa persists and GET returns hipaa", async () => {
  await setSetting("model_mode", "hipaa");
  assert.equal(await getModelMode(), "hipaa");
  const all = await getSettings();
  assert.equal(all.model_mode, "hipaa");
  await setSetting("model_mode", "cloud"); // reset
});

test("a corrupt/unknown mode fails safe to cloud (never a half-configured local)", async () => {
  await setSetting("model_mode", "garbage");
  assert.equal(await getModelMode(), "cloud");
  await setSetting("model_mode", ""); // reset
});

test("local endpoint + model round-trip; empty endpoint = not configured", async () => {
  await setSetting("local_endpoint", "");
  await setSetting("local_model", "");
  let cfg = await getModelConfig();
  assert.equal(cfg.localEndpoint, "", "empty endpoint persists empty (not configured)");
  assert.equal(cfg.localModel, DEFAULTS.local_model, "blank model falls back to the sensible default");

  await setSetting("local_endpoint", "http://localhost:11434/v1");
  await setSetting("local_model", "llama3");
  cfg = await getModelConfig();
  assert.equal(cfg.localEndpoint, "http://localhost:11434/v1");
  assert.equal(cfg.localModel, "llama3");

  // cleanup so other tests start from defaults
  await setSetting("local_endpoint", "");
  await setSetting("local_model", "");
});

test("typed Local errors are recognizable by code (robust to message changes)", () => {
  const nc = new LocalNotConfiguredError();
  const ur = new LocalUnreachableError("http://localhost:11434/v1", "timed out");
  assert.equal(nc.code, "LOCAL_NOT_CONFIGURED");
  assert.equal(ur.code, "LOCAL_UNREACHABLE");
  assert.equal(ur.endpoint, "http://localhost:11434/v1");
  assert.ok(isLocalNotConfigured(nc));
  assert.ok(isLocalUnreachable(ur));
  // cross-checks: each guard rejects the other error
  assert.ok(!isLocalUnreachable(nc));
  assert.ok(!isLocalNotConfigured(ur));
  // a plain error is neither
  assert.ok(!isLocalNotConfigured(new Error("boom")));
  assert.ok(!isLocalUnreachable(new Error("boom")));
});

test("not-configured guidance is friendly, names Settings → Model + the example endpoint", () => {
  const t = localGuidanceText("not-configured");
  assert.match(t, /Local mode is on/i);
  assert.match(t, /Settings → Model/);
  assert.match(t, /http:\/\/localhost:11434\/v1/);
  assert.match(t, /self-host/i);
  // It must NOT read like an error/crash.
  assert.doesNotMatch(t, /error|exception|failed|500/i);
});

test("unreachable guidance names the actual endpoint and stays calm", () => {
  const t = localGuidanceText("unreachable", "http://192.168.1.50:11434/v1");
  assert.match(t, /couldn't reach your local model/i);
  assert.match(t, /http:\/\/192\.168\.1\.50:11434\/v1/);
  assert.match(t, /Settings → Model/);
  assert.doesNotMatch(t, /\b500\b|exception|stack/i);
});

// ── END-TO-END graceful path through the REAL answerQuestion orchestrator ───────
// These drive answerQuestion itself (router → chat() in local mode), so they prove
// the catch actually fires and produces a NORMAL 200-shaped payload — not a throw.

test("mode=local + empty endpoint → answerQuestion returns the not-configured GUIDANCE (no throw)", async () => {
  await setSetting("model_mode", "local");
  await setSetting("local_endpoint", "");
  try {
    const r = await answerQuestion("What is the total contract spend?");
    // It resolved (did not throw) with the friendly guidance, marked non-grounded.
    assert.equal(r.localGuidance, "not-configured");
    assert.equal(r.mode, "general");
    assert.equal(r.grounded, false);
    assert.equal(r.evidence.rows.length, 0);
    assert.equal(r.evidence.chunks.length, 0);
    assert.equal(r.validation.ok, true); // no scary failed-validation chrome
    assert.match(r.answer, /Local mode is on/i);
    assert.match(r.answer, /Settings → Model/);
  } finally {
    await setSetting("model_mode", "cloud");
    await setSetting("local_endpoint", "");
  }
});

test("mode=local + bogus endpoint → answerQuestion returns the UNREACHABLE guidance FAST (no long hang)", async () => {
  await setSetting("model_mode", "local");
  // A port with nothing listening → connection refused (fast), not a 120s hang.
  await setSetting("local_endpoint", "http://127.0.0.1:1/v1");
  const started = Date.now();
  try {
    const r = await answerQuestion("What is the total contract spend?");
    const elapsedMs = Date.now() - started;
    assert.equal(r.localGuidance, "unreachable");
    assert.equal(r.mode, "general");
    assert.equal(r.grounded, false);
    assert.match(r.answer, /couldn't reach your local model/i);
    assert.match(r.answer, /127\.0\.0\.1:1/);
    // Fail-fast: a refused connection returns well under the 8s timeout, and FAR
    // under the route's 120s budget. Allow generous headroom for slow CI.
    assert.ok(elapsedMs < 10000, `expected fast failure, took ${elapsedMs}ms`);
  } finally {
    await setSetting("model_mode", "cloud");
    await setSetting("local_endpoint", "");
  }
});
