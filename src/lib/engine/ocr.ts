// Our own OCR for SCANNED PDFs — no Gemini, no external OCR API. The text path
// (unpdf) handles born-digital PDFs; this fills the gap for image-only/scanned pages
// where unpdf returns ~no text. We render those pages to images and run Tesseract.js
// (eng + heb) locally.
//
// HONESTY ABOUT SERVERLESS: this is BEST-EFFORT and BOUNDED. Rendering a PDF page to
// a raster + the Tesseract WASM core are HEAVY (large WASM + trained-data downloads,
// significant CPU/memory). On a constrained Vercel function they may not run — so the
// whole module is wrapped so that if rendering or OCR can't initialize, it logs a
// clear warning and returns empty for that page. Ingest NEVER depends on OCR
// succeeding: the text path is the contract; OCR is enrichment.
//
// BOUNDS (env-overridable):
//   OCR_MAX_PAGES   — at most this many low-text pages are OCR'd (default 5)
//   OCR_TIME_MS     — overall wall-clock budget across all OCR'd pages (default 60s)
// A page that exceeds the budget (or fails) yields "" — never an error.

// A page is a likely SCAN (OCR candidate) when its extracted text layer is
// effectively empty. We measure the non-whitespace character count: a born-digital
// page has hundreds+; a scan's text layer is 0 or a few stray glyphs. Pure +
// exported so the low-text→OCR decision is unit-tested without a PDF/Tesseract.
//
// `minChars` is the threshold: at or below it, the page is treated as a scan needing
// OCR. 12 catches truly empty/near-empty pages while not OCR'ing a sparse-but-real
// text page (a title page with a line or two still has more than this once you count).
export function shouldOcrPage(pageText: string, minChars = 12): boolean {
  const nonWhitespace = (pageText ?? "").replace(/\s+/g, "").length;
  return nonWhitespace <= minChars;
}

// Which page indices (0-based) of a document need OCR, given the per-page text the
// text layer yielded. Capped at `maxPages` (the cheapest pages-first order is just
// document order — we don't reorder). Pure + exported for testing.
export function pagesNeedingOcr(
  pageTexts: string[],
  maxPages: number,
  minChars = 12
): number[] {
  const out: number[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    if (shouldOcrPage(pageTexts[i], minChars)) out.push(i);
    if (out.length >= maxPages) break;
  }
  return out;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * OCR the low-text pages of a PDF buffer, returning a map of pageIndex(0-based) → text.
 * BEST-EFFORT + BOUNDED + NON-THROWING. `pageTexts` is the unpdf text per page (used to
 * decide which pages are scans). Pages with sufficient text are skipped. If the render
 * lib or Tesseract can't run in this environment, returns whatever it managed (often
 * {}) after logging — it NEVER throws.
 */
export async function ocrLowTextPages(
  pdfBuffer: Uint8Array,
  pageTexts: string[]
): Promise<Record<number, string>> {
  const maxPages = envInt("OCR_MAX_PAGES", 5);
  const timeBudgetMs = envInt("OCR_TIME_MS", 60_000);
  const targets = pagesNeedingOcr(pageTexts, maxPages);
  if (targets.length === 0) return {};

  const out: Record<number, string> = {};
  const startedAt = Date.now();

  // Render the target pages to PNG. pdf-to-png-converter is pure-JS (bundled pdfjs +
  // an embedded canvas), so it ships to serverless without a native build — but it's
  // heavy, so a failure to import/render is caught and degrades to "no OCR".
  // The converter returns { pageNumber, content?: Buffer } per page (content optional
  // in its types). We keep a tolerant local shape + skip any page with no buffer.
  // CRITICAL: unpdf (run FIRST, in extractPdfPages) bundles pdf.js 4.6.82 and pollutes
  // the PROCESS-GLOBAL worker (`globalThis.pdfjsWorker`). pdf-to-png-converter bundles a
  // DIFFERENT pdf.js (6.0.227); when it reads that stale global it dies with
  // "The API version 6.0.227 does not match the Worker version 4.6.82" — the render throws,
  // OCR yields nothing, and a scanned PDF comes back "no extractable text" (the client's
  // "scanned PDF wasn't read" bug). Fix: save + clear the global around the render so the
  // converter's pdf.js sets up its OWN matching worker, then restore it for any later unpdf.
  const glob = globalThis as Record<string, unknown>;
  const savedWorker = glob.pdfjsWorker;
  const savedGWO = glob.GlobalWorkerOptions;
  glob.pdfjsWorker = undefined;
  let pngPages: { pageNumber: number; content?: Buffer }[];
  try {
    const { pdfToPng } = await import("pdf-to-png-converter");
    pngPages = await pdfToPng(Buffer.from(pdfBuffer), {
      // 1-based page numbers; targets are 0-based.
      pagesToProcess: targets.map((i) => i + 1),
      viewportScale: 2.0, // upscale for legible OCR without exploding memory
    });
  } catch (e) {
    console.warn(
      "[ocr] page rendering unavailable in this environment — scanned pages will have " +
        "no extracted text (text PDFs + CSV/XLSX are unaffected). Detail: " +
        (e instanceof Error ? e.message : String(e))
    );
    return out;
  } finally {
    // RESTORE unpdf's global worker so a later warm-process unpdf call in the same
    // instance isn't left with a wiped global (the converter set up its own during the
    // render above).
    glob.pdfjsWorker = savedWorker;
    glob.GlobalWorkerOptions = savedGWO;
  }

  // Tesseract worker (eng + heb — the project's Hebrew-readiness seam). Created once,
  // reused across pages, terminated at the end. If it can't initialize (WASM/lang
  // data unfetchable on a sealed function), we log + return what we have.
  type OcrWorker = {
    recognize: (img: Buffer) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<unknown>;
  };
  let worker: OcrWorker;
  try {
    const { createWorker } = await import("tesseract.js");
    // eng+heb covers the corpus + the Hebrew Q&A requirement. cachePath "/tmp" — on a
    // serverless function the project dir is READ-ONLY, so the default cwd cache would fail
    // to write the trained-data; /tmp is the only writable dir.
    worker = (await createWorker(["eng", "heb"], 1, {
      cachePath: "/tmp",
    })) as unknown as OcrWorker;
  } catch (e) {
    console.warn(
      "[ocr] Tesseract unavailable in this environment — scanned pages will have no " +
        "extracted text. Detail: " +
        (e instanceof Error ? e.message : String(e))
    );
    return out;
  }

  try {
    for (const png of pngPages) {
      if (Date.now() - startedAt > timeBudgetMs) {
        console.warn(
          `[ocr] time budget (${timeBudgetMs}ms) reached after ${Object.keys(out).length} page(s) — ` +
            "remaining scanned pages left un-OCR'd (best-effort)."
        );
        break;
      }
      if (!png.content) continue; // the converter yielded no buffer for this page
      try {
        const { data } = await worker.recognize(png.content);
        const text = (data?.text ?? "").replace(/​/g, "").trim();
        if (text) out[png.pageNumber - 1] = text; // back to 0-based
      } catch (e) {
        console.warn(
          `[ocr] page ${png.pageNumber} OCR failed (skipped): ` +
            (e instanceof Error ? e.message : String(e))
        );
      }
    }
  } finally {
    try {
      await worker.terminate();
    } catch {
      /* terminate is best-effort */
    }
  }

  return out;
}
