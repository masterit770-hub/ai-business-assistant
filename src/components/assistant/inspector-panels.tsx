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
  const sources = result.route.sources;
  const routeLabel =
    sources.length === 0 ? "NONE" : sources.length > 1 ? "HYBRID" : sources[0].toUpperCase();
  const passages = insp?.passages ?? result.evidence.chunks.length;
  const evidence = insp?.evidenceCount ?? result.evidence.rows.length + result.evidence.chunks.length;
  const isGeneral = result.grounded === false || result.mode === "general";
  const lang = isHebrew(result.answer) ? "Hebrew" : "English";
  const answerState = isGeneral
    ? evidence === 0
      ? "insufficient"
      : "general"
    : result.validation.ok
      ? "grounded"
      : "rejected";
  const citationsCount = isGeneral ? 0 : result.evidence.rows.length + result.evidence.chunks.length;
  const citationsOk = isGeneral ? false : result.validation.ok;

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
      badge: isGeneral ? undefined : citationsOk ? "check" : "cross",
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
  const sources = result.route.sources;
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
        {result.route.intents.map((i) => (
          <span
            key={i.name}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] font-medium text-subtle"
          >
            intent: {i.name}
          </span>
        ))}
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

// ── Document retrieval table (REAL per-passage scores) ───────────────────────
export function DocumentRetrieval({ result }: { result: EngineResult }) {
  const insp = result.inspector;
  const chunks = result.evidence.chunks;
  const rows = result.evidence.rows;
  // Sort document chunks by real score (desc) for the table.
  const ranked = [...chunks]
    .map((c, i) => ({ ...c, rank: i }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const maxScore = Math.max(0.0001, ...ranked.map((c) => c.score ?? 0));

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
      {/* Honest method label + lane chips — NOT a copied "dense × BM25 → RRF → rerank". */}
      <p className="text-[13px] text-subtle">
        Retrieval method:{" "}
        <span className="font-medium text-ink">{insp?.retrievalMethod ?? "—"}</span>
      </p>
      {/* The dense-lane config chips ONLY apply when the documents lane actually ran. */}
      {chunks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {["embed: multilingual-e5 (local)", "similarity: cosine", "rerank: none", "top_k: 8"].map(
            (chip) => (
              <span
                key={chip}
                className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-faint"
              >
                {chip}
              </span>
            )
          )}
        </div>
      )}

      {/* Document passages — REAL cosine scores */}
      {ranked.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-[13px]" data-testid="retrieval-table">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-3 py-2 font-semibold">#</th>
                <th className="px-3 py-2 font-semibold">Document</th>
                <th className="px-2 py-2 text-center font-semibold">p.</th>
                <th className="px-3 py-2 font-semibold">score (cosine)</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((c, i) => (
                <tr key={c.token} className="border-t border-line">
                  <td className="px-3 py-2 text-faint tabular">{i + 1}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                      <FileText className="size-3.5 text-accent" />
                      {c.doc}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-center tabular text-subtle">{c.page}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                        <span
                          className="block h-full rounded-full bg-accent"
                          style={{ width: `${Math.round(((c.score ?? 0) / maxScore) * 100)}%` }}
                        />
                      </span>
                      <span className="tabular text-xs text-subtle">
                        {c.score !== undefined ? c.score.toFixed(3) : "n/a"}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
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
          {isGeneral ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-semibold text-faint">
              skipped
            </span>
          ) : result.validation.ok ? (
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
          {isGeneral
            ? "General answer — citation gate skipped (no citations expected)."
            : result.validation.ok
              ? "Every cited fact resolves to retrieved evidence (validateAnswer passed)."
              : result.validation.reasons.join("; ")}
        </p>
      </div>
    </div>
  );
}
