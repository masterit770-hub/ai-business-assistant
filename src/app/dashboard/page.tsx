"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { AskPanel } from "@/components/ask-panel";
import { UploadButton } from "@/components/upload-button";
import { UploadedDocs } from "@/components/uploaded-docs";
import { BundledDocs } from "@/components/bundled-docs";

export default function DashboardPage() {
  // Real stats from /api/documents: UploadedDocs publishes its count + high-urgency
  // (`nucleus:docs`); BundledDocs publishes the built-in source count
  // (`nucleus:bundled`). "Documents" = the REAL total (bundled + uploaded), so it's
  // never 0 when the assistant can answer from the bundled corpus.
  const [uploaded, setUploaded] = useState<{ total: number; high: number } | null>(null);
  const [bundled, setBundled] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onDocs = (e: Event) => setUploaded((e as CustomEvent).detail);
    const onBundled = (e: Event) => setBundled((e as CustomEvent).detail.count);
    window.addEventListener("nucleus:docs", onDocs);
    window.addEventListener("nucleus:bundled", onBundled);
    return () => {
      window.removeEventListener("nucleus:docs", onDocs);
      window.removeEventListener("nucleus:bundled", onBundled);
    };
  }, []);

  const total = uploaded !== null && bundled !== null ? uploaded.total + bundled : null;
  const stats = [
    { label: "Documents", value: total !== null ? String(total) : null },
    { label: "Your uploads", value: uploaded ? String(uploaded.total) : null },
    { label: "High urgency", value: uploaded ? String(uploaded.high) : null },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="documents" />

      <main className="flex flex-1 overflow-hidden">
        {/* left: documents */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* topbar */}
          <header className="flex items-center justify-between border-b border-line bg-surface px-7 py-4">
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight text-ink">
                Documents
              </h1>
              <p className="text-sm text-faint">
                Everything Nucleus can search and answer from.
              </p>
            </div>
            <UploadButton />
          </header>

          <div className="flex-1 space-y-5 overflow-y-auto px-7 py-6">
            {/* stat cards — REAL counts (bundled + uploaded) */}
            <div className="grid grid-cols-3 gap-4">
              {stats.map((s) => (
                <div
                  key={s.label}
                  className="rounded-xl border border-line bg-surface px-5 py-4 shadow-soft"
                >
                  <p className="text-xs font-medium text-faint">{s.label}</p>
                  <p
                    className="tabular mt-1 text-2xl font-semibold text-ink"
                    data-testid={`stat-${s.label}`}
                  >
                    {s.value ?? <span className="text-faint">—</span>}
                  </p>
                </div>
              ))}
            </div>

            {/* search — wired to filter the uploaded-docs list */}
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-soft">
              <Search className="size-4 text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your documents…"
                aria-label="Search documents"
                className="flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
              />
            </div>

            {/* the user's uploaded documents — urgency badges + remove */}
            <UploadedDocs filter={query} />

            {/* the engine's REAL built-in corpus — what it also answers from */}
            <BundledDocs />

            {/* Ask panel for normal-width screens (the right rail only shows on xl) */}
            <div className="xl:hidden">
              <AskPanel />
            </div>
          </div>
        </div>

        {/* right: ask panel (wide screens) */}
        <div className="hidden w-[400px] shrink-0 border-l border-line bg-canvas p-5 xl:block">
          <AskPanel />
        </div>
      </main>
    </div>
  );
}
