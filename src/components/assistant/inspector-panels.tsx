"use client";

import { useState } from "react";
import {
  HelpCircle,
  Shuffle,
  Search,
  Layers,
  Sparkles,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Database,
  Check,
  X,
  ArrowRight,
} from "lucide-react";
import type { EngineResult } from "./types";
import { cn } from "@/lib/utils";
import { extractCitationTokens } from "@/lib/engine/citations";

const isHebrew = (s: string) => /[֐-׿]/.test(s);

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const statusDot: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  skip: "bg-faint",
  info: "bg-accent",
};

// ── Status tiles row (QUESTION · ROUTE · RETRIEVAL · EVIDENCE · ANSWER · CITATIONS)
export function StatusTiles({ result }: { result: EngineResult }) {
  const insp = result.inspector;
  // Guard: result.route.sources may be absent on legacy/malformed persisted turns;
  // treat any non-array as an empty list so the label reads "NONE" rather than crashing.
  const sources: string[] = Array.isArray(result.route?.sources) ? result.route.sources : [];
  const routeLabel =
    sources.length === 0 ? "NONE" : sources.length > 1 ? "HYBRID" : sources[0].toUpperCase();
  const passages = insp?.passages ?? result.evidence.chunks.length;
  const evidence = insp?.evidenceCount ?? result.evidence.rows.length + result.evidence.chunks.length;
  const isGeneral = result.grounded === false || result.mode === "general";
  const lang = isHebrew(result.answer) ? "Hebrew" : "English";
  // Is the answer actually grounded in the user's evidence? Derive it from the answer
  // ITSELF — does it cite resolvable [S:…]/[P:…] tokens AND pass the citation gate? — not
  // solely the raw evidence counter. A cell-tally count answer (e.g. "who is scheduled the
  // most") has evidenceCount 0 (the count is computed by code over the grid, so no per-row
  // evidence is attached) yet IS grounded: it cites the structured rows and validateAnswer
  // passed. Keying "insufficient" off `evidence === 0` alone mislabeled that real grounded
  // answer as having no evidence. GENERAL — it reads the citation tokens the user actually
  // saw (same extractor the logger uses), not any value/keyword, so it holds on unseen data.
  const isCitedGrounded =
    extractCitationTokens(result.answer).length > 0 && result.validation.ok === true;
  const answerState = isCitedGrounded
    ? "grounded"
    : isGeneral
      ? evidence === 0
        ? "insufficient"
        : "general"
      : result.validation.ok
        ? "grounded"
        : "rejected";
  // CITATIONS tile — kept consistent with the ANSWER verdict. For a cited-grounded answer
  // whose count was code-computed (no per-row evidence), the honest citation count is the
  // number of distinct tokens the user actually saw in the answer; validation passed, so
  // the check reads OK. Otherwise: a real general answer carries no citations (count 0,
  // skipped), and a normal grounded answer counts its retrieved rows/chunks.
  const evidenceCitations = result.evidence.rows.length + result.evidence.chunks.length;
  const citationsCount = isCitedGrounded
    ? evidenceCitations || new Set(extractCitationTokens(result.answer)).size
    : isGeneral
      ? 0
      : evidenceCitations;
  const citationsOk = isCitedGrounded ? true : isGeneral ? false : result.validation.ok;

  const tiles: {
    label: string;
    value: string;
    icon: typeof HelpCircle;
    tone: "neutral" | "accent" | "ok" | "warn";
    badge?: "check" | "cross";
  }[] = [
    { label: "Question", value: lang, icon: HelpCircle, tone: "neutral" },
    {
      label: "Route",
      value: routeLabel,
      icon: Shuffle,
      tone: routeLabel === "NONE" ? "neutral" : "accent",
    },
    {
      label: "Retrieval",
      value: `${passages} passage${passages === 1 ? "" : "s"}`,
      icon: Search,
      tone: passages > 0 ? "accent" : "neutral",
    },
    {
      label: "Evidence",
      value: String(evidence),
      icon: Layers,
      tone: evidence > 0 ? "accent" : "neutral",
    },
    {
      label: "Answer",
      value: answerState,
      icon: Sparkles,
      tone: answerState === "grounded" ? "ok" : answerState === "rejected" ? "warn" : "neutral",
    },
    {
      label: "Citations",
      value: String(citationsCount),
      icon: ShieldCheck,
      tone: citationsOk ? "ok" : "neutral",
      // Show the verified-check badge whenever the answer is grounded (cited + validated),
      // including the cell-tally case; a genuine general answer shows no badge.
      badge: isCitedGrounded ? "check" : isGeneral ? undefined : citationsOk ? "check" : "cross",
    },
  ];

  return (
    <div
      className="flex items-stretch gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-3 shadow-soft"
      data-testid="status-tiles"
    >
      {tiles.map((t, i) => (
        <div key={t.label} className="flex items-center gap-1">
          <div className="flex min-w-[92px] flex-col items-center gap-1.5 px-2 text-center">
            <span
              className={cn(
                "flex size-9 items-center justify-center rounded-xl border",
                t.tone === "accent" && "border-accent-ring bg-accent-soft text-accent",
                t.tone === "ok" && "border-ok/30 bg-ok-soft text-ok",
                t.tone === "warn" && "border-warn/30 bg-warn-soft text-warn",
                t.tone === "neutral" && "border-line bg-surface-2 text-faint"
              )}
            >
              <t.icon className="size-4" strokeWidth={2} />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">
              {t.label}
            </span>
            <span className="flex items-center gap-1 text-[13px] font-medium capitalize text-ink">
              {t.value}
              {t.badge === "check" && <Check className="size-3 text-ok" strokeWidth={3} />}
              {t.badge === "cross" && <X className="size-3 text-warn" strokeWidth={3} />}
            </span>
          </div>
          {i < tiles.length - 1 && (
            <ArrowRight className="size-3.5 shrink-0 text-faint/50" strokeWidth={2.5} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── A collapsible panel shell used by every inspector section ────────────────
function Panel({
  icon: Icon,
  title,
  chip,
  right,
  defaultOpen = true,
  testid,
  children,
}: {
  icon: typeof Shuffle;
  title: string;
  chip?: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  testid?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid={testid}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-faint" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-faint" />
        )}
        <Icon className="size-4 shrink-0 text-accent" strokeWidth={2} />
        <span className="font-display text-[15px] font-semibold text-ink">{title}</span>
        {chip}
        <span className="ml-auto flex items-center gap-2">{right}</span>
      </button>
      {open && <div className="border-t border-line px-4 py-4">{children}</div>}
    </div>
  );
}

// ── Routing decision ─────────────────────────────────────────────────────────
export function RoutingDecision({ result }: { result: EngineResult }) {
  const insp = result.inspector;
  // Guard: same defensive coercion as StatusTiles — legacy rows may have a non-array here.
  const sources: string[] = Array.isArray(result.route?.sources) ? result.route.sources : [];
  const routeLabel =
    sources.length === 0 ? "NONE" : sources.length > 1 ? "HYBRID" : sources[0].toUpperCase();
  const conf = insp?.confidence;
  const lang = isHebrew(result.answer) ? "he" : "en";

  return (
    <Panel
      icon={Shuffle}
      title="Routing decision"
      testid="routing-decision"
      chip={
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold",
            routeLabel === "NONE"
              ? "bg-surface-2 text-faint"
              : "bg-accent-soft text-accent"
          )}
        >
          <span className={cn("size-1.5 rounded-full", routeLabel === "NONE" ? "bg-faint" : "bg-accent")} />
          {routeLabel}
        </span>
      }
      right={
        conf ? (
          <span
            className="rounded-md bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent"
            title={`Derived confidence — from: ${conf.basis}`}
            data-testid="confidence"
          >
            {pct(conf.value)} confidence
          </span>
        ) : null
      }
    >
      <p className="text-sm leading-relaxed text-subtle">
        {result.route.rationale?.trim() || "Routed by the query router."}
      </p>
      {sources.length === 0 && (
        <p className="mt-2 text-sm text-faint">No matching evidence found in your sources.</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] font-medium text-subtle">
          languages: {lang}
        </span>
        {result.route.docFilter && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] font-medium text-subtle">
            doc: {result.route.docFilter}
          </span>
        )}
      </div>
      {conf && (
        <p className="mt-3 text-xs text-faint">
          Confidence is <span className="font-medium text-subtle">derived</span> from real signals
          ({conf.basis}) — not a model-reported probability.
        </p>
      )}
    </Panel>
  );
}

// ── Orchestrator trace ───────────────────────────────────────────────────────
export function OrchestratorTrace({ result }: { result: EngineResult }) {
  const steps = result.inspector?.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <Panel
      icon={Layers}
      title="Orchestrator trace"
      testid="orchestrator-trace"
      right={<span className="text-xs text-faint">{steps.length} steps</span>}
    >
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={cn("mt-1 size-2.5 rounded-full", statusDot[s.status])} />
              {i < steps.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}
            </div>
            <div className="flex-1 pb-1">
              <span className="text-[13px] font-semibold text-ink">{s.label}</span>
              <p className="mt-0.5 text-[13px] leading-relaxed text-subtle">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ── Document retrieval table (REAL hybrid dense / BM25 / RRF per passage) ─────
export function DocumentRetrieval({ result }: { result: EngineResult }) {
  const insp = result.inspector;
  const chunks = result.evidence.chunks;
  const rows = result.evidence.rows;
  // Rank by the REAL fused RRF score (desc) — the value the engine ordered by. Fall
  // back to `score` (which IS the rrf score for a hybrid result) so order is stable.
  const ranked = [...chunks].sort(
    (a, b) => (b.rrfScore ?? b.score ?? 0) - (a.rrfScore ?? a.score ?? 0)
  );
  const maxRrf = Math.max(0.0001, ...ranked.map((c) => c.rrfScore ?? c.score ?? 0));
  // Are these hybrid results (carrying real dense/BM25 ranks)? Every uploaded + bundled
  // chunk now does; the flag just guards the legacy/empty case.
  const isHybrid = ranked.some((c) => c.denseRank !== undefined || c.rrfScore !== undefined);
  // A rank of 0 means "that lane did not rank this chunk" (e.g. no keyword overlap → no
  // BM25 rank). Show it as an em dash, not "0", so the absence is honest.
  const rankCell = (r?: number) => (r === undefined ? "n/a" : r === 0 ? "—" : `#${r}`);

  return (
    <Panel
      icon={Search}
      title="Document retrieval"
      testid="document-retrieval"
      right={
        <span className="text-xs text-faint">
          {chunks.length} passage{chunks.length === 1 ? "" : "s"}
          {rows.length ? ` · ${rows.length} row${rows.length === 1 ? "" : "s"}` : ""}
        </span>
      }
    >
      {/* Honest method label — the document lane is a REAL hybrid (dense × BM25 → RRF). */}
      <p className="text-[13px] text-subtle">
        Retrieval method:{" "}
        <span className="font-medium text-ink">{insp?.retrievalMethod ?? "—"}</span>
      </p>
      {/* The hybrid-lane config chips ONLY apply when the documents lane actually ran. */}
      {chunks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[
            "embed: multilingual-e5 (local)",
            "dense: cosine",
            "lexical: BM25",
            "fusion: RRF (k=60)",
            "top_k: 8",
          ].map((chip) => (
            <span
              key={chip}
              className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-faint"
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      {/* Document passages — REAL hybrid dense rank, BM25 rank, RRF score */}
      {ranked.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-[13px]" data-testid="retrieval-table">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-3 py-2 font-semibold">#</th>
                <th className="px-3 py-2 font-semibold">Document</th>
                <th className="px-2 py-2 text-center font-semibold">p.</th>
                <th className="px-2 py-2 text-center font-semibold" title="Dense (cosine) ranking">
                  dense
                </th>
                <th className="px-2 py-2 text-center font-semibold" title="BM25 (lexical/keyword) ranking">
                  BM25
                </th>
                <th className="px-3 py-2 font-semibold" title="Reciprocal Rank Fusion score (k=60)">
                  RRF
                </th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((c, i) => {
                const rrf = c.rrfScore ?? c.score ?? 0;
                return (
                  <tr key={c.token} className="border-t border-line">
                    <td className="px-3 py-2 text-faint tabular">{i + 1}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                        <FileText className="size-3.5 text-accent" />
                        {c.doc}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center tabular text-subtle">{c.page}</td>
                    <td className="px-2 py-2 text-center tabular text-subtle" data-testid="dense-rank">
                      {rankCell(c.denseRank)}
                    </td>
                    <td className="px-2 py-2 text-center tabular text-subtle" data-testid="bm25-rank">
                      {rankCell(c.bm25Rank)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                          <span
                            className="block h-full rounded-full bg-accent"
                            style={{ width: `${Math.round((rrf / maxRrf) * 100)}%` }}
                          />
                        </span>
                        <span className="tabular text-xs text-subtle" data-testid="rrf-score">
                          {isHybrid ? rrf.toFixed(4) : "n/a"}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Structured rows (SQL lane) — these have no cosine score, shown as exact matches */}
      {rows.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-3 py-2 font-semibold">Structured row (SQL lane)</th>
                <th className="px-3 py-2 text-right font-semibold">match</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.token} className="border-t border-line">
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                      <Database className="size-3.5 text-accent" />
                      {r.token} · {r.table}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs font-medium text-ok">exact</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ranked.length === 0 && rows.length === 0 && (
        <p className="mt-4 text-sm text-faint">No documents retrieved for this question.</p>
      )}
    </Panel>
  );
}

// ── Cost & Tokens · Timings · Citation check (three-up footer) ───────────────
export function MetricsPanels({ result }: { result: EngineResult }) {
  const insp = result.inspector;
  if (!insp) return null;
  const { cost, timings } = insp;
  const isGeneral = result.grounded === false || result.mode === "general";
  // Guard: validation may be null on legacy persisted rows.
  const validation = result.validation ?? { ok: true, reasons: [] as string[] };
  // A cited + validated answer is grounded even when no per-row evidence is attached
  // (the cell-tally case) — so the citation check reads "verified", not "skipped". Same
  // derivation as StatusTiles: the answer cites resolvable tokens AND the gate passed.
  const isCitedGrounded =
    extractCitationTokens(result.answer).length > 0 && validation.ok === true;

  const tokensLine =
    cost.promptTokens !== undefined
      ? `${cost.promptTokens} in / ${cost.completionTokens ?? 0} out · ${cost.liveCalls} live`
      : `tokens n/a · ${cost.liveCalls} live call${cost.liveCalls === 1 ? "" : "s"}`;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="metrics-panels">
      {/* COST & TOKENS */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Cost &amp; tokens</p>
        <p className="mt-2 flex items-center gap-1.5 font-display text-xl font-bold text-ink">
          <CircleDollarSign className="size-4 text-accent" />
          {cost.usd !== null ? `$${cost.usd.toFixed(4)}` : "$—"}
        </p>
        <p className="mt-1 text-[13px] tabular text-subtle" data-testid="cost-tokens">{tokensLine}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">{cost.pricingNote}</p>
      </div>

      {/* TIMINGS */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Timings</p>
        <dl className="mt-2 space-y-1.5 text-[13px]">
          {[
            ["routing", timings.routingMs],
            ["retrieval", timings.retrievalMs],
            ["generation", timings.generationMs],
            ["total", timings.totalMs],
          ].map(([k, v]) => (
            <div key={k as string} className="flex items-center justify-between">
              <dt className="text-subtle">{k}</dt>
              <dd className="tabular text-ink">{v} ms</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* CITATION CHECK */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Citation check</p>
        <div className="mt-2" data-testid="citation-check">
          {isGeneral && !isCitedGrounded ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-semibold text-faint">
              skipped
            </span>
          ) : validation.ok ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/30 bg-ok-soft px-2.5 py-1 text-xs font-semibold text-ok">
              <Check className="size-3.5" strokeWidth={3} /> verified
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn-soft px-2.5 py-1 text-xs font-semibold text-warn">
              <X className="size-3.5" strokeWidth={3} /> rejected
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          {isGeneral && !isCitedGrounded
            ? "General answer — citation gate skipped (no citations expected)."
            : validation.ok
              ? "Every cited fact resolves to retrieved evidence (validateAnswer passed)."
              : validation.reasons.join("; ")}
        </p>
      </div>
    </div>
  );
}
