import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCloudConfig,
  getHipaaConfig,
  getModelMode,
  getSettings,
  setSetting,
  DEFAULTS,
} from "../../src/lib/engine/settings.ts";
import { resolveHipaaTarget } from "../../src/lib/engine/llm.ts";

// These drive the REAL settings layer (in-memory store in tests) + the REAL
// resolveHipaaTarget() the HIPAA path uses to build each request. So they prove the
// actual independent-slot + Azure-shape wiring — not a stub. The headline invariant:
// the HIPAA (Azure) key and the cloud key are SEPARATE slots that never collide,
// which is the exact bug Jenny hit (an Azure key overwriting the OpenAI key).

async function clearAll() {
  await setSetting("cloud_provider", "");
  await setSetting("cloud_api_key", "");
  await setSetting("hipaa_api_key", "");
  await setSetting("hipaa_endpoint", "");
  await setSetting("hipaa_api_version", "");
  await setSetting("hipaa_model", "");
  await setSetting("model_mode", "");
}

test("defaults: all hipaa_* keys default to '' (an unconfigured workspace is byte-identical to today)", () => {
  assert.equal(DEFAULTS.hipaa_api_key, "");
  assert.equal(DEFAULTS.hipaa_endpoint, "");
  assert.equal(DEFAULTS.hipaa_api_version, "");
  assert.equal(DEFAULTS.hipaa_model, "");
});

test("hipaa key persists INDEPENDENTLY of the cloud key (refutes the overwrite bug)", async () => {
  await clearAll();
  await setSetting("cloud_api_key", "CLOUD");
  await setSetting("hipaa_api_key", "HIPAA");
  const cloud = await getCloudConfig();
  const hipaa = await getHipaaConfig();
  // Two independent slots: setting one NEVER clobbers the other.
  assert.equal(cloud.apiKey, "CLOUD");
  assert.equal(hipaa.apiKey, "HIPAA");
  await clearAll();
});

test("WRITE-ONLY: getSettings() exposes hipaa_api_key_set (bool), NEVER the secret", async () => {
  await clearAll();
  await setSetting("hipaa_api_key", "the-secret");
  const s = await getSettings();
  assert.equal(s.hipaa_api_key_set, true);
  // The raw secret is absent from the admin payload entirely…
  assert.equal((s as Record<string, unknown>).hipaa_api_key, undefined);
  // …and never appears when serialized like the API would.
  assert.ok(!JSON.stringify(s).includes("the-secret"));

  await setSetting("hipaa_api_key", "");
  const s2 = await getSettings();
  assert.equal(s2.hipaa_api_key_set, false);
  await clearAll();
});

test("resolveHipaaTarget → Azure deployment URL + api-key header (NOT Bearer)", () => {
  const t = resolveHipaaTarget({
    apiKey: "azure-secret",
    endpoint: "https://res.openai.azure.com/",
    apiVersion: "2024-10-21",
    model: "my-dep",
  });
  assert.equal(
    t.url,
    "https://res.openai.azure.com/openai/deployments/my-dep/chat/completions?api-version=2024-10-21"
  );
  assert.equal(t.headers["api-key"], "azure-secret");
  assert.equal(t.headers["Authorization"], undefined);
  assert.equal(t.provider, "azure-hipaa");
  assert.equal(t.model, "my-dep");
});

test("resolveHipaaTarget defaults the api-version when blank", () => {
  const t = resolveHipaaTarget({
    apiKey: "k",
    endpoint: "https://res.openai.azure.com",
    apiVersion: "",
    model: "dep",
  });
  assert.match(t.url, /api-version=2024-10-21$/);
});

test("resolveHipaaTarget fails CLOSED with no env leak (never the DeepSeek env Bearer target)", () => {
  // Even with an env key present, an unconfigured HIPAA mode must THROW — it must
  // never silently route PHI-intent traffic to the non-BAA env backend.
  const prev = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "env-key";
  try {
    // missing endpoint
    assert.throws(
      () => resolveHipaaTarget({ apiKey: "k", endpoint: "", apiVersion: "", model: "dep" }),
      /not.*configured.*endpoint|endpoint is set/i
    );
    // missing model
    assert.throws(
      () =>
        resolveHipaaTarget({
          apiKey: "k",
          endpoint: "https://res.openai.azure.com",
          apiVersion: "",
          model: "",
        }),
      /deployment name is set/i
    );
    // missing key
    assert.throws(
      () =>
        resolveHipaaTarget({
          apiKey: "",
          endpoint: "https://res.openai.azure.com",
          apiVersion: "",
          model: "dep",
        }),
      /key/i
    );
  } finally {
    if (prev === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = prev;
  }
});

test("getModelMode accepts hipaa, and fails safe to cloud on garbage", async () => {
  await setSetting("model_mode", "hipaa");
  assert.equal(await getModelMode(), "hipaa");
  await setSetting("model_mode", "garbage");
  assert.equal(await getModelMode(), "cloud");
  await setSetting("model_mode", ""); // reset
});

test("getSettings exposes the non-secret hipaa_* config fields", async () => {
  await clearAll();
  await setSetting("hipaa_endpoint", "https://res.openai.azure.com");
  await setSetting("hipaa_api_version", "2024-10-21");
  await setSetting("hipaa_model", "my-dep");
  const s = await getSettings();
  assert.equal(s.hipaa_endpoint, "https://res.openai.azure.com");
  assert.equal(s.hipaa_api_version, "2024-10-21");
  assert.equal(s.hipaa_model, "my-dep");
  await clearAll();
});
