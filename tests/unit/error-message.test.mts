// friendlyAskError — the rate-limit / usage-limit branch (#5b, "clear limit message").
//
// THE BAR: when the underlying Claude/Anthropic key has hit its cap, the user must see a
// PLAIN, honest line — "The Claude API key has reached its usage limit — please try again
// later." — not the old generic "AI provider's rate limit" wording, and never a raw
// provider/Fly-agent blob. The deployed Fly agent wraps the upstream failure as a 500 whose
// body carries the real cause string ("429 rate_limit_error", "overloaded", "credit balance
// is too low", "monthly"/"billing"), so RATE_LIMIT_RE must catch those wrapped shapes too.
//
// RED-first: against the OLD message ("The AI provider's rate limit was hit …") every
// assertion below fails; the broadened regex + new copy turn them green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyAskError } from "../../src/lib/engine/error-message.ts";

const LIMIT_MSG = "The Claude API key has reached its usage limit — please try again later.";

test("friendlyAskError → the Claude-limit line for a wrapped Fly-agent 429 rate_limit_error", () => {
  assert.equal(
    friendlyAskError(new Error('Fly agent returned 500: {"error":"agent error: 429 rate_limit_error"}')),
    LIMIT_MSG,
  );
});

test("friendlyAskError → the Claude-limit line for an 'overloaded' upstream error", () => {
  assert.equal(
    friendlyAskError(new Error('Fly agent returned 500: {"error":"agent error: overloaded_error"}')),
    LIMIT_MSG,
  );
});

test("friendlyAskError → the Claude-limit line for a 'credit balance is too low' error", () => {
  assert.equal(
    friendlyAskError(new Error('Fly agent returned 500: {"error":"Your credit balance is too low to access the Anthropic API"}')),
    LIMIT_MSG,
  );
});

test("friendlyAskError → the Claude-limit line for a 'monthly'/'billing' cap error", () => {
  assert.equal(
    friendlyAskError(new Error('Fly agent returned 500: {"error":"monthly billing limit exceeded"}')),
    LIMIT_MSG,
  );
});

test("friendlyAskError → the Claude-limit line for a plain 429 / quota blob (unchanged trigger words)", () => {
  for (const blob of [
    "deepseek (deepseek-chat) 429: Too Many Requests",
    "gemini (gemini-2.5-flash) 429: RESOURCE_EXHAUSTED quota",
  ]) {
    assert.equal(friendlyAskError(new Error(blob)), LIMIT_MSG, blob);
  }
});

test("the limit line never leaks the raw provider/agent body", () => {
  const line = friendlyAskError(new Error('Fly agent returned 500: {"error":"agent error: 429 rate_limit_error"}'));
  assert.doesNotMatch(line, /Fly agent|500|429|rate_limit_error|\{/i);
});
