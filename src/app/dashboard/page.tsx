import { Upload, Search, FileText, FileSpreadsheet, FileType2 } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { AskPanel } from "@/components/ask-panel";
import { UrgencyBadge } from "@/components/urgency-badge";
import { Button } from "@/components/ui/button";
import { documents, type DocType } from "@/lib/mock";
import { cn } from "@/lib/utils";

const typeMeta: Record<DocType, { icon: typeof FileText; className: string }> = {
  PDF: { icon: FileText, className: "text-high bg-high-soft" },
  XLSX: { icon: FileSpreadsheet, className: "text-accent bg-accent-soft" },
  DOCX: { icon: FileType2, className: "text-low bg-low-soft" },
};

function TypePill({ type }: { type: DocType }) {
  const m = typeMeta[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
        m.className
      )}
    >
      <m.icon className="size-3.5" />
      {type}
    </span>
  );
}

const stats = [
  { label: "Documents", value: "1,284" },
  { label: "Connected sources", value: "3" },
  { label: "Questions this month", value: "412" },
];

export default function DashboardPage() {
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
            <Button
              size="lg"
              className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 shadow-soft"
            >
              <Upload className="size-4" />
              Upload
            </Button>
          </header>

          <div className="flex-1 space-y-5 overflow-y-auto px-7 py-6">
            {/* stat cards */}
            <div className="grid grid-cols-3 gap-4">
              {stats.map((s) => (
                <div
                  key={s.label}
                  className="rounded-xl border border-line bg-surface px-5 py-4 shadow-soft"
                >
                  <p className="text-xs font-medium text-faint">{s.label}</p>
                  <p className="tabular mt-1 text-2xl font-semibold text-ink">
                    {s.value}
                  </p>
                </div>
              ))}
            </div>

            {/* search */}
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-soft">
              <Search className="size-4 text-faint" />
              <input
                placeholder="Search documents…"
                className="flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
              />
              <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-faint">
                ⌘K
              </kbd>
            </div>

            {/* table */}
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-canvas/60 text-left">
                    <th className="px-5 py-3 font-semibold text-faint">Name</th>
                    <th className="px-5 py-3 font-semibold text-faint">Type</th>
                    <th className="px-5 py-3 font-semibold text-faint">Source</th>
                    <th className="px-5 py-3 font-semibold text-faint">Urgency</th>
                    <th className="px-5 py-3 font-semibold text-faint">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr
                      key={doc.id}
                      className="border-b border-line last:border-0 transition-colors hover:bg-canvas/50"
                    >
                      <td className="max-w-[280px] px-5 py-3.5">
                        <span className="block truncate font-medium text-ink">
                          {doc.name}
                        </span>
                        <span className="text-xs text-faint">{doc.owner}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <TypePill type={doc.type} />
                      </td>
                      <td className="px-5 py-3.5 text-subtle">{doc.source}</td>
                      <td className="px-5 py-3.5">
                        <UrgencyBadge urgency={doc.urgency} />
                      </td>
                      <td className="tabular px-5 py-3.5 text-faint">
                        {doc.updated}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* right: ask panel */}
        <div className="hidden w-[400px] shrink-0 border-l border-line bg-canvas p-5 xl:block">
          <AskPanel />
        </div>
      </main>
    </div>
  );
}
