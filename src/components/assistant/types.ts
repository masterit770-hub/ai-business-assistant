// The engine's real /api/ask response shape, mirrored for the client. Kept in sync
// with AnswerResult in src/lib/engine/answer.ts. Everything under `inspector` is
// reconstructed from REAL pipeline state (see answer.ts) — no fabricated metrics.

export type EngineResult = {
  question: string;
  route: {
    sources: string[];
    docFilter: string | null;
    rationale: string;
  };
  answer: string;
  mode?: "grounded" | "general";
  grounded?: boolean;
  localGuidance?: "not-configured" | "unreachable";
  evidence: {
    rows: { table: string; id: number; token: string; data: Record<string, unknown> }[];
    chunks: { doc: string; page: number; token: string; text: string; score?: number }[];
  };
  validation: { ok: boolean; reasons: string[] };
  inspector?: InspectorTrace;
};

export type Confidence = { value: number; basis: string };

export type TraceStep = {
  key: string;
  label: string;
  status: "ok" | "skip" | "warn" | "info";
  detail: string;
};

export type Timings = {
  routingMs: number;
  retrievalMs: number;
  generationMs: number;
  totalMs: number;
};

export type CostReport = {
  liveCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  usd: number | null;
  pricingNote: string;
  provider: string;
  model: string;
};

export type InspectorTrace = {
  retrievalMethod: string;
  passages: number;
  evidenceCount: number;
  confidence: Confidence;
  steps: TraceStep[];
  timings: Timings;
  cost: CostReport;
};
