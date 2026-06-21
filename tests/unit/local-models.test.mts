import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveOllamaBase,
  ollamaTagsUrl,
  extractModelNames,
} from "../../src/lib/engine/local-models.ts";

// These drive the REAL pure helpers the /api/local-models route uses to (a) turn
// the stored OpenAI-compatible `local_endpoint` into Ollama's NATIVE /api/tags URL
// and (b) parse the model names out of the tags response. No network needed.

test("deriveOllamaBase: strips the trailing /v1 (the canonical localhost case)", () => {
  assert.equal(deriveOllamaBase("http://localhost:11434/v1"), "http://localhost:11434");
});

test("deriveOllamaBase: handles a trailing slash after /v1", () => {
  assert.equal(deriveOllamaBase("http://localhost:11434/v1/"), "http://localhost:11434");
});

test("deriveOllamaBase: a tunnel URL (https) strips /v1 the same way", () => {
  assert.equal(
    deriveOllamaBase("https://abcd-1234.trycloudflare.com/v1"),
    "https://abcd-1234.trycloudflare.com"
  );
});

test("deriveOllamaBase: no /v1 suffix → just trims trailing slashes", () => {
  assert.equal(deriveOllamaBase("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(deriveOllamaBase("http://localhost:11434"), "http://localhost:11434");
});

test("deriveOllamaBase: blank/whitespace → '' (caller treats as 'no endpoint')", () => {
  assert.equal(deriveOllamaBase(""), "");
  assert.equal(deriveOllamaBase("   "), "");
});

test("ollamaTagsUrl: builds <base>/api/tags from the stored /v1 endpoint", () => {
  assert.equal(
    ollamaTagsUrl("http://localhost:11434/v1"),
    "http://localhost:11434/api/tags"
  );
  // blank endpoint → "" (no probe)
  assert.equal(ollamaTagsUrl(""), "");
});

test("extractModelNames: parses Ollama's {models:[{name}]} into a string[]", () => {
  const body = { models: [{ name: "qwen2.5:1.5b" }, { name: "llama3" }] };
  assert.deepEqual(extractModelNames(body), ["qwen2.5:1.5b", "llama3"]);
});

test("extractModelNames: ignores entries without a usable name, dedupes, keeps order", () => {
  const body = {
    models: [
      { name: "llama3" },
      { name: "" }, // empty → skipped
      { size: 123 }, // no name → skipped
      { name: "llama3" }, // dup → skipped
      { name: "qwen2.5:1.5b" },
    ],
  };
  assert.deepEqual(extractModelNames(body), ["llama3", "qwen2.5:1.5b"]);
});

test("extractModelNames: a missing/garbage body → [] (never throws)", () => {
  assert.deepEqual(extractModelNames({}), []);
  assert.deepEqual(extractModelNames(null), []);
  assert.deepEqual(extractModelNames({ models: "nope" }), []);
  assert.deepEqual(extractModelNames("not an object"), []);
});
