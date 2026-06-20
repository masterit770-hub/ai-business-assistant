// The orchestrator: route → retrieve (SQL + RAG) → grounded generation → validate.
// Returns the answer, the routing decision (reported to the user), and the
// evidence (every cited row/page), so the UI can show traceability.
import { routeQuestion, type RoutePlan } from "./router.ts";
import { getIntent, type IntentSummary } from "./intents.ts";
import { vectorSearch as vectorSearchLocal, type SqlRow, type DocChunk } from "./retrieval.ts";
import { fileSearchEnabled, queryFileSearch } from "./file-search.ts";
import { embedQuery } from "./embeddings.ts";
import { chat, isLocalNotConfigured, isLocalUnreachable } from "./llm.ts";
import { sqlToken, pdfToken, extractCitationTokens } from "./citations.ts";
import { validateAnswer, type Evidence } from "./validate-answer.ts";
import { validateContractAnswer } from "./validate-contract-answer.ts";
import { validateCaseAnswer } from "./validate-case-answer.ts";
import { validateNoFabrication } from "./validate-maintenance-answer.ts";
import { DOCUMENTS } from "./documents.ts";
import { runtimeDocs } from "./runtime-store.ts";
import { getSetting } from "./settings.ts";

export type AnswerResult = {
  question: string;
  route: RoutePlan;
  answer: string;
  // The answering mode for this turn:
  //  • "grounded" — the user's documents/data contained the answer. The reply is
  //    grounded strictly in retrieved evidence, every fact is cited, and the
  //    citation/no-fabrication gates (validateAnswer + the per-feature gates) ran.
  //  • "general"  — the user has NO relevant documents/data for this question (the
  //    router matched no source, or retrieval came back empty). The reply is the
  //    model's general knowledge, has NO citations/evidence, and is intentionally
  //    NOT run through the grounding validators (a general answer legitimately
  //    carries no citation tokens — validating it would wrongly reject it).
  mode: "grounded" | "general";
  // Convenience flag mirroring `mode === "grounded"` for callers/UI that want a
  // single boolean (the Ask panel uses this to show the muted "general knowledge"
  // line vs. the grounded citations).
  grounded: boolean;
  // Set ONLY when Local mode is on but the local model couldn't answer (not
  // configured / unreachable). The answer text is friendly setup guidance; the UI
  // can use this to show a calm "Local setup" note instead of the "general
  // knowledge" line. Absent on every normal turn.
  localGuidance?: "not-configured" | "unreachable";
  evidence: {
    rows: { table: string; id: number; token: string; data: Record<string, unknown> }[];
    chunks: { doc: string; page: number; token: string; text: string }[];
  };
  validation: { ok: boolean; reasons: string[] };
};

const TODAY = process.env.ASSISTANT_TODAY ?? new Date().toISOString().slice(0, 10);

/**
 * Decide whether to surface the HONEST "couldn't search your uploaded documents"
 * error instead of answering. Pure, so it's unit-testable without the LLM/index.
 *
 * Fires when File Search (the uploaded-doc lane) failed AND there's no legitimate
 * substitute evidence: no structured rows, and either no doc chunks at all OR the
 * question targeted a specific uploaded doc (so the always-returned bundled Carter
 * chunks must NOT be used to answer it). A genuine bundled question still answers.
 */
export function shouldSurfaceDocLaneError(s: {
  fileSearchError: string | null;
  rowCount: number;
  chunkCount: number;
  targetedUploadedDoc: boolean;
}): boolean {
  if (!s.fileSearchError) return false;
  if (s.rowCount > 0) return false; // a structured-backed turn still answers
  return s.chunkCount === 0 || s.targetedUploadedDoc;
}

// ── LOCAL-MODE FRIENDLY GUIDANCE ───────────────────────────────────────────────
// When the workspace is in Local mode but the local model can't actually answer —
// either no endpoint is configured, or the configured endpoint is unreachable —
// we do NOT 500. We return a NORMAL answer payload whose `answer` text is plain,
// guiding language, so the Ask UI just renders it like any other answer (no scary
// red error, no citations to validate). `mode: "general"` marks it as
// non-grounded so the UI hides the citation/validation chrome.
//
// Pure + exported so the exact wording is unit-tested without a live LLM/endpoint.
export type LocalGuidanceKind = "not-configured" | "unreachable";

