"use client";

import { useState } from "react";
import { LayoutGrid, ScanSearch } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { AnswerView } from "@/components/assistant/answer-view";
import {
  StatusTiles,
  RoutingDecision,
  OrchestratorTrace,
  DocumentRetrieval,
  MetricsPanels,
} from "@/components/assistant/inspector-panels";
import { cn } from "@/lib/utils";
import { CASE_FILE_RESULT, CONTRACTS_RESULT, GENERAL_RESULT } from "./fixtures";
import type { EngineResult } from "@/components/assistant/types";

// DEV-ONLY render harness for the Inspector UI (no LLM key needed). It feeds the
// SAME components /dashboard uses, with fixtures that mirror real golden answers, so
// the layout/theme can be screenshotted offline. The live engine drives the real
// page on a deploy with a key — this route is excluded from that experience.
const FIXTURES: { key: string; label: string; result: EngineResult }[] = [
  { key: "case", label: "Case file (documents)", result: CASE_FILE_RESULT },
  { key: "contracts", label: "Contracts (SQL)", result: CONTRACTS_RESULT },
  { key: "general", label: "General knowledge", result: GENERAL_RESULT },
];

export default function DevInspectorPage() {
  const [fix, setFix] = useState("case");
  const [tab, setTab] = useState<"workspace" | "inspector">("inspector");
  const result = FIXTURES.find((f) => f.key === fix)!.result;

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="chat" />
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-7 py-4">
          <div className="mr-auto">
            <h1 className="font-display text-xl font-bold tracking-tight text-ink">
              NUCLEUS 770
            </h1>
            <p className="text-sm text-faint">
              Inspector preview (UI render from engine structure)
            </p>
          </div>
          {/* fixture picker */}
          <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1">
            {FIXTURES.map((f) => (
              <button
                key={f.key}
                onClick={() => setFix(f.key)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                  fix === f.key ? "bg-accent text-accent-fg shadow-soft" : "text-subtle hover:text-ink"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* tab toggle */}
          <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1">
            <button
              onClick={() => setTab("workspace")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors",
                tab === "workspace" ? "bg-accent text-accent-fg shadow-soft" : "text-subtle hover:text-ink"
              )}
            >
              <LayoutGrid className="size-3.5" /> Workspace
            </button>
            <button
              onClick={() => setTab("inspector")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors",
                tab === "inspector" ? "bg-accent text-accent-fg shadow-soft" : "text-subtle hover:text-ink"
              )}
            >
              <ScanSearch className="size-3.5" /> Inspector
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {/* the question, echoed */}
            <div className="rounded-2xl border border-line bg-surface px-5 py-3.5 shadow-soft">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Question</p>
              <p className="mt-1 text-sm font-medium text-ink">{result.question}</p>
            </div>

            <StatusTiles result={result} />

            {tab === "workspace" ? (
              <div className="rounded-2xl border border-line bg-surface p-5 shadow-soft">
                <AnswerView result={result} />
              </div>
            ) : (
              <div className="space-y-3">
                <RoutingDecision result={result} />
                <OrchestratorTrace result={result} />
                <DocumentRetrieval result={result} />
                <MetricsPanels result={result} />
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
