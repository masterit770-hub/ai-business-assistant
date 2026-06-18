// The ACTUAL local embedder (transformers.js → onnxruntime-web/WASM). This module
// pulls in the heavy embed deps (transformers + onnxruntime-web), so it is imported
// ONLY by the dedicated /api/embed function — never by /api/ask — which keeps those
// deps out of the larger /api/ask bundle (otherwise the combined externals blow
// Vercel's per-function size limit, patch_build_4xx at deploy).
//
// e5 models expect "query: " / "passage: " prefixes; we apply them so EN and HE land
// in the same space.
let _extractor: any = null;

// transformers.js v2.17 selects its ONNX backend at module-load via
// process.release.name === 'node' → onnxruntime-node (native .so, can't ship to a
// Vercel function). Force the WASM backend by masking process.release across the
// import — VERIFIED byte-identical embeddings (same Xenova/multilingual-e5-small), so
// the prebuilt vectors.json still matches (no re-index). The build prune
// (scripts/prune-onnx.mjs) neuters onnxruntime-node's eager binding load too.
async function importTransformersOnWasm() {
  const realRelease = process.release;
  try {
    Object.defineProperty(process, "release", {
      value: { ...realRelease, name: "nucleus-wasm" },
      configurable: true,
    });
    return await import("@xenova/transformers");
  } finally {
    Object.defineProperty(process, "release", { value: realRelease, configurable: true });
  }
}

async function getExtractor() {
  if (_extractor) return _extractor;
  const { pipeline, env } = await importTransformersOnWasm();
  try {
    env.backends.onnx.wasm.numThreads = 1; // serverless: no SharedArrayBuffer threading
    // On Vercel the default wasmPaths (a CDN / RUNNING_LOCALLY guess) doesn't resolve
    // → "no available backend found / ENOENT ort-wasm-simd.wasm". Point ORT-web at the
    // .wasm we ship inside the transformers package (kept by the build prune). Resolve
    // the package dir so it works regardless of the pnpm path.
    const req = (await import("node:module")).createRequire(import.meta.url);
    const pkgJson = req.resolve("@xenova/transformers/package.json");
    const distDir = pkgJson.replace(/package\.json$/, "dist/");
    env.backends.onnx.wasm.wasmPaths = distDir;
  } catch {
    /* shape varies by version — non-fatal; fall back to defaults */
  }
  _extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small");
  return _extractor;
}

export async function embedText(text: string, prefix: "query" | "passage"): Promise<number[]> {
  const extractor = await getExtractor();
  const out = await extractor(`${prefix}: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}
