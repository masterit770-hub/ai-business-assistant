import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCloudConfig,
  getCloudProvider,
  getSettings,
  setSetting,
  DEFAULTS,
} from "../../src/lib/engine/settings.ts";
import { resolveCloudTarget } from "../../src/lib/engine/llm.ts";
import { detectLang } from "../../src/lib/engine/bundled-sources.ts";

// These drive the REAL settings layer (in-memory store in tests) + the REAL
// resolveCloudTarget() the cloud path uses to build each request. So they prove the
// actual "paste a key → swap provider" wiring, not a stub.

// Helper: clear every cloud-provider override so each test starts from "use env".
async function clearCloud() {
  await setSetting("cloud_provider", "");
  await setSetting("cloud_api_key", "");
  await setSetting("cloud_model", "");
  await setSetting("cloud_base_url", "");
  await setSetting("azure_endpoint", "");
  await setSetting("azure_api_version", "");
}

test("defaults: no cloud override → provider '' (use the env default)", async () => {
  await clearCloud();
  assert.equal(await getCloudProvider(), "");
  const cfg = await getCloudConfig();
  assert.equal(cfg.provider, "");
  assert.equal(cfg.apiKey, "");
  assert.equal(DEFAULTS.cloud_provider, "");
  assert.equal(DEFAULTS.cloud_api_key, "");
});

test("cloud config round-trips through the settings layer", async () => {
  await setSetting("cloud_provider", "gemini");
  await setSetting("cloud_api_key", "AI-secret-123");
  await setSetting("cloud_model", "gemini-2.5-flash");
  const cfg = await getCloudConfig();
  assert.equal(cfg.provider, "gemini");
  assert.equal(cfg.apiKey, "AI-secret-123");
  assert.equal(cfg.model, "gemini-2.5-flash");
  await clearCloud();
});

test("an unknown provider string fails safe to '' (use env, never a broken backend)", async () => {
  await setSetting("cloud_provider", "totally-made-up");
  assert.equal(await getCloudProvider(), "");
  await clearCloud();
});

test("WRITE-ONLY: getSettings() exposes cloud_api_key_set (bool), NEVER the key value", async () => {
  await setSetting("cloud_api_key", "super-secret-key");
  const s = await getSettings();
  // The boolean is true…
  assert.equal(s.cloud_api_key_set, true);
  // …and the raw secret is absent from the admin payload entirely.
  assert.equal((s as Record<string, unknown>).cloud_api_key, undefined);
  // Serialize it like the API would and confirm the secret never appears.
  assert.ok(!JSON.stringify(s).includes("super-secret-key"));

  await setSetting("cloud_api_key", "");
  const s2 = await getSettings();
  assert.equal(s2.cloud_api_key_set, false);
});

// ── resolveCloudTarget — the per-provider request shape ─────────────────────────

