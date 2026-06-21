// PDF → per-page text → chunks. Uses pdftotext (poppler) at BUILD time only, so
// no PDF-parsing dependency ships to the serverless runtime — the vector index is
// prebuilt JSON. Each chunk keeps its source doc + page number (the [P:doc#page]
// citation anchor).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type PdfChunk = { doc: string; page: number; text: string };

// Committed pre-extracted page text (so the deploy build doesn't need poppler).
// Produced by scripts/extract-pdf-text.mts on a machine that has pdftotext.
const PAGES_CACHE = join(process.cwd(), "data", "pdf-pages.json");
function cachedPages(doc: string): string[] | null {
  if (!existsSync(PAGES_CACHE)) return null;
  try {
    const all = JSON.parse(readFileSync(PAGES_CACHE, "utf8")) as Record<string, string[]>;
    return all[doc] ?? null;
  } catch {
    return null;
  }
}

/** Extract text per page using pdftotext's form-feed page separators. */
export function extractPages(pdfPath: string): string[] {
  const out = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // pdftotext separates pages with the form-feed character (\f).
  return out.split("\f").map((p) => p.replace(/​/g, "").trim());
}

/** Chunk a page into ~chunkChars windows on sentence/line boundaries. */
export function chunkPage(text: string, chunkChars = 900, overlap = 150): string[] {
  if (text.length <= chunkChars) return text.length ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > start + chunkChars / 2) end = lastBreak;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

// Some documents print their OWN pagination as "PAGE N – SECTION" headers (the
// Carter court file does: "PAGE 24 – FINAL JUDGMENT"). For those we cite the
// document's printed page number — the number a human verifies against the real
// PDF — NOT the physical pdftotext page. This re-segments the extracted text on
// those printed markers so a chunk's `page` is the document's own page (24), and
// the citation [P:family-court#24] resolves to the page the reader can open.
const PRINTED_PAGE_RE = /\bPAGE\s+(\d+)\b/gi;

export function splitByPrintedPages(allText: string): { page: number; text: string }[] | null {
  const matches = [...allText.matchAll(PRINTED_PAGE_RE)];
  if (matches.length < 3) return null; // not a printed-paginated doc
  const segments: { page: number; text: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const page = parseInt(matches[i][1], 10);
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? allText.length) : allText.length;
    const text = allText.slice(start, end).trim();
    if (text) segments.push({ page, text });
  }
  return segments;
}

/** Turn a PDF into citable chunks (doc + page + text). Prefers committed page
 *  text (data/pdf-pages.json) so a poppler-less build still works; falls back to
 *  pdftotext when the cache is absent. Documents with printed pagination are cited
 *  to their OWN page numbers (see splitByPrintedPages). */
export function pdfToChunks(pdfPath: string, doc: string): PdfChunk[] {
  const pages = cachedPages(doc) ?? extractPages(pdfPath);
  return pagesToChunks(pages, doc);
}

/** Turn already-extracted per-page text into citable chunks. Shared by the
 *  build-time path (pdftotext/cache) and the RUNTIME upload path (unpdf), so a
 *  freshly-uploaded PDF is chunked + cited by the exact same rules as a bundled
 *  one — printed pagination is honoured, otherwise cite by physical page. */
export function pagesToChunks(pages: string[], doc: string): PdfChunk[] {
  const chunks: PdfChunk[] = [];

  const printed = splitByPrintedPages(pages.join("\n"));
  if (printed) {
    for (const seg of printed) {
      for (const text of chunkPage(seg.text)) chunks.push({ doc, page: seg.page, text });
    }
    return chunks;
  }

  // Fallback: cite by physical page (e.g. the narrative story, which has no
  // printed pagination).
  pages.forEach((pageText, idx) => {
    const page = idx + 1;
    for (const text of chunkPage(pageText)) chunks.push({ doc, page, text });
  });
  return chunks;
}
