// Build-time prep so the embed function (transformers.js local embedder) fits
// Vercel's serverless size limit AND never eagerly loads the native onnxruntime-node
// .so (which can't ship into the function and isn't needed — we force the WASM
// backend, see src/lib/engine/embeddings.ts).
//
// Two jobs, both idempotent + best-effort (a missing path is fine):
//  1. NEUTER onnxruntime-node's eager native load. transformers.js statically
//     `import`s onnxruntime-node; its binding.js does
//        require('../bin/.../onnxruntime_binding.node')  → dlopen libonnxruntime.so
//     at module-load, BEFORE the WASM backend is selected → "cannot open shared
//     object file" on Vercel. We rewrite binding.js to require the native addon
//     LAZILY (only if something touches it — nothing does, since WASM runs), so the
//     import resolves with zero native load.
//  2. SHRINK: delete the heavy stuff that bloats the function past the limit —
//     onnxruntime-node's native binaries (all platforms; the WASM path needs none),
//     onnxruntime-web's + transformers' redundant non-simd/threaded wasm + source
//     maps, and sharp (transformers' optional image dep we never use).
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NM = "node_modules";

// Resolve every physical copy of a package (pnpm nests real files under
// .pnpm/<pkg>@<ver>/node_modules/<pkg>; there's also a top-level symlink).
function pkgDirs(name) {
  const out = [];
  const top = join(NM, name);
  if (existsSync(top)) out.push(top);
  const pnpm = join(NM, ".pnpm");
  if (existsSync(pnpm)) {
    const prefix = name.replace("/", "+") + "@";
    for (const d of readdirSync(pnpm)) {
      if (d.startsWith(prefix)) {
        const real = join(pnpm, d, "node_modules", name);
        if (existsSync(real)) out.push(real);
      }
    }
  }
  return out;
}

function rm(p) {
  try {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  } catch {}
}

const REDUNDANT_WASM = new Set([
  "ort-wasm-threaded.wasm",
  "ort-wasm.wasm",
  "ort-wasm-simd-threaded.wasm",
]);
function trimDist(dir) {
  const dist = join(dir, "dist");
  if (!existsSync(dist)) return;
  for (const f of readdirSync(dist)) {
    if (f.endsWith(".map") || REDUNDANT_WASM.has(f)) rm(join(dist, f));
  }
}

// 1. Neuter onnxruntime-node's binding.js (lazy require → no eager native load).
const LAZY_BINDING = `"use strict";
// Patched at build (scripts/prune-onnx.mjs): the native addon loads LAZILY, only if
// actually used. We force transformers.js onto the WASM backend, so it never is —
// this stops the eager 'import onnxruntime-node' from dlopen'ing libonnxruntime.so
// (which isn't shipped into the Vercel function).
Object.defineProperty(exports, "__esModule", { value: true });
let _b = null;
function load() {
  if (!_b) _b = require(\`../bin/napi-v3/\${process.platform}/\${process.arch}/onnxruntime_binding.node\`);
  return _b;
}
exports.binding = new Proxy({}, { get: (_t, prop) => load()[prop] });
`;
for (const dir of pkgDirs("onnxruntime-node")) {
  const binding = join(dir, "dist", "binding.js");
  if (existsSync(binding)) {
    try {
      writeFileSync(binding, LAZY_BINDING);
    } catch {}
  }
  rm(join(dir, "bin")); // native binaries — unused on the WASM path
}

// 2. onnxruntime-web + @xenova/transformers: drop redundant wasm + maps.
for (const dir of pkgDirs("onnxruntime-web")) trimDist(dir);
for (const dir of pkgDirs("@xenova/transformers")) trimDist(dir);

// NOTE: do NOT remove sharp — transformers' src/utils/image.js imports it eagerly at
// module load (`import sharp from 'sharp'`), so removing it breaks the whole import.
// We only embed text, but the import must resolve.

console.log("[prune-onnx] neutered onnxruntime-node binding + stripped redundant wasm/maps");
