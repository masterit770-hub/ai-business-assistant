import { FileText, Table2, ShieldCheck, UserX, Quote } from "lucide-react";

// Small RENDERED (no image) mini-mocks for the feature sections. Every value is
// a real, verified golden — no fabricated data, no named connectors, no pricing.

// A reusable citation chip.
function Chip({ children, tone = "sql" }: { children: React.ReactNode; tone?: "sql" | "doc" }) {
  return (
    <span
      className={
        "tabular inline-flex items-center rounded-md border px-1 py-px align-middle text-[10px] font-medium " +
        (tone === "sql"
          ? "border-accent-ring bg-accent-soft text-accent"
          : "border-line bg-canvas text-subtle")
      }
    >
      {children}
    </span>
  );
}

// (a) A citation on every fact — a maintenance-spend answer, row-cited.
export function CitationMock() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-soft">
      <div className="flex items-center gap-2 text-xs font-medium text-faint">
        <Quote className="size-3.5 text-accent" /> Answer
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink">
        Total maintenance spend is{" "}
        <span className="tabular font-semibold">$40,597.00</span> across 750
        tickets <Chip>[S:maintenance#5]</Chip>;{" "}
        <span className="tabular font-semibold">$13,485.66</span> of that in 2026{" "}
        <Chip>[S:maintenance#685]</Chip>.
      </p>
      <p className="mt-3 text-xs text-faint">
        No source for a claim → the assistant says so, instead of guessing.
      </p>
    </div>
  );
}

// (b) Documents + structured data in one answer — both namespaces, cited.
export function HybridMock() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-soft">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-accent-ring bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
          <Table2 className="size-3" /> Structured · SQL
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-0.5 text-[11px] font-medium text-subtle">
          <FileText className="size-3" /> Documents · RAG
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink">
        The router picks the right source(s) for each question — a count from a
        table, a clause from a page — and composes one answer that cites{" "}
        <Chip>[S:…]</Chip> and <Chip tone="doc">[P:…]</Chip> separately. Never a
        fabricated join.
      </p>
    </div>
  );
}

// (c) English + Hebrew — a REAL RTL cited answer over an English document.
export function HebrewMock() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-soft">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-faint">עברית · RTL</span>
        <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[10px] text-faint">
          English source · Hebrew question
        </span>
      </div>
      <div
        dir="rtl"
        lang="he"
        className="mt-2 rounded-lg bg-canvas px-3 py-2.5 text-right text-sm leading-relaxed text-ink"
      >
        דמי המזונות שנפסקו הם{" "}
        <span className="tabular font-semibold">1,285 דולר לחודש</span>, והמשמורת
        העיקרית ניתנה לג&rsquo;וני קרטר <Chip tone="doc">[P:family-court#24]</Chip>
      </div>
      <p className="mt-2 text-xs text-faint" dir="ltr">
        $1,285/month · primary residence to Joni Carter — the citation is
        preserved across languages.
      </p>
    </div>
  );
}

// (d) Upload PDFs / scanned docs / Excel → ask immediately.
export function UploadMock() {
  const items = [
    { label: "Vendor agreement.pdf", note: "native PDF · 8 pages" },
    { label: "Scanned invoice.png", note: "OCR · text extracted" },
    { label: "Maintenance.xlsx", note: "750 rows · sheet ‘Tickets’" },
  ];
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-soft">
      <ul className="space-y-2">
        {items.map((it) => (
          <li
            key={it.label}
            className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-accent-soft text-accent">
              <FileText className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-ink">{it.label}</p>
              <p className="truncate text-[11px] text-faint">{it.note}</p>
            </div>
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-faint">
        Indexed on upload — query it with citations seconds later.
      </p>
    </div>
  );
}

// (e) Admin-controlled access + instant kick-out + per-user document isolation.
export function AccessMock() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-soft">
      <ul className="space-y-2">
        <li className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-fg">
            DA
          </span>
          <span className="flex-1 text-xs font-medium text-ink">Dana · admin</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-accent/20 bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
            <span className="size-1.5 rounded-full bg-accent" /> Active
          </span>
        </li>
        <li className="flex items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2 opacity-70">
          <span className="flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-faint">
            TB
          </span>
          <span className="flex-1 text-xs font-medium text-ink">Tom · member</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-muted px-2 py-0.5 text-[10px] font-medium text-faint">
            <UserX className="size-3" /> Kicked out
          </span>
        </li>
      </ul>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
        <ShieldCheck className="size-3.5 text-accent" />
        Kick-out is instant; each member only sees their own uploads.
      </p>
    </div>
  );
}
