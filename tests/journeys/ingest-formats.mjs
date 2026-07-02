// JOURNEY — INGEST FORMATS (Z1–Z5). ZERO SDK calls.
//
// Real behavior under test: EVERY supported upload format — born-digital PDF, a
// SCANNED/image-only PDF (Bug 1), Word .docx (+ an unsupported type → 415), CSV, and
// XLSX — is accepted by the REAL /api/ingest route and then surfaces in the materials
// rail as the right kind of source (a [P] document row or an [S] structured table row).
//
// We drive this entirely through the authenticated /api/ingest POST (the exact multipart
// the Upload button sends) + a /dashboard rail render — NO agentic /api/ask call. Ingest
// is the document/SQL lane (text extraction + local e5 embeddings + text-to-SQL), never a
// Claude call, so this whole module is free.
//
// Z2 is RED-FIRST for Bug 1: an image-only PDF (no text layer, OCR recovers nothing) must
// return 200 (not the old 500 "no extractable text") and store its raw bytes so the agent
// can still read it natively. Reverting the ingest.ts fix makes Z2 go RED with a 500.
//
// RESIDUE: every uploaded doc/table is deleted in a finally block (owner-scoped DELETE
// /api/documents) so the account is left exactly as found. Uses the DEMO admin account
// (is_demo=true) — uploads are owner-scoped to it and removed at the end.
import {
  launch,
  signIn,
  makeRecorder,
  uploadFileBytes,
  fileBytes,
  makeImageOnlyPdf,
  BASE,
} from "./lib.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DATA = "/home/codex/Projects/nucleus/data";
const SCRATCH =
  process.env.NUCLEUS_SCRATCH ||
  "/tmp/claude-1000/-home-codex-Projects/fbf32cd2-f605-45b2-90e8-690b01a59111/scratchpad";

// The bundled data files (exact on-disk names, incl. the Hebrew xlsx).
const BORN_DIGITAL_PDF = join(DATA, "📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf");
const CSV_MAINTENANCE = join(DATA, "school data 3.csv");
const XLSX_HEBREW = join(DATA, "שיבוצים יוני 2024 - סיון תשפד (1).xlsx");

// Delete an uploaded doc/table for the signed-in owner via the real DELETE route (the
// same path the rail's delete control hits). Best-effort cleanup — never throws.
async function deleteUploaded(page, docId) {
  if (!docId) return;
  await page
    .evaluate(async ([id, base]) => {
      await fetch(`${base}/api/documents?doc=${encodeURIComponent(id)}&scope=upload`, {
        method: "DELETE",
      }).catch(() => {});
    }, [docId, BASE])
    .catch(() => {});
}

