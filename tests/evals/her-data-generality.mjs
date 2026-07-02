// HER-DATA RETRIEVAL GATE — proves the GENERAL, RETRIEVAL-side "her data" fixes generalize to UNSEEN
// uploads. Per the architecture direction, every reported bug is either RETRIEVAL (the system didn't
// get the right content in front of the model — the PRIORITY, fixed solid + general) or REASONING
// (the model HAD the content but interpreted it loosely — best-effort, a stronger model fixes it, NO
// format-specific code). This gate HARD-GATES the retrieval fixes and only REPORTS the reasoning ones:
//
//   HARD GATE — RETRIEVAL (the priority):
//   • MENDA depth — a summarize/enumerate question over ONE document must RETRIEVE ENOUGH of that
//     document (≥4 chunks, not just chunk 0) so the answer can enumerate the list + reach the
//     conclusion. General (helps every doc): a whole-doc recall boost + a fix to the unionByRrf
//     doc#page collapse that flattened a multi-chunk single-page doc to one chunk.
//   • Source routing — a SUMMARY/overview of the user's OWN subject that lives in their STRUCTURED
//     sheets must ROUTE TO + RETRIEVE those sheets, phrasing-robust, never an ungrounded-general
//     denial. We assert the RIGHT SOURCE/CHUNKS are retrieved, not just the final prose.
//
//   REPORTED ONLY — REASONING (best-effort, NOT gated): the intake-template "58 candidates" misread
//   and the plan-period muddle are MODEL-QUALITY issues — retrieval is correct (the rows ARE in front
//   of the model), interpretation is the gap, nudged by ONE general prompt rule (no detector, no
//   format branch). We print these as ℹ best-effort signals; they do NOT fail the gate.
//
// WHY SYNTHETIC (the generality layer): a fix proven only on HER files could be tuned to them. So this
// gate builds a BRAND-NEW file of each input TYPE — a form TEMPLATE, a filled ROSTER, a multi-sheet
// PERIOD set, a multi-chunk ENUMERABLE document — with INVENTED content in NO test, ingests them under
// a THROWAWAY owner, asserts against KNOWN ground truth, then DELETES the throwaway. A green run means
// the RETRIEVAL fixes GENERALIZE, independent of her (currently churning) live data.
//
// NO DEMO-TUNING: every assertion is against the SYNTHETIC file's own invented ground truth — no
// hardcoded her-corpus name/number/table appears here.
//
// RUN: node tests/evals/her-data-generality.mjs   (SERIAL; SKIPS LOUDLY without creds — never a
// false green). It creates ONE throwaway auth user + uploads, runs, then deletes every artifact.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { skip as skipShared } from "./_skip.mjs";
import { assertCleanBefore, assertCleanAfter, settleOwner } from "./_residue-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WANT = new Set([
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL",
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
]);
function loadEnvFile(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!WANT.has(key)) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}
loadEnvFile(".env.local");
loadEnvFile(".secrets/supabase.env");
loadEnvFile(".vercel-prod.env");
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const haveLlm = !!(process.env.LLM_API_KEY && process.env.LLM_API_KEY.length > 8);
const skip = (msg) => skipShared("her-data-generality", msg);
if (!haveSupabase) skip("Supabase URL + SERVICE_ROLE_KEY not found — the throwaway-owner upload path can't run.");
if (!haveLlm) skip("No LLM_API_KEY found — the router + answer pipeline make real LLM calls and can't run.");

