"use client";

import { FileText, Database, Sparkles, Server, ShieldCheck, ShieldAlert } from "lucide-react";
import type { EngineResult } from "./types";
import { cn } from "@/lib/utils";

const CITE_RE = /(\[(?:S|P):[^\]#]+#\d+\])/g;
const isHebrew = (s: string) => /[֐-׿]/.test(s);

// Render the grounded answer, turning each [S:...]/[P:...] citation token into a
// small inline violet chip so every fact visibly traces to a source.
function renderAnswer(text: string) {
  return text.split(CITE_RE).map((part, i) => {
    const m = part.match(/^\[(S|P):/);
    if (m) {
      const isSql = m[1] === "S";
      return (
        <span
          key={i}
          className={cn(
            "mx-0.5 inline-flex items-center rounded-md border px-1 py-px align-baseline text-[10px] font-medium",
            isSql
              ? "border-accent-ring bg-accent-soft text-accent"
              : "border-line bg-surface-2 text-subtle"
          )}
          title="Traceable citation — resolves to a retrieved row or page"
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function AnswerView({ result }: { result: EngineResult }) {
  const rows = result.evidence.rows;
  const chunks = result.evidence.chunks;
  const answerRtl = isHebrew(result.answer);
  const isGeneral = result.grounded === false || result.mode === "general";
  const isLocalGuidance = !!result.localGuidance;

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Answer</p>

      {/* answer text with inline citation chips */}
      <div
        className="whitespace-pre-wrap rounded-2xl border border-line bg-surface-2 px-4 py-3 text-sm leading-relaxed text-ink"
        data-testid="answer"
        dir={answerRtl ? "rtl" : "ltr"}
        lang={answerRtl ? "he" : "en"}
      >
        {renderAnswer(result.answer)}
      </div>

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

      {/* SOURCES — the real retrieved rows / pages as eN chips */}
      {!isGeneral && (rows.length > 0 || chunks.length > 0) && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Sources</p>
          <div className="flex flex-wrap gap-2">
            {rows.map((r, i) => (
              <span
                key={r.token}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-subtle"
              >
                <span className="font-mono text-[10px] font-semibold text-accent">e{i + 1}</span>
                <Database className="size-3.5 text-accent" />
                <span className="text-faint">[{r.table}#{r.id}]</span>
                <span className="size-1.5 rounded-full bg-accent" />
              </span>
            ))}
            {chunks.map((c, i) => (
              <span
                key={c.token}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-subtle"
              >
                <span className="font-mono text-[10px] font-semibold text-accent">
                  e{rows.length + i + 1}
                </span>
                <FileText className="size-3.5 text-accent" />
                <span className="text-faint">
                  [{c.doc} p.{c.page}]
                </span>
                <span className="size-1.5 rounded-full bg-accent" />
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
