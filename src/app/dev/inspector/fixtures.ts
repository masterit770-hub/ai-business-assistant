// DEV-ONLY UI render fixtures for the Inspector preview page (/dev/inspector).
//
// These are NOT a substitute for the live engine: this app's #1 rule is "no mock
// passed off as real". This file exists ONLY so the Inspector UI can be rendered +
// screenshotted in an environment WITHOUT an LLM_API_KEY (the live LLM call needs a
// key the dev box doesn't have). The SHAPE here is exactly the engine's AnswerResult
// (src/lib/engine/answer.ts), and the values mirror a real golden answer (the Carter
// case-file question + the contracts question) so the preview is faithful. On a
// deploy WITH a key, /dashboard renders this same UI from the REAL engine response —
// these fixtures are never shown there.
import type { EngineResult } from "@/components/assistant/types";

// A grounded case-file answer (documents lane) — exercises the document-retrieval
// table with realistic per-passage cosine scores (multilingual-e5 band) and the
// citation chips. Mirrors the golden "Carter parties / what was decided" answer.
export const CASE_FILE_RESULT: EngineResult = {
  question: "Who are the parties in the Carter family court case, and what was decided?",
  route: {
    sources: ["documents"],
    intents: [],
    docFilter: null,
    rationale:
      "The question is narrative/legal and about the Carter case file, so it routes to the document (PDF) lane and is answered from the retrieved case-file passages.",
  },
  answer:
    "The parties are Michael Carter (petitioner) and Sarah Carter (respondent) [P:family-court#2]. The court granted joint legal custody of the two minor children, with primary physical residence to Sarah Carter and a fixed parenting-time schedule for Michael Carter [P:family-court#6]. Child support was set at $1,285 per month payable by Michael Carter [P:family-court#6]. The narrative account corroborates the joint-custody outcome [P:carter-story#3].",
  mode: "grounded",
  grounded: true,
  evidence: {
    rows: [],
    chunks: [
      { doc: "family-court", page: 2, token: "[P:family-court#2]", text: "In re the marriage of Michael Carter and Sarah Carter…", score: 0.883 },
      { doc: "family-court", page: 6, token: "[P:family-court#6]", text: "The court orders joint legal custody… child support of $1,285 per month…", score: 0.871 },
      { doc: "carter-story", page: 3, token: "[P:carter-story#3]", text: "After mediation the Carters agreed to share custody…", score: 0.804 },
      { doc: "family-court", page: 1, token: "[P:family-court#1]", text: "Cover sheet — Superior Court, Family Division…", score: 0.762 },
    ],
  },
  validation: { ok: true, reasons: [] },
  inspector: {
    retrievalMethod: "dense cosine similarity (multilingual-e5, local)",
    passages: 4,
    evidenceCount: 4,
    confidence: { value: 0.88, basis: "top retrieval score 0.883; citation check passed" },
    steps: [
      {
        key: "router",
        label: "Router",
        status: "ok",
        detail:
          "The question is narrative/legal and about the Carter case file, so it routes to the document (PDF) lane.",
      },
      {
        key: "sources",
        label: "Sources",
        status: "ok",
        detail: "Selected documents.",
      },
      {
        key: "retrieval",
        label: "Retrieval",
        status: "ok",
        detail: "Retrieved 0 structured row(s) + 4 document passage(s).",
      },
      {
        key: "generation",
        label: "Generation",
        status: "ok",
        detail:
          "Grounded generation — answer constrained to the retrieved evidence, with inline citations.",
      },
      {
        key: "safety",
        label: "Safety",
        status: "ok",
        detail: "Citation check passed — every cited fact resolves to retrieved evidence.",
      },
    ],
    timings: { routingMs: 612, retrievalMs: 138, generationMs: 2143, totalMs: 2901 },
    cost: {
      liveCalls: 2,
      promptTokens: 1840,
      completionTokens: 142,
      usd: 0.0007,
      pricingNote: "Priced at deepseek-chat rates. Embeddings run locally (no API cost).",
      provider: "deepseek",
      model: "deepseek-chat",
    },
  },
};