const results = [];
function check(id, desc, ok, detail = "") {
  results.push({ id, ok: !!ok });
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} [${id}] ${desc}${detail ? `\n         ↳ ${detail}` : ""}`);
}

const { answerQuestion } = await import("../../src/lib/engine/answer.ts");
const { ingestCsv, ingestDocx } = await import("../../src/lib/engine/ingest.ts");
const { __resetRuntimeStoreForTests } = await import("../../src/lib/engine/runtime-store.ts");
const { resetStore } = await import("../../src/lib/engine/structured-store.ts");
const { deleteUploadedTable } = await import("../../src/lib/engine/structured-rows-store.ts");
const { deleteUploadedDoc } = await import("../../src/lib/engine/pgvector-store.ts");
const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");

if (!supabaseEnabled()) { console.error("supabaseEnabled() false despite env — aborting"); process.exit(1); }

// A throwaway owner (a real auth user id, so owner-scoping behaves exactly as a member's would).
let OWNER = null;
const uploadedTables = [];
const uploadedDocs = [];

async function newOwner() {
  const email = `generality-${crypto.randomUUID().slice(0, 8)}@nucleus-eval.invalid`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw new Error(`could not create throwaway owner: ${error?.message ?? "no id"}`);
  return settleOwner(data.user.id);
}

// Ask as the throwaway owner — a MEMBER (role member, isDemo false) so it exercises the exact
// owner-scoped path a real client user hits, over ONLY this owner's uploaded synthetic files.
async function ask(q) {
  __resetRuntimeStoreForTests();
  resetStore();
  return answerQuestion(q, { ownerId: OWNER, role: "member", isDemo: false });
}
const norm = (s) => (s || "").normalize("NFC");
const hasAny = (a, ...subs) => subs.some((s) => norm(a).includes(norm(s)));
// Number-word equivalents so an answer that spells "four options" / "four periods" counts the same
// as the digit "4" — graders must read MEANING, not a literal digit (the value-blindness lesson).
const WORD_NUM = { 4: ["four", "ארבע", "ארבעה"], 6: ["six", "שש", "שישה"], 25: ["twenty-five", "twenty five"] };
const hasNum = (a, n) =>
  new RegExp(`(?<![\\d.,])${n}(?![\\d.,])`).test(norm(a)) ||
  (WORD_NUM[n] || []).some((w) => new RegExp(`\\b${w}\\b`, "i").test(norm(a)));

async function main() {
  OWNER = await newOwner();
  console.log(`\n▶ HER-DATA RETRIEVAL — throwaway owner ${OWNER.slice(0, 8)}… (synthetic files; created + deleted)`);

  // ── SYNTHETIC FILE 1 — a BLANK FORM TEMPLATE (BUG1). Rows are FIELD LABELS / section headers,
  //    NOT records of any entity. Invented intake-style form for a fictional "Aurora mentorship".
  //    A correct engine must NOT report its row count as a count of mentees/participants.
  const templateCsv = [
    "Section,Field,Response",
    "Applicant Details,Full name,",
    "Applicant Details,Date of birth,",
    "Applicant Details,Phone number,",
    "Applicant Details,Email address,",
    "Background,Country of origin,",
    "Background,Languages spoken,",
    "Health,General medical status,",
    "Health,Allergies,",
    "Support,Assigned coordinator,",
    "Support,Local authority,",
  ].join("\n");
  await ingestCsv(templateCsv, "aurora-mentorship-intake-template.csv", OWNER);
  uploadedTables.push("aurora-mentorship-intake-template");

  // ── SYNTHETIC FILE 2 — a FILLED ROSTER (BUG1 positive control). 6 distinct people, one per row.
  //    A correct engine MUST count 6 (and must NOT be falsely flagged as a non-roster template).
  const rosterCsv = [
    "Name,Role,City",
    "Talia Brenner,Coordinator,Haifa",
    "Omar Faraj,Mentor,Nazareth",
    "Dana Kessler,Mentor,Tel Aviv",
    "Yuval Sade,Volunteer,Beersheba",
    "Lina Habibi,Volunteer,Acre",
    "Noa Perlman,Mentor,Jerusalem",
  ].join("\n");
  await ingestCsv(rosterCsv, "aurora-staff-roster.csv", OWNER);
  uploadedTables.push("aurora-staff-roster");

  // ── SYNTHETIC FILES 3 — a MULTI-SHEET PERIOD SET (BUG3). Four same-family quarterly plan sheets
  //    with DIFFERENT row counts. The correct "how many quarters/periods" answer is 4 (the number
  //    of sheets), NEVER the sum of row counts (7+5+9+4 = 25). Each sheet is a separate CSV table
  //    in the SAME name-family ("aurora-quarter-plan-…").
  const quarter = (q, rows) =>
    ["Goal,Skill,Note", ...Array.from({ length: rows }, (_, i) => `Goal ${i + 1},Skill ${i + 1},Note ${i + 1}`)].join("\n");
  await ingestCsv(quarter("q1", 7), "aurora-quarter-plan-q1-spring.csv", OWNER);
  await ingestCsv(quarter("q2", 5), "aurora-quarter-plan-q2-summer.csv", OWNER);
  await ingestCsv(quarter("q3", 9), "aurora-quarter-plan-q3-autumn.csv", OWNER);
  await ingestCsv(quarter("q4", 4), "aurora-quarter-plan-q4-winter.csv", OWNER);
  uploadedTables.push(
    "aurora-quarter-plan-q1-spring", "aurora-quarter-plan-q2-summer",
    "aurora-quarter-plan-q3-autumn", "aurora-quarter-plan-q4-winter"
  );

  // ── SYNTHETIC FILE 4 — a short ENUMERABLE DOCUMENT (BUG2). A strategy memo with EXACTLY 4 named
  //    options where Option 2 is explicitly the PREFERRED one. Long enough to chunk into several
  //    pieces so the "name the preferred" fact sits past the first chunk (the MENDA failure shape).
  // Each option carries DISTINCT, substantive prose (~600+ chars) so the memo chunks into SEVERAL
  // genuinely DIFFERENT pieces (~900 chars each, no near-duplicate padding that would dedup). The
  // "preferred" fact (Option 2) deliberately sits PAST the first chunk, exactly like the MENDA doc
  // where ranking surfaced only chunk 0 and the preferred option was never reached. This makes the
  // whole-doc recall boost load-bearing: a naive top-1 retrieval would miss the preferred option, so
  // the boost must pull the full document for the answer to enumerate all four + name the preferred.
  const memoParas = [
    "ZEPHYR LOGISTICS — fulfilment strategy memo. Internal, invented for testing. Background: Zephyr runs a same-day delivery app where shoppers browse, pay, and track orders without ever leaving zephyr.app. We are deciding how Zephyr handles the last mile of physical delivery now that order volume has tripled. There are exactly four options under consideration, and the decisive test for every single one of them is one question we keep returning to: does the customer ever leave the Zephyr app to complete or track the order? If the answer is yes, the option is disqualified on the spot, no matter how attractive its economics; if the answer is no, it stays on the table for serious evaluation against margin, control, and operational complexity.",
    "Option 1: Third-party handoff. Under this model the order is passed straight to an outside courier's OWN application — think a national parcel carrier — and the customer taps a link that opens that carrier's app or website to see tracking. The courier owns the delivery experience end to end, sets the delivery promise, and brands every notification; Zephyr earns only a thin per-order referral margin and loses all visibility into what the shopper sees after checkout. The fatal flaw is obvious against our decisive test: the customer plainly LEAVES the Zephyr app to track and resolve their order. Status: rejected outright — we will not adopt it at any phase, now or later, because it breaks the in-app experience that is our entire reason for existing.",
    "Option 2: Zephyr in-house fleet. Here Zephyr hires and dispatches its OWN branded drivers, who pick up from the merchant and deliver to the shopper while every status update, photo, and chat stays entirely inside the Zephyr app. Per-delivery margins are the highest of any option because there is no intermediary taking a cut, the customer experience is fully controlled down to the notification copy, and the logistics are the simplest to reason about since one team owns the whole chain. The shopper never leaves zephyr.app. Status: this is the PREFERRED near-term path — it is explicitly the option we recommend and the one we will pilot first in two launch cities before any wider rollout.",
    "Option 3: Hybrid regional partners. In this arrangement Zephyr's own drivers cover the dense urban cores where volume is high, while vetted regional delivery partners handle the suburban and rural edges, with every order still surfaced inside the Zephyr app under a single unified checkout and tracking screen. It preserves the in-app experience and extends reach, but it demands partner contracts, quality audits, and multi-vendor reconciliation that we do not have the leverage or headcount for yet. Status: a later phase only — we revisit it once in-house volume proves the model and gives us negotiating weight with partners.",
    "Option 4: Open marketplace of carriers. The most ambitious model turns Zephyr into a platform layer where any qualified carrier can bid in real time for each delivery, maximizing coverage and price competition while Zephyr takes a platform fee. Selection variety is enormous, but operational control over the experience is the lowest of the four and quality becomes hard to guarantee. Status: a long-horizon vision, explicitly not a current plan — it is sketched here only so the full option space is on record.",
    "Bottom line and recommendation: the red line that governs every decision is that the customer never leaves the Zephyr app. Measured against that line plus margin, control, and complexity, Option 2 (the in-house fleet) is the clear preferred near-term choice and our formal recommendation. The immediate next step is a small, instrumented pilot in two cities before we commit to scaling toward the later hybrid and marketplace phases.",
  ];
  // ingestDocx takes a .docx buffer; build a minimal valid .docx in-memory via the xlsx-free path
  // is awkward, so we ingest the memo as a CSV-free PLAIN doc through a tiny .docx writer. Simpler:
  // use a real .docx made by zipping a wordprocessingml document.
  const docxBuf = await makeDocx(memoParas.join("\n\n"));
  await ingestDocx(docxBuf, "zephyr-fulfilment-strategy.docx", "Zephyr Fulfilment Strategy", OWNER);
  uploadedDocs.push("zephyr-fulfilment-strategy");

  // Let durable writes settle (storeDocChunks/storeUploadedRows are awaited, but the per-scope
  // catalog handle rebuilds on the next introspect via hydrate — answerQuestion handles that).

  // ═══════ RETRIEVAL #1 (BUG2 MENDA DEPTH — HARD GATE) — a summarize/enumerate question over ONE
  //         document must RETRIEVE ENOUGH of that document (not just chunk 0) to answer. We assert the
  //         RETRIEVAL (≥4 of the memo's chunks reach the model), not just the prose — that is the fix.
  {
    const q = "How many options does the Zephyr fulfilment strategy memo present, and which is preferred?";
    const res = await ask(q);
    const a = res.answer ?? "";
    const memoChunks = (res.evidence?.chunks || []).filter((c) => /zephyr/.test(c.doc));
    const namesPreferred = /\b(in-?house|option 2|second option)\b/i.test(a) && /\b(prefer|recommend|near-term|chosen|pilot first)\b/i.test(a);
    console.log(`\n[RETRIEVAL/MENDA-depth] mode=${res.mode} route=${JSON.stringify(res.route?.sources)} memoChunks=${memoChunks.length}\n   ${a.replace(/\n/g, " ").slice(0, 320)}`);
    // HARD (retrieval): the doc lane must surface ENOUGH of the memo (its options + the preferred
    // sit past chunk 0) — at least 4 distinct chunks of THIS document reach the model. This is the
    // general retrieval-depth fix, the priority; it would FAIL on the old top-1 collapse.
    check("RETRIEVAL/MENDA-depth/enough-chunks", "≥4 chunks of the SUBJECT document are retrieved (not just chunk 0)",
      memoChunks.length >= 4, `memoChunks=${memoChunks.length}`);
    check("RETRIEVAL/MENDA-depth/grounded-cited", "the answer grounds in the memo (mode=grounded + a [P:] cite to it)",
      res.mode === "grounded" && /\[P:[^\]]+\]/.test(a),
      `mode=${res.mode} cites=${[...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)"}`);
    // REASONING (best-effort, REPORTED not gated): given the full doc, does the model name the
    // preferred option? A stronger model fixes this; we only need retrieval to put it in front.
    console.log(`         ℹ [reasoning, best-effort] names the preferred option (Option 2/in-house): ${namesPreferred ? "✓" : "·"} ; states 4 options: ${hasNum(a, 4) ? "✓" : "·"}`);
  }

  // ═══════ RETRIEVAL #2 (BUG4 SOURCE ROUTING — HARD GATE) — a summary of the user's OWN subject that
  //         lives in their STRUCTURED sheets must RETRIEVE + route to those sheets, phrasing-robust,
  //         never strand the data in an ungrounded-general denial. We assert the RIGHT SOURCE. ──────
  {
    const phrasings = [
      "Summarize the Aurora quarter plan.",
      "Give me an overview of the Aurora quarter plan.",
      "What does the Aurora quarter plan include?",
    ];
    for (const q of phrasings) {
      const res = await ask(q);
      const a = res.answer ?? "";
      const routedStructured = (res.route?.sources || []).includes("structured");
      const retrievedSheets = (res.evidence?.rows || []).some((r) => /aurora_quarter_plan/.test(r.table));
      const denies = /\b(no file|didn'?t upload|not uploaded|contact (the|your)|institution'?s website|search (the )?(institution|organization))\b/i.test(a);
      console.log(`\n[RETRIEVAL/source-routing] "${q}" → route=${JSON.stringify(res.route?.sources)} mode=${res.mode} sheetRows=${(res.evidence?.rows||[]).filter((r)=>/aurora_quarter_plan/.test(r.table)).length}`);
      // HARD (retrieval/routing): a summary of own structured data ROUTES to structured AND retrieves
      // her sheets — phrasing-robust (all three phrasings), never an ungrounded-general denial.
      check(`RETRIEVAL/source-routing/structured [${q.slice(0, 28)}]`, "routes to the caller's structured sheets",
        routedStructured && retrievedSheets, `route=${JSON.stringify(res.route?.sources)} retrievedSheets=${retrievedSheets}`);
      check(`RETRIEVAL/source-routing/no-denial [${q.slice(0, 28)}]`, "does NOT deny their data / send them elsewhere",
        !denies, `answer: "${a.replace(/\n/g, " ").slice(0, 160)}"`);
    }
  }

  // ═══════ REASONING (BEST-EFFORT, REPORTED — NO HARD GATE) — the template & period MISREADS are
  //         MODEL-QUALITY issues. Retrieval is correct (the rows ARE in front of the model); whether
  //         the model interprets them well is a stronger-model matter, nudged by one general prompt
  //         rule. We REPORT these, we do NOT gate on them (per the architecture direction). ─────────
  {
    const tq = "How many mentees are in the Aurora mentorship intake template?";
    const tr = await ask(tq);
    const ta = tr.answer ?? "";
    const retrievedTemplate = (tr.evidence?.rows || []).some((r) => /intake_template/.test(r.table)) || /\bstructured\b/.test(JSON.stringify(tr.route?.sources));
    const fabricated = /\b10 (mentees|participants|applicants|people|candidates|entries)\b/i.test(ta) || hasAny(ta, "10 מועמד", "10 חניכ");
    const honestTemplate = /\b(template|form|blank|field labels?|sections?|no (mentee|participant|applicant|record))\b/i.test(ta);
    console.log(`\n[REASONING/template, best-effort] route=${JSON.stringify(tr.route?.sources)}\n   ${ta.replace(/\n/g, " ").slice(0, 240)}`);
    console.log(`         ℹ retrieval-ok(template reached the model): ${retrievedTemplate ? "✓" : "·"} ; reasoning: no-fabricated-count=${!fabricated ? "✓" : "✗"} honest-template=${honestTemplate ? "✓" : "·"}`);

    const pq = "How many quarterly plan periods are there?";
    const pr = await ask(pq);
    const pa = pr.answer ?? "";
    const fourPeriods = hasNum(pa, 4);
    const summedRows = /\b25 (periods|quarters|תקופות)\b/i.test(pa);
    console.log(`[REASONING/periods, best-effort] route=${JSON.stringify(pr.route?.sources)}\n   ${pa.replace(/\n/g, " ").slice(0, 240)}`);
    console.log(`         ℹ reasoning: four-periods=${fourPeriods ? "✓" : "·"} not-summed-as-periods=${!summedRows ? "✓" : "✗"}`);
  }
}