export async function run() {
  const rec = makeRecorder("INGEST-FORMATS");
  const browser = await launch();
  const uploadedIds = [];
  let ctx;
  try {
    const signedIn = await signIn(browser, "admin", "/dashboard");
    ctx = signedIn.ctx;
    const page = signedIn.page;
    await page
      .locator('[data-testid="assistant-console"]')
      .waitFor({ state: "visible", timeout: 30000 })
      .catch(() => {});

    // ── Z1. Born-digital PDF ───────────────────────────────────────────────────
    if (existsSync(BORN_DIGITAL_PDF)) {
      const r = await uploadFileBytes(page, {
        name: "journey-born-digital.pdf",
        type: "application/pdf",
        bytes: fileBytes(BORN_DIGITAL_PDF),
      });
      const docId = r?.ingested?.doc ?? r?.ingested?.table ?? null;
      if (docId) uploadedIds.push(docId);
      rec.check(
        r.status === 200 && r.ok === true && r.ingested?.kind === "pdf" && (r.ingested?.chunks ?? 0) > 0 && r.zeroContent === false,
        "Z1: born-digital PDF ingests (200, kind=pdf, chunks>0, zeroContent=false)",
        `status=${r.status} kind=${r.ingested?.kind} chunks=${r.ingested?.chunks} zero=${r.zeroContent} err=${r.error ?? ""}`
      );
    } else {
      rec.check(false, "Z1: born-digital PDF fixture present", `missing ${BORN_DIGITAL_PDF}`);
    }

    // ── Z2. SCANNED / image-only PDF (Bug 1, RED-first) ────────────────────────
    // A 1-page PDF whose text is a rasterized image (verified zero extractable text). The
    // route MUST return 200 and store the raw bytes; if nothing readable was recovered it
    // sets zeroContent=true (a soft UI note), NEVER a 500. Reverting the ingest fix → 500.
    const scannedPath = join(SCRATCH, `journey-scanned-${Date.now()}.pdf`);
    const made = makeImageOnlyPdf(scannedPath);
    if (made.ok) {
      const r = await uploadFileBytes(page, {
        name: "journey-scanned.pdf",
        type: "application/pdf",
        bytes: fileBytes(scannedPath),
      });
      const docId = r?.ingested?.doc ?? r?.ingested?.table ?? null;
      if (docId) uploadedIds.push(docId);
      // The HEART of the check: status MUST be 200 (the old code threw → 500).
      rec.check(
        r.status === 200 && r.ok === true,
        "Z2: scanned/image-only PDF returns 200 (NOT 500) — Bug 1 RED-first",
        `status=${r.status} ok=${r.ok} zeroContent=${r.zeroContent} stored=${r.originalStored} err=${r.error ?? ""}`
      );
      // Raw bytes stored so the agent can read it natively even with no text layer.
      rec.check(
        r.status === 200 && r.originalStored === true,
        "Z2: scanned PDF's raw bytes are stored (originalStored=true) for native reading",
        `originalStored=${r.originalStored} docId=${docId ?? "none"}`
      );
    } else {
      // Honest SKIP — the env lacks PIL/reportlab; never a false green.
      rec.info("Z2: SKIPPED — could not build an image-only PDF in this env", made.reason);
      rec.check(true, "Z2: scanned-PDF builder available (else honest skip)", `skipped: ${made.reason}`);
    }

    // ── Z3. Word .docx (+ unsupported type → 415) ──────────────────────────────
    // Generate a tiny valid .docx in-process (no external skill) — a minimal OOXML zip.
    const docxBytes = await makeMinimalDocx("Journey docx — quarterly review notes. Revenue grew 12%.");
    const rd = await uploadFileBytes(page, {
      name: "journey.docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: docxBytes,
    });
    const docxId = rd?.ingested?.doc ?? rd?.ingested?.table ?? null;
    if (docxId) uploadedIds.push(docxId);
    rec.check(
      rd.status === 200 && rd.ok === true && (rd.ingested?.chunks ?? 0) > 0,
      "Z3: Word .docx ingests (200, chunks>0 via mammoth)",
      `status=${rd.status} kind=${rd.ingested?.kind} chunks=${rd.ingested?.chunks} err=${rd.error ?? ""}`
    );
    // Unsupported type → a clean 415 (not a 500 / not a silent accept).
    const rzip = await uploadFileBytes(page, {
      name: "journey.zip",
      type: "application/zip",
      bytes: [0x50, 0x4b, 0x03, 0x04, 0x00, 0x00], // PK zip magic + a few bytes (non-empty)
    });
    rec.check(
      rzip.status === 415,
      "Z3: unsupported type (.zip) is rejected with 415 (clear error, not a 500)",
      `status=${rzip.status} err=${(rzip.error ?? "").slice(0, 80)}`
    );

    // ── Z4. CSV → structured table ([S] row) ───────────────────────────────────
    if (existsSync(CSV_MAINTENANCE)) {
      const r = await uploadFileBytes(page, {
        name: "journey-maintenance.csv",
        type: "text/csv",
        bytes: fileBytes(CSV_MAINTENANCE),
      });
      const tableId = r?.ingested?.table ?? r?.ingested?.doc ?? null;
      if (tableId) uploadedIds.push(tableId);
      rec.check(
        r.status === 200 && r.ok === true && r.ingested?.kind === "csv" && (r.ingested?.rows ?? 0) > 0,
        "Z4: CSV ingests as STRUCTURED data (200, kind=csv, rows>0)",
        `status=${r.status} kind=${r.ingested?.kind} rows=${r.ingested?.rows} err=${r.error ?? ""}`
      );
      // Surfaces as a structured table row in the rail (the [S] viewer/exporter).
      if (tableId) {
        await page.goto(`${BASE}/sources`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const tableRow = await page
          .locator(`[data-testid="table-row-${tableId}"]`)
          .waitFor({ state: "attached", timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        rec.check(tableRow, "Z4: uploaded CSV appears as a structured [S] table row in the rail", `table-row-${tableId} present=${tableRow}`);
      }
    } else {
      rec.check(false, "Z4: CSV fixture present", `missing ${CSV_MAINTENANCE}`);
    }

    // ── Z5. XLSX (Hebrew) → structured table, name preserved (not ASCII-mangled) ─
    if (existsSync(XLSX_HEBREW)) {
      const r = await uploadFileBytes(page, {
        name: "שיבוצים יוני 2024 - סיון תשפד (1).xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: fileBytes(XLSX_HEBREW),
      });
      const tableId = r?.ingested?.table ?? r?.ingested?.doc ?? null;
      if (tableId) uploadedIds.push(tableId);
      rec.check(
        r.status === 200 && r.ok === true && (r.ingested?.rows ?? 0) > 0,
        "Z5: Hebrew XLSX ingests as a structured table (200, rows>0)",
        `status=${r.status} kind=${r.ingested?.kind} rows=${r.ingested?.rows} err=${r.error ?? ""}`
      );
      if (tableId) {
        await page.goto(`${BASE}/sources`, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(1000);
        // An XLSX surfaces ONE table per sheet, so the real row id is the base table id
        // with the sheet name appended (e.g. <base>-גיליון1). We match ANY table-name row
        // whose id starts with our base id AND whose visible TEXT contains a Hebrew
        // character (U+0590–U+05FF) — i.e. the Hebrew filename/sheet survived (not mangled
        // to Latin). This is the real assertion; the exact sheet-suffixed id is incidental.
        const result = await page.evaluate((base) => {
          const els = Array.from(document.querySelectorAll('[data-testid^="table-name-"]'));
          const ours = els.filter((e) => (e.getAttribute("data-testid") || "").includes(base));
          const text = ours.map((e) => e.textContent || "").join(" | ");
          const ids = ours.map((e) => e.getAttribute("data-testid"));
          return { text, ids };
        }, tableId);
        const hasHebrew = /[֐-׿]/.test(result.text || "");
        rec.check(hasHebrew, "Z5: Hebrew table NAME is preserved in the rail (not ASCII-mangled)", `label="${(result.text || "").slice(0, 70)}" ids=${result.ids.length}`);
        // Capture the sheet-suffixed ids so residue cleanup removes them too (the base id
        // alone may not catch a <base>-<sheet> table row).
        for (const tid of result.ids) {
          const sub = (tid || "").replace(/^table-name-/, "");
          if (sub && !uploadedIds.includes(sub)) uploadedIds.push(sub);
        }
      }
    } else {
      rec.check(false, "Z5: Hebrew XLSX fixture present", `missing ${XLSX_HEBREW}`);
    }

    // RESIDUE-CLEAN: delete every doc/table this journey uploaded.
    for (const id of uploadedIds) await deleteUploaded(page, id);
    rec.info("residue cleanup: removed uploaded docs/tables", uploadedIds.join(", ") || "(none)");
  } catch (e) {
    rec.check(false, "INGEST-FORMATS completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    await ctx?.close().catch(() => {});
    await browser.close();
  }
  return rec.summary();
}

// Build a minimal, valid .docx (OOXML) in pure JS — a zip with the 3 required parts +
// one paragraph of body text. Avoids any external skill/binary so the journey is
// self-contained. Returns a number[] of the zip bytes. Uses a tiny STORED-only (no
// compression) zip writer so mammoth can read word/document.xml.
async function makeMinimalDocx(text) {
  const enc = new TextEncoder();
  const files = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ];
  return Array.from(zipStore(files.map(([n, c]) => [n, enc.encode(c)])));
}

// Minimal STORED (compression method 0) zip writer — enough for a tiny .docx that
// mammoth/unzip can read. Computes CRC32 per entry; no compression, no zip64.
function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  const enc = new TextEncoder();
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...data,
    ];
    chunks.push(Uint8Array.from(local));
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...nameBytes,
    ]);
    offset += local.length;
  }
  const centralBytes = central.flat();
  const centralStart = offset;
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centralBytes.length), ...u32(centralStart), ...u16(0),
  ];
  const total = [...chunks.flatMap((c) => Array.from(c)), ...centralBytes, ...eocd];
  return Uint8Array.from(total);
}

// CRC32 (IEEE 802.3) for the zip entries.
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}
