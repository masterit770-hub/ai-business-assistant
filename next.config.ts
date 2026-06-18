import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the dev-tools overlay button so demo screenshots stay clean.
  devIndicators: false,

  // Native/server-only packages stay external (loaded from node_modules at runtime,
  // not parsed by the bundler). The local embedder (transformers.js + onnxruntime)
  // lives ONLY in the dedicated /api/embed function (see the split below).
  serverExternalPackages: [
    "better-sqlite3",
    "@xenova/transformers",
    "onnxruntime-node",
    "unpdf",
    "@google/genai",
  ],

  outputFileTracingIncludes: {
    // The SQL/answer + ingest functions need the prebuilt index + corpus.
    "/api/ask": ["./data-index/**/*", "./data/**/*"],
    "/api/ingest": ["./data-index/**/*", "./data/**/*"],
    "/api/documents": ["./data-index/**/*", "./data/**/*"],
    // The embedder loads ort-wasm-simd.wasm from the transformers dist at runtime —
    // make sure it ships into this function (it's loaded dynamically, not traceable).
    "/api/embed": [
      "./node_modules/.pnpm/@xenova+transformers@*/node_modules/@xenova/transformers/dist/*.wasm",
    ],
  },

  // FUNCTION SPLIT to fit Vercel's per-function size limit (the combined heavy
  // externals — transformers + onnxruntime-web WASM + sqlite + genai — overflow one
  // function: patch_build_4xx). The local embedder is isolated to /api/embed; every
  // OTHER function calls it over HTTP and must NOT bundle the embed deps. So exclude
  // transformers + onnxruntime-* from all the non-embed functions. (/api/embed keeps
  // them — it's the one function that actually runs the model.)
  outputFileTracingExcludes: {
    "/api/ask": [
      "./node_modules/**/@xenova/transformers/**",
      "./node_modules/**/onnxruntime-node/**",
      "./node_modules/**/onnxruntime-web/**",
      "./node_modules/**/sharp/**",
    ],
    "/api/ingest": [
      "./node_modules/**/@xenova/transformers/**",
      "./node_modules/**/onnxruntime-node/**",
      "./node_modules/**/onnxruntime-web/**",
      "./node_modules/**/sharp/**",
    ],
    "/api/documents": [
      "./node_modules/**/@xenova/transformers/**",
      "./node_modules/**/onnxruntime-node/**",
      "./node_modules/**/onnxruntime-web/**",
      "./node_modules/**/sharp/**",
    ],
  },
};

export default nextConfig;