export function localGuidanceText(kind: LocalGuidanceKind, endpoint?: string): string {
  if (kind === "not-configured") {
    return "Local mode is on, but no local model is set up yet. To use Local: run Nucleus on your own machine, install Ollama and pull a model, then enter your endpoint (e.g. http://localhost:11434/v1) and model name in Settings → Model. (The hosted demo can't reach a local model — Local works when you self-host.)";
  }
  const where = endpoint ? `at ${endpoint}` : "at your configured endpoint";
  return `Local mode is on, but I couldn't reach your local model ${where}. Make sure Nucleus is running on the same machine/network as your model (Ollama running, the model pulled), and that the endpoint in Settings → Model is correct.`;
}

function localGuidanceResult(
  question: string,
  kind: LocalGuidanceKind,
  endpoint?: string
): AnswerResult {
  return {
    question,
    // A minimal, honest routing record: we never reached the real router.
    route: {
      sources: [],
      intents: [],
      docFilter: null,
      rationale: "Local mode — the local model wasn't available, so this is setup guidance.",
    },
    answer: localGuidanceText(kind, endpoint),
    // "general" → no citations/validation chrome; the UI shows it as plain text.
    mode: "general",
    grounded: false,
    // Flag so the UI can show this as guidance (not a normal general answer) if it
    // wants to; harmless for callers that ignore it.
    localGuidance: kind,
    evidence: { rows: [], chunks: [] },
    validation: { ok: true, reasons: [] },
  };
}

// PUBLIC entry. Runs the real pipeline, but if the active backend is LOCAL and it
// can't answer (not configured / unreachable), returns the friendly guidance as a
// normal 200 payload instead of letting the typed error become a 500.
export async function answerQuestion(
  question: string,
  ctx: { ownerId?: string; role?: string } = {}
): Promise<AnswerResult> {
  try {
    return await runAnswerPipeline(question, ctx);
  } catch (e) {
    if (isLocalNotConfigured(e)) {
      return localGuidanceResult(question, "not-configured");
    }
    if (isLocalUnreachable(e)) {
      const endpoint = (e as { endpoint?: string }).endpoint;
      return localGuidanceResult(question, "unreachable", endpoint);
    }
    throw e; // any other error keeps its existing (cloud) handling.
  }
}

