// The BUNDLED corpus — the real source documents the engine answers from, derived
// from the ACTUAL loaded index/manifest (not a hardcoded list). These are the
// sources behind the [P:doc#page] (PDF) and [S:table#id] (structured) citations.
// The dashboard lists these as the demo's included data, so what the user SEES in
// Documents matches what the assistant can ANSWER from.
import { getVectors, loadReport } from "./retrieval.ts";
import { DOCUMENTS } from "./documents.ts";
import { TABLES } from "./schema.ts";
import { deletedSourceIds } from "./deleted-sources.ts";

// A document's primary language, derived HONESTLY from its real indexed text (not
// fabricated). "en"/"he" when we can tell; null when unknown → the UI omits the chip.
export type DocLang = "en" | "he" | null;

export type BundledSource = {
  doc: string; // citation namespace id (e.g. "family-court", "contracts")
  label: string; // human label
  kind: "document" | "structured";
  detail: string; // e.g. "PDF · 24 pages" or "Table · 760 rows"
  lang: DocLang; // primary language of a document source (null for structured/unknown)
};

// Hebrew Unicode block. We classify a document as Hebrew when a meaningful share of
// its letters are Hebrew (a stray Hebrew name in an English file shouldn't flip it),
// else English. Returns null when there's no text to judge.
const HEBREW_RE = /[֐-׿]/g;
const LETTER_RE = /[A-Za-z֐-׿]/g;
export function detectLang(text: string): DocLang {
  if (!text || !text.trim()) return null;
  const letters = (text.match(LETTER_RE) ?? []).length;
  if (letters === 0) return null;
  const hebrew = (text.match(HEBREW_RE) ?? []).length;
  return hebrew / letters >= 0.2 ? "he" : "en";
}

/**
 * The distinct bundled sources actually present in the loaded index:
 *  - PDF documents: the distinct `doc` ids in the vector index, labelled from the
 *    DOCUMENTS manifest (page count = distinct pages in the index).
 *  - Structured tables: each schema table that has rows in the bundled SQLite
 *    (row count from the loader's report), labelled from the TABLES manifest.
 */
export function bundledSources(): BundledSource[] {
  const out: BundledSource[] = [];
  // Workspace-level soft-delete: a bundled doc/table an admin hid is excluded from
  // the list (so what the dashboard SHOWS matches what the assistant can ANSWER from).
  // Empty set (nothing hidden / Supabase off) → the full bundled list, as before.
  const hidden = deletedSourceIds();

  // ── PDF documents (from the actual vector index) ──────────────────────────
  try {
    const idx = getVectors();
    const pages = new Map<string, Set<number>>();
    // Accumulate each doc's real indexed text so we can detect its language honestly.
    const texts = new Map<string, string[]>();
    for (const r of idx.records) {
      if (!pages.has(r.doc)) pages.set(r.doc, new Set());
      pages.get(r.doc)!.add(r.page);
      if (!texts.has(r.doc)) texts.set(r.doc, []);
      texts.get(r.doc)!.push(r.text ?? "");
    }
    for (const [doc, pageSet] of pages) {
      if (hidden.has(doc)) continue; // admin-hidden bundled doc
      const label = DOCUMENTS.find((d) => d.doc === doc)?.label ?? doc;
      const n = pageSet.size;
      const lang = detectLang((texts.get(doc) ?? []).join(" "));
      out.push({ doc, label, kind: "document", detail: `PDF · ${n} page${n === 1 ? "" : "s"}`, lang });
    }
  } catch {
    // index not built (dev) — skip the document sources rather than crash.
  }

  // ── Structured tables (from the loaded SQLite + the schema labels) ────────
  try {
    const report = loadReport(); // [{ table, rows, malformed_cells }]
    const rowsOf = new Map(report.map((r) => [r.table, r.rows]));
    for (const t of TABLES) {
      if (hidden.has(t.table)) continue; // admin-hidden bundled table
      const rows = rowsOf.get(t.table);
      if (!rows) continue; // only tables that actually loaded
      out.push({
        doc: t.table,
        label: t.label,
        kind: "structured",
        detail: `Table · ${rows.toLocaleString("en-US")} rows`,
        lang: null, // structured tables aren't language-tagged
      });
    }
  } catch {
    // SQLite not loaded (dev) — skip the structured sources.
  }

  return out;
}
