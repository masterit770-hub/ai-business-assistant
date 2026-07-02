"use client";

// CONNECTED SOURCES PANEL (migration: mocked-connectors UX)
//
// Shows all data sources available to a Knowledge Space:
//   1. "Uploaded Documents" — the REAL, functional source. This is the existing per-space
//      file list rendered via MaterialsRail. Fully functional; the answer engine reads ONLY
//      these files. No behavior change to uploads, scoping, or the answer engine.
//   2. Mocked connector cards — PDF Folder, SQLite, Excel, CRM, SharePoint, Google Drive,
//      Outlook, REST API, Local Folder. These are VISUAL ONLY (data-testid="mock-connector-<key>").
//      Each shows a clear "Coming soon" / not-connected status. They do NOT feed the engine
//      or affect answers. Labelled honestly so the client is not misled.
//
// Usage: render inside a space context (spaceId required). The panel is additive — the rest
// of the Sources page layout (SpacesSidebar, header, etc.) is unchanged.

import { MaterialsRail } from "@/components/assistant/materials-rail";
import {
  Folder,
  Database,
  Table2,
  Users,
  Share2,
  FolderOpen,
  Mail,
  Globe,
  HardDrive,
  Clock,
} from "lucide-react";

// The nine mocked connector definitions.
// key        — used in data-testid="mock-connector-<key>"
// label      — human-readable name shown in the card
// icon       — Lucide icon component
// description — short one-line hint of what the connector would do
const MOCK_CONNECTORS: Array<{
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}> = [
  {
    key: "pdf-folder",
    label: "PDF Folder",
    icon: Folder,
    description: "Watch a folder of PDF files",
  },
  {
    key: "sqlite",
    label: "SQLite",
    icon: Database,
    description: "Query a SQLite database file",
  },
  {
    key: "excel",
    label: "Excel",
    icon: Table2,
    description: "Connect to an Excel workbook",
  },
  {
    key: "crm",
    label: "CRM",
    icon: Users,
    description: "Pull data from your CRM",
  },
  {
    key: "sharepoint",
    label: "SharePoint",
    icon: Share2,
    description: "Browse SharePoint document libraries",
  },
  {
    key: "google-drive",
    label: "Google Drive",
    icon: FolderOpen,
    description: "Index files from Google Drive",
  },
  {
    key: "outlook",
    label: "Outlook",
    icon: Mail,
    description: "Import emails and attachments",
  },
  {
    key: "rest-api",
    label: "REST API",
    icon: Globe,
    description: "Fetch data from any REST endpoint",
  },
  {
    key: "local-folder",
    label: "Local Folder",
    icon: HardDrive,
    description: "Watch a folder on this machine",
  },
];

type ConnectedSourcesProps = {
  // The active space ID. Required — this panel is only rendered inside a space.
  spaceId: string;
  // Passed through to MaterialsRail so the upload + file list are space-scoped.
  sessionId?: string;
  // Mode: "global" shows the informational note; "chat" shows the upload control.
  // Inside a space on the Sources page we default to "global" (no inline upload).
  mode?: "global" | "chat";
};

export function ConnectedSources({
  spaceId,
  sessionId,
  mode = "global",
}: ConnectedSourcesProps) {
  return (
    <div
      data-testid="connected-sources"
      className="flex flex-col gap-6"
    >
      {/* Section header */}
      <div>
        <h2 className="font-display text-base font-bold tracking-tight text-ink">
          Connected Sources
        </h2>
        <p className="mt-0.5 text-xs text-faint">
          The data sources this Knowledge Space can read from. Only Uploaded Documents
          currently feed the AI — additional connectors are coming soon.
        </p>
      </div>

      {/* ── SOURCE 1: Uploaded Documents (REAL, FUNCTIONAL) ── */}
      <section
        data-testid="source-uploaded-docs"
        className="rounded-2xl border-2 border-accent-ring/60 bg-surface shadow-soft"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <span className="inline-flex items-center rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
            Active
          </span>
          <span className="text-sm font-semibold text-ink">Uploaded Documents</span>
          <span className="ml-auto text-[11px] text-faint">
            PDF · Excel · CSV · Word
          </span>
        </div>
        <div className="p-4">
          <MaterialsRail mode={mode} sessionId={sessionId} spaceId={spaceId} />
        </div>
      </section>

      {/* ── MOCKED CONNECTORS (VISUAL ONLY) ── */}
      <section>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-faint">
          Additional connectors
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MOCK_CONNECTORS.map(({ key, label, icon: Icon, description }) => (
            <div
              key={key}
              data-testid={`mock-connector-${key}`}
              className="relative flex flex-col gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 opacity-70"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-faint" />
                <span className="text-sm font-semibold text-ink">{label}</span>
                {/* Status badge — the canonical testid the journey checks */}
                <span
                  data-testid={`mock-connector-status-${key}`}
                  aria-label="Coming soon — not yet connected"
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-faint"
                >
                  <Clock className="size-2.5" />
                  Coming soon
                </span>
              </div>
              <p className="text-[11px] text-faint">{description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
