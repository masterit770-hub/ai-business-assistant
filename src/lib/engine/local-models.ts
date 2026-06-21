// Pure helpers for the "detect models on your box" picker (Settings → Model →
// Local). The owner stores an OpenAI-compatible endpoint (e.g.
// http://localhost:11434/v1) in `local_endpoint`. Ollama lists the models that
// are actually pulled at its NATIVE API: GET <base>/api/tags — NOT the /v1
// OpenAI path. So we derive the base by stripping a trailing /v1 + slashes, then
// extract the model names from the tags response.
//
// Both helpers are PURE (no network, no I/O) so the route's logic is unit-testable
// without a running Ollama. The route does the actual fetch; these just shape the
// URL and parse the body.

/**
 * Derive the Ollama base URL from the stored OpenAI-compatible `local_endpoint`.
 * Strips a single trailing "/v1" (case-insensitive) and any trailing slashes, so
 * `http://localhost:11434/v1` → `http://localhost:11434`. A blank/whitespace
 * endpoint → "" (caller treats that as "no endpoint set"). Never throws.
 */
export function deriveOllamaBase(endpoint: string): string {
  let base = (endpoint ?? "").trim();
  if (!base) return "";
  // Drop trailing slashes first so a "…/v1/" form still matches the /v1 strip.
  base = base.replace(/\/+$/, "");
  // Strip a single trailing /v1 segment (the OpenAI-compat suffix).
  base = base.replace(/\/v1$/i, "");
  // Re-trim any slashes the strip may have exposed (e.g. "http://h//v1").
  base = base.replace(/\/+$/, "");
  return base;
}

/** The Ollama /api/tags URL for a given stored endpoint, or "" if no endpoint. */
export function ollamaTagsUrl(endpoint: string): string {
  const base = deriveOllamaBase(endpoint);
  return base ? `${base}/api/tags` : "";
}

/**
 * Extract the model names from an Ollama /api/tags response body. Ollama returns
 * `{ models: [ { name: "qwen2.5:1.5b", ... }, ... ] }`. We defensively accept any
 * unknown shape and return only the well-formed, non-empty string names (deduped,
 * original order). A missing/garbage body → []. Never throws.
 */
export function extractModelNames(body: unknown): string[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const name = (m as { name?: unknown })?.name;
    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        names.push(trimmed);
      }
    }
  }
  return names;
}