// Minimal valid .docx writer (Open XML wordprocessingml). Zips the four parts mammoth needs:
// [Content_Types].xml, _rels/.rels, word/document.xml. Each paragraph → a <w:p>. No deps beyond
// the `jszip`/`xlsx` already present; we use jszip if available, else a hand-rolled store-only zip.
async function makeDocx(text) {
  const paras = text.split("\n\n").map((p) =>
    `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</w:t></w:r></w:p>`
  ).join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return buildStoredZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: documentXml },
  ]);
}

// A STORE-ONLY (no compression) ZIP — a .docx is a ZIP, and mammoth reads a stored zip fine.
// Hand-rolled so the eval needs no zip dependency. CRC-32 + local headers + central directory.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function buildStoredZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.data);
    const crc = crc32(dataBytes);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, dataBytes.length, true); lh.setUint32(22, dataBytes.length, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameBytes, dataBytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, dataBytes.length, true); ch.setUint32(24, dataBytes.length, true);
    ch.setUint16(28, nameBytes.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdStart, true); eocd.setUint16(20, 0, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

async function cleanup() {
  let tablesDeleted = 0, docsDeleted = 0, userDeleted = 0;
  for (const t of uploadedTables) {
    try { const n = await deleteUploadedTable(OWNER, t, false); if (n >= 0) tablesDeleted++; } catch { /* noop */ }
  }
  for (const d of uploadedDocs) {
    try { await deleteUploadedDoc(OWNER, d, false); docsDeleted++; } catch { /* noop */ }
  }
  if (OWNER) {
    try { const { error } = await admin().auth.admin.deleteUser(OWNER); if (!error) userDeleted++; } catch { /* noop */ }
  }
  console.log(`\n↩ cleanup: tables ${tablesDeleted}/${uploadedTables.length}, docs ${docsDeleted}/${uploadedDocs.length}, owner ${userDeleted}/1 deleted`);
  check("CLEANUP/owner-deleted", "the throwaway owner was deleted (no residue)", userDeleted === 1, `userDeleted=${userDeleted}`);
}

// RESIDUE GUARD (#79): refuse to run over a DB a prior leaked run left dirty (a polluted
// catalog produces a FALSE GREEN); abort loudly. Asserts 0 throwaway orphan rows BEFORE the run.
await assertCleanBefore("her-data-generality");
let runError = null;
try { await main(); }
catch (e) { runError = e; console.error("\nEVAL RUNNER ERROR:", e instanceof Error ? e.stack : e); }
finally { await cleanup(); }
// RESIDUE GUARD (#79): this run must leave 0 throwaway residue — fail loudly if its cleanup leaked.
await assertCleanAfter("her-data-generality");

const fails = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}`);
console.log(`HER-DATA RETRIEVAL: ${results.length - fails.length}/${results.length} passed` + (fails.length ? ` · FAILED: ${fails.map((f) => f.id).join(", ")}` : " · ALL GREEN"));
if (fails.length || runError) process.exit(1);
process.exit(0);