// A grounded structured (SQL lane) answer — the golden contracts expiry question.
// No document chunks → the retrieval table shows the structured rows as exact matches.
export const CONTRACTS_RESULT: EngineResult = {
  question: "Which contracts expire in the next 90 days?",
  route: {
    sources: ["structured"],
    intents: [{ name: "contracts_expiring", params: { days: 90 } }],
    docFilter: null,
    rationale:
      "A business-operations question about contract expiry dates routes to the structured (SQL) lane and runs the contracts_expiring intent.",
  },
  answer:
    "38 vendor contracts expire in the next 90 days, with a combined annual value of $18,924,883.79 [S:contracts#12]. Representative rows include the Project Manager role contract [S:contracts#12] and the Data Coordinator role contract [S:contracts#47].",
  mode: "grounded",
  grounded: true,
  evidence: {
    rows: [
      { table: "contracts", id: 12, token: "[S:contracts#12]", data: { vendor: "Skalith", annual_cost: 25629.5 } },
      { table: "contracts", id: 47, token: "[S:contracts#47]", data: { vendor: "Northwind", annual_cost: 41120 } },
      { table: "contracts", id: 88, token: "[S:contracts#88]", data: { vendor: "Oyoba", annual_cost: 18994 } },
    ],
    chunks: [],
  },
  validation: { ok: true, reasons: [] },
  inspector: {
    retrievalMethod: "SQL lane (structured intents)",
    passages: 0,
    evidenceCount: 3,
    confidence: { value: 0.9, basis: "exact structured (SQL) match; citation check passed" },
    steps: [
      {
        key: "router",
        label: "Router",
        status: "ok",
        detail:
          "A business-operations question about contract expiry dates routes to the structured (SQL) lane.",
      },
      {
        key: "sources",
        label: "Sources",
        status: "ok",
        detail: "Selected structured · intents: contracts_expiring.",
      },
      {
        key: "retrieval",
        label: "Retrieval",
        status: "ok",
        detail: "Retrieved 38 structured row(s) + 0 document passage(s).",
      },
      {
        key: "generation",
        label: "Generation",
        status: "ok",
        detail:
          "Grounded generation — answer constrained to the retrieved evidence, with inline citations.",
      },
      {
        key: "safety",
        label: "Safety",
        status: "ok",
        detail: "Citation check passed — every cited fact resolves to retrieved evidence.",
      },
    ],
    timings: { routingMs: 588, retrievalMs: 9, generationMs: 1740, totalMs: 2337 },
    cost: {
      liveCalls: 2,
      promptTokens: 1074,
      completionTokens: 106,
      usd: 0.0004,
      pricingNote: "Priced at deepseek-chat rates. Embeddings run locally (no API cost).",
      provider: "deepseek",
      model: "deepseek-chat",
    },
  },
};

// A general-knowledge answer (no matching source) — the alimony fallback. Exercises
// the NONE route, the "insufficient/general" tiles, and the skipped citation check.
export const GENERAL_RESULT: EngineResult = {
  question: "What is the general approach to alimony in Arizona divorce law?",
  route: {
    sources: [],
    intents: [],
    docFilter: null,
    rationale:
      "The question is about legal practice and strategy, which is not covered by the available sources.",
  },
  answer:
    "In Arizona, spousal maintenance (alimony) is governed by A.R.S. § 25-319. A court first decides whether a spouse QUALIFIES (e.g. lacks sufficient property or earning ability to be self-sufficient), then sets the amount and duration using factors like the marriage length, standard of living, and each spouse's finances. Arizona has no fixed formula — awards are discretionary and often rehabilitative. Confirm specifics with a qualified Arizona family-law attorney for your situation.",
  mode: "general",
  grounded: false,
  evidence: { rows: [], chunks: [] },
  validation: { ok: true, reasons: [] },
  inspector: {
    retrievalMethod: "no source matched — general knowledge",
    passages: 0,
    evidenceCount: 0,
    confidence: { value: 0.4, basis: "general knowledge — no matching evidence in your sources" },
    steps: [
      {
        key: "router",
        label: "Router",
        status: "info",
        detail: "The question is about legal practice and strategy, which is not covered by the available sources.",
      },
      { key: "sources", label: "Sources", status: "skip", detail: "No source matched — no documents or structured data apply." },
      { key: "retrieval", label: "Retrieval", status: "skip", detail: "No evidence retrieved for this question." },
      {
        key: "generation",
        label: "Generation",
        status: "ok",
        detail:
          "General-knowledge generation — no relevant evidence, so answered from the model's general knowledge (uncited).",
      },
      {
        key: "safety",
        label: "Safety",
        status: "info",
        detail: "Citation gate skipped — a general answer legitimately carries no citations.",
      },
    ],
    timings: { routingMs: 597, retrievalMs: 2, generationMs: 1980, totalMs: 2585 },
    cost: {
      liveCalls: 2,
      promptTokens: 880,
      completionTokens: 168,
      usd: 0.0004,
      pricingNote: "Priced at deepseek-chat rates. Embeddings run locally (no API cost).",
      provider: "deepseek",
      model: "deepseek-chat",
    },
  },
};
