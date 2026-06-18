// The BUNDLED corpus — the real source documents the engine answers from, derived
// from the ACTUAL loaded index/manifest (not a hardcoded list). These are the
// sources behind the [P:doc#page] (PDF) and [S:table#id] (structured) citations.
// The dashboard lists these as the demo's included data, so what the user SEES in
// Documents matches what the assistant can ANSWER from.
import { getVectors, loadReport } from "./retrieval.ts";
import { DOCUMENTS } from "./documents.ts";
import { TABLES } from "./schema.ts";

export type BundledSource = {
  doc: string; // citation namespace id (e.g. "family-court", "contracts")
  label: string; // human label
  kind: "document" | "structured";
  detail: string; // e.g. "PDF · 24 pages" or "Table · 760 rows"
};

/**
 * The distinct bundled sources actually present in the loaded index:
 *  - PDF documents: the distinct `doc` ids in the vector index, labelled from the
 *    DOCUMENTS manifest (page count = distinct pages in the index).
 *  - Structured tables: each schema table that has rows in the bundled SQLite
 *    (row count from the loader's report), labelled from the TABLES manifest.
 */
export function bundledSources(): BundledSource[] {
  const out: BundledSource[] = [];

  // ── PDF documents (from the actual vector index) ──────────────────────────
  try {
    const idx = getVectors();
    const pages = new Map<string, Set<number>>();
    for (const r of idx.records) {
      if (!pages.has(r.doc)) pages.set(r.doc, new Set());
      pages.get(r.doc)!.add(r.page);
    }
    for (const [doc, pageSet] of pages) {
      const label = DOCUMENTS.find((d) => d.doc === doc)?.label ?? doc;
      const n = pageSet.size;
      out.push({ doc, label, kind: "document", detail: `PDF · ${n} page${n === 1 ? "" : "s"}` });
    }
  } catch {
    // index not built (dev) — skip the document sources rather than crash.
  }

  // ── Structured tables (from the loaded SQLite + the schema labels) ────────
  try {
    const report = loadReport(); // [{ table, rows, malformed_cells }]
    const rowsOf = new Map(report.map((r) => [r.table, r.rows]));
    for (const t of TABLES) {
      const rows = rowsOf.get(t.table);
      if (!rows) continue; // only tables that actually loaded
      out.push({
        doc: t.table,
        label: t.label,
        kind: "structured",
        detail: `Table · ${rows.toLocaleString("en-US")} rows`,
      });
    }
  } catch {
    // SQLite not loaded (dev) — skip the structured sources.
  }

  return out;
}
