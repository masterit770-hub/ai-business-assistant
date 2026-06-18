// Citation tokens — the grounding anchors.
// Structured (SQLite) rows  → [S:<table>#<id>]
// PDF chunks                → [P:<doc>#<page>]
// The two namespaces stay SEPARATE — there is no join between structured and
// document domains (see docs/architecture.md). A citation only "resolves" if a
// piece of evidence with that exact id/page was actually retrieved this turn.

export type SqlCitation = { kind: "sql"; table: string; id: number; token: string };
export type PdfCitation = { kind: "pdf"; doc: string; page: number; token: string };
export type Citation = SqlCitation | PdfCitation;

export function sqlToken(table: string, id: number): string {
  return `[S:${table}#${id}]`;
}
export function pdfToken(doc: string, page: number): string {
  return `[P:${doc}#${page}]`;
}

const TOKEN_RE = /\[(S|P):([^\]#]+)#(\d+)\]/g;

/** Extract every citation token that appears in answer text. */
export function extractCitationTokens(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(TOKEN_RE)) out.push(m[0]);
  return out;
}

/** Build the set of tokens that the retrieved evidence makes resolvable. */
export function resolvableTokenSet(evidence: {
  rows: { table: string; id: number }[];
  chunks: { doc: string; page: number }[];
}): Set<string> {
  const s = new Set<string>();
  for (const r of evidence.rows) s.add(sqlToken(r.table, r.id));
  for (const c of evidence.chunks) s.add(pdfToken(c.doc, c.page));
  return s;
}