test("no override → env default target (Bearer + the env base/chat path)", () => {
  // The test env has no LLM_API_KEY normally; set one so the env branch resolves.
  const prev = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "env-key";
  try {
    const t = resolveCloudTarget({
      provider: "",
      apiKey: "",
      model: "",
      baseUrl: "",
      azureEndpoint: "",
      azureApiVersion: "",
    });
    assert.match(t.url, /\/chat\/completions$/);
    assert.equal(t.headers["Authorization"], "Bearer env-key");
  } finally {
    if (prev === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = prev;
  }
});

test("provider set WITHOUT a key → FAILS CLOSED (never silently uses the env key)", () => {
  // The reported bug: selecting a provider with no key silently fell back to the env
  // (DeepSeek) key, making it LOOK like the selected provider worked. It must fail closed.
  const prev = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "env-key";
  try {
    assert.throws(
      () =>
        resolveCloudTarget({
          provider: "openai",
          apiKey: "", // no key saved for the selected provider
          model: "gpt-4o",
          baseUrl: "",
          azureEndpoint: "",
          azureApiVersion: "",
        }),
      /no API key is saved/i
    );
  } finally {
    if (prev === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = prev;
  }
});

test("blank provider (Default) → still uses the env-default backend (demo path intact)", () => {
  const prev = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "env-key";
  try {
    const t = resolveCloudTarget({
      provider: "",
      apiKey: "",
      model: "",
      baseUrl: "",
      azureEndpoint: "",
      azureApiVersion: "",
    });
    assert.equal(t.headers["Authorization"], "Bearer env-key");
  } finally {
    if (prev === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = prev;
  }
});

test("openai override → api.openai.com base, Bearer key, the chosen model", () => {
  const t = resolveCloudTarget({
    provider: "openai",
    apiKey: "sk-openai",
    model: "gpt-4o",
    baseUrl: "",
    azureEndpoint: "",
    azureApiVersion: "",
  });
  assert.equal(t.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(t.headers["Authorization"], "Bearer sk-openai");
  assert.equal(t.provider, "openai");
  assert.equal(t.model, "gpt-4o");
});

test("gemini override → the OpenAI-compatible generativelanguage base, Bearer key", () => {
  const t = resolveCloudTarget({
    provider: "gemini",
    apiKey: "ai-studio-key",
    model: "gemini-2.5-flash",
    baseUrl: "",
    azureEndpoint: "",
    azureApiVersion: "",
  });
  assert.equal(
    t.url,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  );
  assert.equal(t.headers["Authorization"], "Bearer ai-studio-key");
  assert.equal(t.model, "gemini-2.5-flash");
});

test("gemini override with no model → sensible gemini-2.5-flash default", () => {
  const t = resolveCloudTarget({
    provider: "gemini",
    apiKey: "ai-studio-key",
    model: "",
    baseUrl: "",
    azureEndpoint: "",
    azureApiVersion: "",
  });
  assert.equal(t.model, "gemini-2.5-flash");
});

test("azure override → deployment URL + api-key header (NOT Bearer) + api-version", () => {
  const t = resolveCloudTarget({
    provider: "azure",
    apiKey: "azure-secret",
    model: "my-gpt4o-deployment",
    baseUrl: "",
    azureEndpoint: "https://my-resource.openai.azure.com/",
    azureApiVersion: "2024-10-21",
  });
  assert.equal(
    t.url,
    "https://my-resource.openai.azure.com/openai/deployments/my-gpt4o-deployment/chat/completions?api-version=2024-10-21"
  );
  // Azure uses the `api-key` header, never Authorization: Bearer.
  assert.equal(t.headers["api-key"], "azure-secret");
  assert.equal(t.headers["Authorization"], undefined);
  assert.equal(t.provider, "azure");
});

test("azure cloud target shape is UNCHANGED after the buildAzureTarget refactor", () => {
  // Regression guard: extracting the shared Azure-target builder must keep the
  // cloud-azure output byte-for-byte (URL + headers + provider), so the refactor
  // didn't move the cheese for existing single-key Azure users.
  const t = resolveCloudTarget({
    provider: "azure",
    apiKey: "azure-secret",
    model: "my-gpt4o-deployment",
    baseUrl: "",
    azureEndpoint: "https://my-resource.openai.azure.com/",
    azureApiVersion: "2024-10-21",
  });
  assert.equal(
    t.url,
    "https://my-resource.openai.azure.com/openai/deployments/my-gpt4o-deployment/chat/completions?api-version=2024-10-21"
  );
  assert.equal(t.headers["api-key"], "azure-secret");
  assert.equal(t.headers["Authorization"], undefined);
  assert.equal(t.provider, "azure");
  assert.equal(t.model, "my-gpt4o-deployment");
});

test("azure without endpoint → a clear error (never a silently-broken URL)", () => {
  assert.throws(
    () =>
      resolveCloudTarget({
        provider: "azure",
        apiKey: "azure-secret",
        model: "dep",
        baseUrl: "",
        azureEndpoint: "",
        azureApiVersion: "2024-10-21",
      }),
    /azure_endpoint/
  );
});

test("custom base URL overrides the provider default (openai-compatible gateway)", () => {
  const t = resolveCloudTarget({
    provider: "openai",
    apiKey: "k",
    model: "gpt-4o",
    baseUrl: "https://my-gateway.example.com/v1/",
    azureEndpoint: "",
    azureApiVersion: "",
  });
  assert.equal(t.url, "https://my-gateway.example.com/v1/chat/completions");
});

// ── Honest per-doc language detection ───────────────────────────────────────────

test("detectLang: English text → 'en', Hebrew text → 'he', empty → null", () => {
  assert.equal(detectLang("In the Matter of: Joni Carter vs. Michel Carter"), "en");
  assert.equal(detectLang("שלום עולם זהו מסמך בעברית"), "he");
  assert.equal(detectLang(""), null);
  assert.equal(detectLang("   \n  "), null);
  // Pure digits/punctuation (no letters) → unknown, never fabricated.
  assert.equal(detectLang("12345 — 67.89"), null);
});

test("detectLang: a stray Hebrew name in an English doc stays 'en' (threshold, not any-hit)", () => {
  const mostlyEnglish =
    "This English contract names the vendor אורן once but is otherwise entirely English prose.";
  assert.equal(detectLang(mostlyEnglish), "en");
});