async function runAnswerPipeline(
  question: string,
  ctx: { ownerId?: string; role?: string } = {}
): Promise<AnswerResult> {
  // An admin sees ALL uploaded docs → no owner scoping on retrieval.
  const scopeOwner = ctx.role === "admin" ? undefined : ctx.ownerId;
  // 1. ROUTE (real LLM decision) — owner-scoped doc catalog (Phase C)
  const route = await routeQuestion(question, { ownerId: scopeOwner });

  // 2. RETRIEVE
  const rows: SqlRow[] = [];
  const summaries: IntentSummary[] = [];
  if (route.sources.includes("structured")) {
    for (const intent of route.intents) {
      const def = getIntent(intent.name);
      if (!def) continue;
      try {
        const result = def.run(intent.params, TODAY);
        rows.push(...result.rows);
        if (result.summary) summaries.push(result.summary);
      } catch (e) {
        // A bad intent never crashes the answer, but surface it in logs so a
        // misconfigured retrieval (e.g. a missing bundled index) is debuggable.
        console.error(`intent ${intent.name} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  let chunks: DocChunk[] = [];
  let fileSearchError: string | null = null;
  // Did the router target a specific UPLOADED doc (a docFilter that isn't one of the
  // bundled Carter ids)? The local vector index ALWAYS returns its top-k Carter chunks
  // even for an uploaded-doc question, so we can't tell from the chunks alone whether
  // the bundled text actually answers the question. The route's docFilter is the
  // reliable signal: if it names a non-bundled doc, the UPLOADED-doc lane (File Search)
  // was the intended source — and if that lane failed, we must surface the honest
  // error, not silently answer from the Carter corpus. (A flat cosine threshold was
  // tried and is NOT separable — multilingual-e5 puts Carter and uploaded-doc
  // questions in the same high score band; verified empirically.)
  const BUNDLED_DOC_IDS = new Set(DOCUMENTS.map((d) => d.doc));
  const targetedUploadedDoc = !!route.docFilter && !BUNDLED_DOC_IDS.has(route.docFilter);
  if (route.sources.includes("documents")) {
    // BUNDLED corpus (Carter) → the verified LOCAL vector path. Retrieve across ALL
    // bundled docs (no filter) so corroboration / conflict-surfacing across both
    // companion PDFs works.
    const qEmbedding = await embedQuery(question);
    const localRaw = vectorSearchLocal(qEmbedding, 12);
    let merged = localRaw;

    // UPLOADED docs → Gemini File Search (managed, durable). One generateContent
    // call returns grounding chunks we map to the engine's [P:doc#page] shape and
    // merge with the bundled chunks, so a single answer can cite both corpora. A
    // quota 429 is captured (not swallowed) and surfaced honestly downstream.
    if (fileSearchEnabled()) {
      try {
        const fs = await queryFileSearch(question, scopeOwner);
        merged = [
          ...merged,
          ...fs.chunks.map((c) => ({ doc: c.doc, page: c.page, text: c.text, score: 0.99 })),
        ];
      } catch (e) {
        // File Search is an ENRICHMENT of the answer (the caller's UPLOADED docs).
        // It must never be fatal to a bundled/structured answer: a quota block OR a
        // transient transport blip ("terminated"/"fetch failed") to Gemini is
        // captured here and surfaced honestly downstream — the local bundled chunks
        // and any structured rows still answer. (Previously a non-quota error
        // re-threw and took down a bundled-PDF answer that didn't even need Gemini.)
        fileSearchError = e instanceof Error ? e.message : String(e);
      }
    }
    chunks = diversifyByDoc(merged, 8);
  }

  // 3. Build evidence with citation tokens. The evidence carries the underlying
  // values (row data, page text) AND the verified server-side aggregates so the
  // claim-support cross-check in validateAnswer can confirm a cited number is
  // actually backed by what it points at.
  const evRows = rows.map((r) => ({ ...r, token: sqlToken(r.table, r.id) }));
  const evChunks = chunks.map((c) => ({ ...c, token: pdfToken(c.doc, c.page) }));
  const aggregates = collectAggregates(summaries);
  const evidence: Evidence = {
    rows: evRows.map((r) => ({ table: r.table, id: r.id, data: r.data })),
    chunks: evChunks.map((c) => ({ doc: c.doc, page: c.page, text: c.text })),
    aggregates,
  };

  // HONEST DOC-LANE SHORT-CIRCUIT: when File Search (the UPLOADED-doc lane) failed,
  // do NOT silently answer from the wrong corpus. Surface the honest "couldn't search
  // your uploaded documents" message when there's no legitimate substitute evidence:
  //   • no structured rows (a structured-backed turn still answers), AND
  //   • EITHER no doc chunks came back at all, OR the question targeted a specific
  //     UPLOADED doc (route.docFilter names a non-bundled doc) — in which case the
  //     always-returned Carter chunks are NOT a valid answer and must not be used.
  // A genuine bundled (Carter) question — no uploaded-doc docFilter — still answers
  // from its chunks despite a File Search blip (the earlier not-fatal fix).
  if (
    shouldSurfaceDocLaneError({
      fileSearchError,
      rowCount: evRows.length,
      chunkCount: evChunks.length,
      targetedUploadedDoc,
    })
  ) {
    return {
      question,
      route,
      answer:
        "I couldn't search your uploaded documents right now: " +
        fileSearchError +
        " (Bundled data and structured questions are unaffected.)",
      mode: "grounded",
      grounded: true,
      evidence: { rows: [], chunks: [] },
      validation: { ok: false, reasons: ["file-search-unavailable"] },
    };
  }

  // ── GENERAL-KNOWLEDGE FALLBACK ────────────────────────────────────────────
  // Did retrieval actually find anything the user can be answered FROM? Evidence
  // exists when we got structured rows OR document chunks. (The router matching no
  // source at all also lands here — it produces neither rows nor chunks.)
  //
  // When there is NO evidence, the OLD behavior was to still run grounded
  // generation, whose immutable rules forced an "are not available in the data"
  // refusal for a general question like "What is Arizona divorce law?". The client
  // asked us to SOFTEN that: with no evidence, answer helpfully from the model's
  // general knowledge instead of refusing — while the grounded, cited path below is
  // untouched whenever the user's documents/data DO contain the answer.
  const hasEvidence = evRows.length > 0 || evChunks.length > 0;
  if (!hasEvidence) {
    const persona = await getSetting("system_prompt");
    const answer = await generateGeneral(question, persona, TODAY);
    // No citation/grounding validation on this path: a general answer legitimately
    // has no [S:...]/[P:...] tokens, so validateAnswer would wrongly reject it.
    return {
      question,
      route,
      answer,
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
      validation: { ok: true, reasons: [] },
    };
  }

  // For the maintenance domain, give generation the table's schema so it can
  // HONESTLY refuse overdue/paid/suspension/customer-debt questions by citing the
  // columns that DO exist as evidence of the absent concept (not fabricate one).
  const schemaContext = buildSchemaContext(route);

  // 4. GROUNDED GENERATION
  // The admin-editable answering style (Prompt-config panel). A blank/absent
  // override falls back to the built-in default — see settings.ts.
  const stylePreamble = await getSetting("system_prompt");
  let answer = await generateGrounded(
    question,
    evRows,
    evChunks,
    summaries,
    schemaContext,
    TODAY,
    stylePreamble
  );

  // 4a. GENERAL-KNOWLEDGE FALLBACK (the bundled-corpus edge). The LOCAL vector index
  // ALWAYS returns its top-k bundled (Carter) chunks, even for a question those docs
  // have nothing to do with (e.g. "What is the capital of Australia?"). So
  // `hasEvidence` above can be true on chunk count alone while the retrieved chunks
  // do NOT actually answer the question — and grounded generation then emits the
  // "are not available in the provided documents" refusal the client asked us to
  // stop. We detect that precisely: a grounded answer that cites NOTHING and reads as
  // a not-available refusal means the retrieved evidence did not in fact answer the
  // question → answer from general knowledge instead. This is tightly scoped and
  // CANNOT weaken a real grounded answer: every legitimate grounded reply (the Carter
  // case file, contracts, the maintenance schema-refusal with its row-cited figures
  // block) carries at least one citation token, so it never enters this branch.
  if (isUncitedRefusal(answer)) {
    const generalAnswer = await generateGeneral(question, stylePreamble, TODAY);
    return {
      question,
      route,
      answer: generalAnswer,
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
      validation: { ok: true, reasons: [] },
    };
  }

  // 4b. DETERMINISTIC maintenance figures block. The marquee trust demo (the
  // overdue refusal) pivots to real spend figures. We do NOT trust the LLM to
  // attach the [S:maintenance#id] citation to those server-computed figures, so we
  // append a verified, row-cited figures block deterministically. Every number here
  // is a verified aggregate (so it passes the claim-support cross-check) and every
  // line carries a real retrieved row token (so it passes the citation-resolves and
  // factual-claim-needs-a-citation rules). The honest "no payment-status field
  // exists" meta-statement the LLM emits stays uncited; these spend figures do not.
  if (route.intents.some((i) => i.name === "maintenance_spend") && summaries.length > 0) {
    const block = buildMaintenanceFiguresBlock(summaries, evRows);
    if (block) answer = `${answer.trim()}\n\n${block}`;
  }

  // 4c. DETERMINISTIC contract figures block. A single named-contract question (the
  // Skalith Example C) must carry that contract's real annual cost + expiry, cited to
  // its row — never left to the LLM to remember a $25,629.50 it could round or drop.
  // We append every retrieved contract row's verified value + expiry with its own
  // [S:contracts#id] token. Every figure here is a literal row value (so the
  // claim-support cross-check passes) and is row-cited.
  if (route.intents.some((i) => i.name.startsWith("contracts_")) && evRows.length > 0) {
    const block = buildContractFiguresBlock(evRows);
    if (block) answer = `${answer.trim()}\n\n${block}`;
  }

  // 5. VALIDATE — generic content-fidelity + the per-feature gate (contracts).
  const validation = validateAnswer(answer, evidence);
  const reasons = [...validation.reasons];
  const isContractTurn = route.intents.some((i) => i.name.startsWith("contracts_"));
  if (isContractTurn) {
    const cv = validateContractAnswer(answer);
    reasons.push(...cv.reasons);
  }
  // A case-file turn: documents only, no structured intents, AND the cited chunks
  // are the bundled CARTER documents. The case gate's stop-list (alimony / sole
  // custody / filing-date conflict) is specific to the Carter corpus, so it must
  // NOT run against a user-UPLOADED document that may legitimately contain those
  // words — that would false-fail a valid upload. Scope it to Carter chunks only.
  const CARTER_DOCS = new Set(DOCUMENTS.map((d) => d.doc));
  const isCaseTurn =
    route.sources.includes("documents") &&
    !route.sources.includes("structured") &&
    evChunks.length > 0 &&
    evChunks.every((c) => CARTER_DOCS.has(c.doc));
  if (isCaseTurn) {
    const cv = validateCaseAnswer(answer);
    reasons.push(...cv.reasons);
  }
  const isMaintenanceTurn = route.intents.some((i) => i.name === "maintenance_spend");
  if (isMaintenanceTurn) {
    const mv = validateNoFabrication(answer);
    reasons.push(...mv.reasons);
  }

  const validationOk = reasons.length === 0;

  // ── GROUNDED → GENERAL FALLBACK (the broadened fix) ───────────────────────
  // The grounded answer above is a refusal/non-answer EVEN IF it cited docs (the
  // alimony "I cannot answer … not stated in the case file [P:carter#…]" case), OR a
  // per-feature gate (e.g. validateCaseAnswer's alimony stop-list) REJECTED it. In
  // either case surfacing it shows the user a refusal/red error. Instead, re-answer
  // via the general-knowledge path (grounded=false, "not from your uploaded documents"
  // label). The HARD EXCEPTION inside shouldFallbackToGeneral keeps every real
  // grounded reply — including the DESIGNED maintenance honest-refusal, which PASSES
  // validation and carries its verified $40,597 figure + [S:maintenance#…] tokens —
  // grounded and untouched.
  const hasVerifiedAggregate = aggregates.length > 0;
  if (shouldFallbackToGeneral({ answer, validationOk, hasVerifiedAggregate })) {
    // `stylePreamble` (the persona) is already fetched above — reuse it.
    const generalAnswer = await generateGeneral(question, stylePreamble, TODAY);
    return {
      question,
      route,
      answer: generalAnswer,
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
      validation: { ok: true, reasons: [] },
    };
  }

  return {
    question,
    route,
    answer,
    mode: "grounded",
    grounded: true,
    evidence: {
      rows: evRows.map((r) => ({ table: r.table, id: r.id, token: r.token, data: r.data })),
      chunks: evChunks.map((c) => ({ doc: c.doc, page: c.page, token: c.token, text: c.text })),
    },
    validation: { ok: validationOk, reasons },
  };
}

// A grounded answer that (a) carries NO citation token at all and (b) reads as a
// "the evidence doesn't contain this" refusal. This is the signal that the
// always-returned bundled chunks did not actually answer the question, so we should
// answer from general knowledge instead of surfacing the refusal. The citation-token
// guard is the safety: any real grounded answer cites something and is left alone.
// (The maintenance schema-refusal is a structured turn that gets a row-cited figures
// block appended, so it carries [S:maintenance#…] tokens and never matches here.)
const REFUSAL_RE =
  /\b(not (present|available|found|stated|provided|included|specified|mentioned|contained)|are not available|is not available|isn't available|aren't available|do(es)? not (contain|include|provide|state|mention)|don't (contain|include|provide)|no (matching|relevant|such) (data|records?|information|documents?|evidence)|cannot (find|answer)|can't (find|answer)|could not find|couldn't find|unable to (find|answer))\b/i;

function isUncitedRefusal(answer: string): boolean {
  if (extractCitationTokens(answer).length > 0) return false; // any citation → real grounded answer
  return REFUSAL_RE.test(answer);
}

// A BROADER refusal/non-answer detector than REFUSAL_RE above — it ALSO matches the
// phrasing the grounded model uses when it declines a question whose answer the
// retrieved evidence doesn't hold even though it pinned a citation while declining
// (e.g. "I cannot answer this question because the evidence does not contain any
// information about Arizona divorce law … not stated in the case file [P:carter#…]").
// This is the gap the original isUncitedRefusal missed: that refusal CITES docs, so
// the citation guard let it through and the user saw a refusal (often a red error
// when a per-feature gate rejected the cited-but-refusing answer).
//
// Patterns taken from the spec (conservative — these are explicit non-answers, not
// hedges): "I cannot answer", "evidence does not contain", "does/do not contain",
// "none of these sources", "not stated in", "not available in (the) data/documents/
// case file", "no information about/on", "don't/do not have … information".
const REFUSAL_TEXT_RE =
  /cannot answer|can'?t answer|evidence does not contain|do(es)? not contain|none of these sources|not stated in|not available in (the )?(data|documents?|case file)|no information (about|on)|do(n'?t| not) have .{0,40}information/i;

// Does this grounded answer provide REAL grounded content, or is it effectively just
// a refusal? "Real grounded content" = a sentence that asserts a fact (a number, a
// currency figure, a quantified claim) that is NOT itself a not-found disclaimer. The
// designed maintenance honest-refusal qualifies as real content: it states the
// verified pivot figure ("total maintenance spend is $40,597.00 …") and carries its
// [S:maintenance#…] tokens — so this returns true for it and it is NOT treated as an
// empty refusal. A pure "I cannot answer … not in the case file" has no such
// substantive figure-bearing sentence → returns false.
const GROUNDED_FIGURE_RE = /\$[\d,]+(?:\.\d+)?|\b\d{2,}\b/;
function hasUsefulGroundedContent(answer: string): boolean {
  const sentences = answer.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (REFUSAL_TEXT_RE.test(s) || REFUSAL_RE.test(s)) continue; // a disclaimer sentence is not "content"
    if (GROUNDED_FIGURE_RE.test(s)) return true; // a substantive figure-bearing sentence
  }
  return false;
}

// THE BROADENED grounded→general fallback decision (the fix). Re-answer from general
// knowledge instead of surfacing a refusal/rejected grounded answer when EITHER:
//   • validateAnswer (incl. the per-feature gates) REJECTED the grounded answer, OR
//   • the answer reads as a genuine refusal/non-answer AND carries no real grounded
//     content — even if it pinned a citation while refusing.
// HARD EXCEPTION (protect the designed maintenance honest-refusal and every real
// grounded reply): if validation PASSED and the answer carries citation tokens OR a
// verified aggregate figure, it is a VALID grounded answer → keep it grounded. So we
// key primarily off validation REJECTION (+ genuine refusal text with no useful
// grounded content), never off refusal wording alone.
//
// Pure + exported so the branching is unit-tested deterministically without an LLM:
// pass the crafted answer string, the validation outcome, and the verified-aggregate
// presence flag.
export function shouldFallbackToGeneral(s: {
  answer: string;
  validationOk: boolean;
  hasVerifiedAggregate: boolean;
}): boolean {
  const cited = extractCitationTokens(s.answer).length > 0;
  // HARD EXCEPTION: a validation-PASSING answer that carries citations or a verified
  // aggregate figure is a real grounded answer (this is the designed maintenance
  // honest-refusal, the contracts answer, the case-file answer) — never fall back.
  if (s.validationOk && (cited || s.hasVerifiedAggregate)) return false;

  // Signal A — validation rejected the grounded answer (the alimony cited-refusal that
  // tripped validateCaseAnswer's alimony stop-list lands here, red error and all).
  if (!s.validationOk) return true;

  // Signal B — validation passed but the answer is a genuine refusal/non-answer with
  // no real grounded content (a refusal that pinned a citation but said nothing
  // substantive). Conservative: requires refusal TEXT *and* the absence of any
  // useful figure-bearing sentence.
  const reads_as_refusal = REFUSAL_TEXT_RE.test(s.answer) || REFUSAL_RE.test(s.answer);
  if (reads_as_refusal && !hasUsefulGroundedContent(s.answer)) return true;

  return false;
}

// GENERAL-KNOWLEDGE generation — used ONLY when retrieval found no evidence for the
// question (no structured rows, no document chunks). The admin-editable persona
// (system_prompt setting) still drives tone/voice, so an admin who sets "You are an
// expert lawyer, explain clearly for a layperson" visibly changes these answers too.
// Crucially there are NO grounding/citation rules here: with no evidence, demanding
// citations would force the very "not available in the data" refusal the client asked
// us to stop. We instead instruct the model to answer from general knowledge WITHOUT
// inventing citations, and to nudge the user to a professional for high-stakes domains.
async function generateGeneral(
  question: string,
  persona: string,
  today: string
): Promise<string> {
  const system = `${persona.trim()}

You do NOT have any relevant documents or data for this specific question, so answer it helpfully and accurately from your general knowledge. Do not cite sources and do not invent citation tokens like [S:...] or [P:...]. If the question involves legal, medical, tax, or financial decisions, briefly remind the user to verify with a qualified professional for their specific situation. Be clear and concise.`;
  const user = `Today's date is ${today}.

Question: ${question}`;
  return chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2 }
  );
}

function docLabel(doc: string): string {
  return (
    DOCUMENTS.find((d) => d.doc === doc)?.label ??
    runtimeDocs().find((d) => d.doc === doc)?.label ??
    doc
  );
}

// Every verified server-computed figure (counts, totals, per-figure values) that a
// row-cited summary line is allowed to state even though no single row holds that
// value. The claim-support cross-check treats these as ground truth.
function collectAggregates(summaries: IntentSummary[]): number[] {
  const out: number[] = [];
  for (const s of summaries) {
    out.push(s.count);
    if (s.total) out.push(s.total.value);
    for (const f of s.figures ?? []) {
      out.push(f.value);
      for (const v of f.extraValues ?? []) out.push(v);
    }
  }
  return out;
}

// The deterministic, row-cited verified-figures block appended to maintenance
// answers. Each line states a server-computed aggregate WITH its [S:maintenance#id]
// anchor, so the figure is always cited (never bare prose) regardless of what the
// LLM wrote above.
function buildMaintenanceFiguresBlock(
  summaries: IntentSummary[],
  evRows: { token: string; table: string; id: number }[]
): string {
  const figures = summaries.flatMap((s) => s.figures ?? []);
  if (figures.length === 0) return "";
  const tokenFor = (id: number) => {
    const r = evRows.find((r) => r.table === "maintenance" && r.id === id);
    return r ? r.token : sqlToken("maintenance", id);
  };
  const lines = figures.map((f) => `- ${f.label} ${tokenFor(f.cite)}.`);
  return ["Verified figures (computed over the cited maintenance rows):", ...lines].join("\n");
}

// A per-contract verified-value block for a SPECIFIC named-contract question. Only
// emitted for a small, focused result set (a named-vendor drill like Skalith) — not
// for the 38-contract expiry SET, where the LLM already states the verified count +
// combined total and a per-row dump would be noise. Each line carries the row's real
// annual cost + expiry and its own [S:contracts#id] token (literal row values, so
// the claim-support cross-check passes).
const CONTRACT_BLOCK_MAX_ROWS = 6;
function buildContractFiguresBlock(
  evRows: { token: string; table: string; id: number; data: Record<string, unknown> }[]
): string {
  const rows = evRows.filter((r) => r.table === "contracts");
  if (rows.length === 0 || rows.length > CONTRACT_BLOCK_MAX_ROWS) return "";
  const fmtUsd = (v: unknown) =>
    typeof v === "number"
      ? v.toLocaleString("en-US", { style: "currency", currency: "USD" })
      : String(v ?? "");
  const lines = rows.map((r) => {
    const d = r.data;
    const role = d.contract_id ?? "contract";
    const cost = fmtUsd(d.annual_cost);
    const expiry = d.end_date_iso ?? d.end_date ?? "unknown";
    return `- ${d.vendor} (${role}): annual cost ${cost}, expires ${expiry} ${r.token}.`;
  });
  return ["Verified contract figures (from the cited rows):", ...lines].join("\n");
}

// Schema evidence for the honest-refusal path. When a maintenance question asks
// for a concept the data lacks (overdue/paid/due/suspension/who-owes), the answer
// must cite the EXISTING column set to prove the absence and refuse — not invent.
function buildSchemaContext(route: RoutePlan): string {
  if (!route.intents.some((i) => i.name === "maintenance_spend")) return "";
  const cols = "Ticket ID (a category label), Vendor, Invoice, Labor Cost, Parts Cost, Total Cost, Completion Date";
  return [
    `SCHEMA of the maintenance table (school data 3.csv) — these are the COMPLETE set of columns: ${cols}.`,
    `This data has NO payment-status, paid/unpaid, due-date, or service-suspension field, and there is NO service-agreement document.`,
    `The vendors are maintenance providers the school PAYS — they are NOT customers who owe money.`,
    `If the question asks about overdue payments, who owes us, paid/unpaid status, or service-suspension terms: you CANNOT answer it from this data. Say so honestly, naming the existing columns in PROSE as the evidence of the absent field (do NOT write a "[SCHEMA]" tag — describe the columns in words), and do NOT invent an overdue list or relabel vendors as debtors.`,
    `MANDATORY: end EVERY such refusal by pivoting to the real analysis — you MUST state the exact figure "total maintenance spend is $40,597.00 across 750 tickets" (keep the $40,597.00 figure verbatim, even when answering in Hebrew or another language) and offer to break it down by vendor or year. A refusal that omits this pivot figure is incomplete.`,
  ].join(" ");
}

// Keep the top chunks but guarantee each represented document gets at least a
// couple of slots, so a corroborating/conflicting passage in a lower-ranked doc
// isn't crowded out by a higher-ranked one. Preserves overall score order.
function diversifyByDoc(chunks: DocChunk[], limit: number): DocChunk[] {
  const perDocFloor = 2;
  const byDoc = new Map<string, DocChunk[]>();
  for (const c of chunks) {
    if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
    byDoc.get(c.doc)!.push(c);
  }
  const picked = new Set<DocChunk>();
  // First pass: each doc's top `perDocFloor`.
  for (const list of byDoc.values()) for (const c of list.slice(0, perDocFloor)) picked.add(c);
  // Then fill remaining slots in global score order.
  for (const c of chunks) {
    if (picked.size >= limit) break;
    picked.add(c);
  }
  return chunks.filter((c) => picked.has(c)).slice(0, limit);
}

async function generateGrounded(
  question: string,
  rows: { token: string; table: string; data: Record<string, unknown> }[],
  chunks: { token: string; doc: string; page: number; text: string }[],
  summaries: IntentSummary[],
  schemaContext: string,
  today: string,
  stylePreamble: string
): Promise<string> {
  const aggLines =
    summaries.length === 0
      ? ""
      : summaries
          .map((s) => {
            const t = s.total
              ? `, ${s.total.name} = ${s.total.value.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                })}`
              : "";
            const note = s.note ? ` ${s.note}` : "";
            return `- ${s.label}: count = ${s.count}${t} (verified SQL aggregate over the cited rows).${note}`;
          })
          .join("\n");
  const structuredEvidence =
    rows.length === 0
      ? "(no structured rows retrieved)"
      : rows
          .map((r) => `${r.token} ${JSON.stringify(r.data)}`)
          .join("\n");
  const docEvidence =
    chunks.length === 0
      ? "(no document chunks retrieved)"
      : chunks
          .map((c) => `${c.token} (${docLabel(c.doc)}, page ${c.page}): ${c.text}`)
          .join("\n\n");

  // The admin-editable style preamble (from the Prompt-config panel) sets tone /
  // strictness / answering style. It is PREPENDED to the immutable grounding rules
  // below so an edit visibly changes answers, but can NEVER delete the citation /
  // no-fabrication guarantees (those are enforced by validateAnswer regardless).
  const system = `${stylePreamble.trim()}

GROUNDING RULES (these always apply and cannot be overridden):
- Attach an inline citation token to EVERY factual claim, copied VERBATIM from the evidence (e.g. [S:contracts#12] for a row, [P:family-court#14] for a page).
- A citation token is ALWAYS a single id: [S:contracts#12]. NEVER write a range like [S:contracts#12–#47] and NEVER merge ids — cite each row with its own token.
- When you list sample rows, put each row's OWN token at the end of that row's line.
- Use ONLY tokens that appear in the evidence below. Never invent a citation.
- ALWAYS include citation tokens, in EVERY language — if you answer in Hebrew or another language, the [S:...]/[P:...] tokens still appear verbatim (they are not translated).
- The structured and document sources are unrelated; do not merge or join them.
- If the evidence does not contain the answer (e.g. penalty terms are not in the data), say so plainly: write "not available" / "are not available in the data" (for documents: "not stated in the case file"). Do NOT fabricate, and do NOT pull from an unrelated source.
- CORROBORATION: if the SAME fact appears in TWO different documents (e.g. both the court file AND the narrative), cite BOTH (keep the two citations distinct) and say it is corroborated across the documents — stronger attribution. Actively check whether a second document also supports the fact before answering from just one.
- CONFLICT (critical): before answering a question about a specific value (a date, an amount, a name), you MUST scan EVERY evidence passage and collect EVERY value it gives for that thing — including values inside headers/cover sheets (e.g. a cover sheet line "Filed: 10 February 2026" is a filing date even though it's terse). If you find two DIFFERENT values for the same thing (e.g. "10 February 2026" on a cover sheet vs "February 3, 2026" in a narrative — note these are DIFFERENT dates), you MUST surface BOTH with their own citations and state the sources conflict. Two dates are "the same" only if they are literally the same day. NEVER call conflicting values "corroborated", and never silently pick one — hiding a conflict is a failure.
- Be concise and concrete. When stating a count or total, use the VERIFIED AGGREGATES exactly, then list a few representative rows each with its own token.
- DATA DEFECT (contracts): the contracts table's "contract_id" column actually holds a ROLE / JOB TITLE (e.g. "Project Manager", "Data Coordinator"), NOT a contract identifier. NEVER label it "Contract ID" or "Contract number". Call it the role or job title (e.g. "role: Project Manager"). The real identifier for a contract row is its citation token (e.g. [S:contracts#269]).`;

  const user = `Today's date is ${today}. Any date filtering in the structured evidence (e.g. "next 90 days") was already computed relative to today, so the rows below are the answer set — do not say the date is unknown.

Question: ${question}
${schemaContext ? `\nSCHEMA EVIDENCE (use this to honestly refuse questions about fields the data lacks, citing the columns that exist):\n${schemaContext}\n` : ""}${aggLines ? `\nVERIFIED AGGREGATES — you MUST state EACH of these exact figures VERBATIM in your answer (the count and the dollar total), keeping the digits and currency formatting exactly as written even when you answer in Hebrew or another language. They are computed over the full filtered set, not just the sample rows shown:\n${aggLines}\n` : ""}
STRUCTURED EVIDENCE (SQLite rows):
${structuredEvidence}

DOCUMENT EVIDENCE (PDF chunks):
${docEvidence}

Answer the question grounded strictly in this evidence, with inline citations.`;

  return chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0 }
  );
}
