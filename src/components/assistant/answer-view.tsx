"use client";

import { useState } from "react";
import {
  FileText,
  Database,
  Sparkles,
  Server,
  ShieldCheck,
  ShieldAlert,
  Copy,
  Check,
  RotateCcw,
} from "lucide-react";
import type { EngineResult } from "./types";
import { cn } from "@/lib/utils";
import { resolveCitation, buildCopyText, formatCostLine, type ResolvedCitation } from "./answer-helpers";

const CITE_RE = /(\[(?:S|P):[^\]#]+#\d+\])/g;
// Non-global twin for a stateless per-part test (a global regex's lastIndex makes
// repeated .test() calls return alternating results — a classic footgun).
const CITE_ONE = /^\[(?:S|P):[^\]#]+#\d+\]$/;
const isHebrew = (s: string) => /[֐-׿]/.test(s);

// One clickable citation chip. The chip text is the same token the engine stamped on the
// evidence item, so we resolve it back to the cited source (a passage's text, or a row's
// field/value pairs) and reveal it inline on click. A token with no matching evidence
// renders as a PLAIN chip (no toggle, no crash) — see resolveCitation() returning null.
function CitationChip({
  token,
  resolved,
}: {
  token: string;
  resolved: ResolvedCitation;
}) {
  const [open, setOpen] = useState(false);
  const isSql = token.startsWith("[S:");

  // No matching evidence → inert chip (the product never crashes on a stray token).
  if (!resolved) {
    return (
      <span
        className={cn(
          "mx-0.5 inline-flex items-center rounded-md border px-1 py-px align-baseline text-[10px] font-medium",
          isSql ? "border-accent-ring bg-accent-soft text-accent" : "border-line bg-surface-2 text-subtle"
        )}
        title="Citation — no matching retrieved evidence on this turn"
      >
        {token}
      </span>
    );
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="citation-chip"
        className={cn(
          "mx-0.5 inline-flex cursor-pointer items-center rounded-md border px-1 py-px align-baseline text-[10px] font-medium transition-colors hover:brightness-95",
          isSql
            ? "border-accent-ring bg-accent-soft text-accent"
            : "border-line bg-surface-2 text-subtle",
          open && "ring-2 ring-accent/30"
        )}
        title="Show the cited source"
      >
        {token}
      </button>
      {open && (
        <span
          role="dialog"
          data-testid="citation-source"
          className="absolute left-0 top-full z-20 mt-1 block w-[20rem] max-w-[80vw] rounded-xl border border-line bg-surface p-3 text-left shadow-soft"
        >
          {resolved.kind === "passage" ? (
            <span className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-accent">
                <FileText className="size-3.5" />
                {resolved.doc} · p.{resolved.page}
              </span>
              <span
                className="block whitespace-pre-wrap text-[12px] leading-relaxed text-subtle"
                dir={isHebrew(resolved.text) ? "rtl" : "ltr"}
              >
                {resolved.text || "(no passage text retrieved)"}
              </span>
            </span>
          ) : (
            <span className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-accent">
                <Database className="size-3.5" />
                {resolved.table} · #{resolved.id}
              </span>
              <span className="block divide-y divide-line/60">
                {Object.entries(resolved.data).length === 0 ? (
                  <span className="block py-1 text-[12px] text-faint">(no fields retrieved)</span>
                ) : (
                  Object.entries(resolved.data).map(([k, v]) => (
                    <span key={k} className="flex items-baseline justify-between gap-3 py-1 text-[12px]">
                      <span className="font-medium text-faint">{k}</span>
                      <span className="text-right font-mono text-ink">{formatValue(v)}</span>
                    </span>
                  ))
                )}
              </span>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Render the grounded answer, turning each [S:...]/[P:...] citation token into a clickable
// chip that reveals its retrieved source inline.
function renderAnswer(text: string, result: EngineResult) {
  return text.split(CITE_RE).map((part, i) => {
    if (CITE_ONE.test(part)) {
      const resolved = resolveCitation(part, result.evidence);
      return <CitationChip key={i} token={part} resolved={resolved} />;
    }
    return <span key={i}>{part}</span>;
  });
}

// Copy-to-clipboard button: copies the answer text + the source list, with a brief
// "Copied" confirmation. Falls back to a no-op if the clipboard API is unavailable.
function CopyButton({ result }: { result: EngineResult }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(buildCopyText(result));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (e.g. insecure context) — silently ignore */
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      data-testid="copy-answer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-subtle transition-colors hover:border-accent-ring hover:text-ink"
      title="Copy the answer and its sources"
    >
      {copied ? (
        <>
          <Check className="size-3.5 text-ok" strokeWidth={2.5} />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3.5" />
          Copy
        </>
      )}
    </button>
  );
}

export function AnswerView({
  result,
  onRetry,
}: {
  result: EngineResult;
  // Re-run THIS answer's question through the normal ask flow (same session/history).
  // Optional so a resumed turn (no live handler) just hides the control.
  onRetry?: (question: string) => void;
}) {
  const rows = result.evidence.rows;
  const chunks = result.evidence.chunks;
  const answerRtl = isHebrew(result.answer);
  const isGeneral = result.grounded === false || result.mode === "general";
  const isLocalGuidance = !!result.localGuidance;
  const costLine = formatCostLine(result);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Answer</p>
        {/* per-answer actions: copy + regenerate */}
        <div className="flex items-center gap-2">
          <CopyButton result={result} />
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(result.question)}
              data-testid="retry-answer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-subtle transition-colors hover:border-accent-ring hover:text-ink"
              title="Re-run this question"
            >
              <RotateCcw className="size-3.5" />
              Regenerate
            </button>
          )}
        </div>
      </div>

      {/* answer text with inline clickable citation chips */}
      <div
        className="whitespace-pre-wrap rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm leading-relaxed text-ink"
        data-testid="answer"
        dir={answerRtl ? "rtl" : "ltr"}
        lang={answerRtl ? "he" : "en"}
      >
        {renderAnswer(result.answer, result)}
      </div>

      {/* cost per answer — plain, honest spend line (real tokens + USD, or "cost n/a") */}
      <p className="px-1 text-[11px] text-faint" data-testid="answer-cost">
        {costLine}
      </p>

      {/* local-setup note */}
      {isLocalGuidance && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-faint" data-testid="local-guidance-note">
          <Server className="size-3.5" />
          <span>Local mode — setup guidance (no answer was generated locally).</span>
        </div>
      )}

      {/* general-knowledge note */}
      {isGeneral && !isLocalGuidance && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-faint" data-testid="general-note">
          <Sparkles className="size-3.5" />
          <span>General knowledge — not from your uploaded documents.</span>
        </div>
      )}

      {/* validation pill (grounded only) */}
      {!isGeneral && (
        <div
          data-testid="validation"
          className={cn(
            "flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs",
            result.validation.ok
              ? "border-ok/30 bg-ok-soft text-ok"
              : "border-warn/30 bg-warn-soft text-warn"
          )}
        >
          {result.validation.ok ? (
            <ShieldCheck className="size-4" />
          ) : (
            <ShieldAlert className="size-4" />
          )}
          <span>
            {result.validation.ok
              ? "Grounded — every cited fact resolves to retrieved evidence (validateAnswer passed)."
              : "Rejected by validateAnswer(): " + result.validation.reasons.join("; ")}
          </span>
        </div>
      )}

      {/* SOURCES — the real retrieved rows / pages, now showing the actual text/data */}
      {!isGeneral && (rows.length > 0 || chunks.length > 0) && (
        <div className="space-y-2" data-testid="sources">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Sources</p>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <details
                key={r.token}
                className="rounded-xl border border-line bg-surface px-3 py-2"
                data-testid="source-row"
              >
                <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-subtle">
                  <span className="font-mono text-[10px] font-semibold text-accent">e{i + 1}</span>
                  <Database className="size-3.5 text-accent" />
                  <span className="text-faint">[{r.table}#{r.id}]</span>
                </summary>
                <div className="mt-2 divide-y divide-line/60">
                  {Object.entries(r.data).length === 0 ? (
                    <p className="py-1 text-[12px] text-faint">(no fields retrieved)</p>
                  ) : (
                    Object.entries(r.data).map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3 py-1 text-[12px]">
                        <span className="font-medium text-faint">{k}</span>
                        <span className="text-right font-mono text-ink">{formatValue(v)}</span>
                      </div>
                    ))
                  )}
                </div>
              </details>
            ))}
            {chunks.map((c, i) => (
              <details
                key={c.token}
                className="rounded-xl border border-line bg-surface px-3 py-2"
                data-testid="source-chunk"
              >
                <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-subtle">
                  <span className="font-mono text-[10px] font-semibold text-accent">
                    e{rows.length + i + 1}
                  </span>
                  <FileText className="size-3.5 text-accent" />
                  <span className="text-faint">
                    [{c.doc} p.{c.page}]
                  </span>
                  {c.score !== undefined && (
                    <span className="ml-auto font-mono text-[10px] text-faint">{c.score.toFixed(3)}</span>
                  )}
                </summary>
                <p
                  className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-subtle"
                  dir={isHebrew(c.text ?? "") ? "rtl" : "ltr"}
                >
                  {c.text || "(no passage text retrieved)"}
                </p>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
