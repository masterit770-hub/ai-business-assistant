// In-thread module resolve hook for the API route-handler tests.
//
// Route handlers import via the bundler-style "@/..." alias and from "next/server",
// neither of which raw Node resolves on its own. This hook (registered in-thread, so
// it also covers the node:test module-mock loader's own resolutions) maps:
//   • "@/x"          → "<repo>/src/x"  (+ the TS extension the imports omit)
//   • "next/server"  → its real file   (its package-exports map trips the ESM mock loader)
// so the REAL handler under test loads, with only its I/O seams mock.module()'d.
import { registerHooks, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";
import { statSync } from "node:fs";

const SRC = pathResolve(process.cwd(), "src");
const req = createRequire(pathResolve(process.cwd(), "package.json"));

// Resolve next/server ONCE, before the hook is live, so the hook never re-enters
// require.resolve (which would recurse through this same hook → stack overflow).
const NEXT_SERVER_URL = pathToFileURL(req.resolve("next/server")).href;

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function resolveWithExt(absPath) {
  const candidates = [
    absPath, absPath + ".ts", absPath + ".tsx", absPath + ".mts",
    pathResolve(absPath, "index.ts"), pathResolve(absPath, "index.tsx"),
  ];
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve(NEXT_SERVER_URL, context);
    }
    if (specifier.startsWith("@/")) {
      const abs = pathResolve(SRC, specifier.slice(2));
      const file = resolveWithExt(abs);
      if (file) return nextResolve(pathToFileURL(file).href, context);
      return nextResolve(pathToFileURL(abs).href, context);
    }
    return nextResolve(specifier, context);
  },
});
