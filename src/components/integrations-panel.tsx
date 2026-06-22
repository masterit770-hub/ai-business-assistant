"use client";

import { useMemo, useState } from "react";
import { Search, Plug, Check, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

// INTEGRATIONS — the connectors gallery. These show the tools the assistant can draw
// from. Setup is handled per-workspace (not wired in this build), so each shows as
// "Available to connect" — honest, not a faked live connection. Clicking Connect marks
// it requested ("we'll enable it for your workspace"). Logos come from the public
// Simple Icons CDN with a colored-initial fallback if the image can't load.
type Integration = { name: string; slug: string; color: string; desc: string; popular?: boolean };
type Category = { name: string; items: Integration[] };

const CATEGORIES: Category[] = [
  {
    name: "Email & communication",
    items: [
      { name: "Gmail", slug: "gmail", color: "#EA4335", desc: "Email & attachments as a source", popular: true },
      { name: "Outlook", slug: "microsoftoutlook", color: "#0078D4", desc: "Microsoft 365 mail & calendar" },
      { name: "Slack", slug: "slack", color: "#4A154B", desc: "Answer from channels & shared files", popular: true },
      { name: "Microsoft Teams", slug: "microsoftteams", color: "#6264A7", desc: "Teams chats & files in context" },
    ],
  },
  {
    name: "Spreadsheets & accounting",
    items: [
      { name: "Microsoft Excel", slug: "microsoftexcel", color: "#217346", desc: "Query workbooks with cited rows", popular: true },
      { name: "Google Sheets", slug: "googlesheets", color: "#34A853", desc: "Live spreadsheets as structured data" },
      { name: "QuickBooks", slug: "quickbooks", color: "#2CA01C", desc: "Invoices, expenses & reports", popular: true },
      { name: "Xero", slug: "xero", color: "#13B5EA", desc: "Accounting & reconciliations" },
      { name: "Stripe", slug: "stripe", color: "#635BFF", desc: "Payments, payouts & disputes" },
    ],
  },
  {
    name: "Projects & productivity",
    items: [
      { name: "Monday.com", slug: "mondaydotcom", color: "#FF3D57", desc: "Boards, items & status", popular: true },
      { name: "Notion", slug: "notion", color: "#0F0F0F", desc: "Docs & databases, searchable" },
      { name: "Asana", slug: "asana", color: "#F06A6A", desc: "Tasks, projects & timelines" },
      { name: "Trello", slug: "trello", color: "#0052CC", desc: "Cards & boards" },
      { name: "Jira", slug: "jira", color: "#0052CC", desc: "Issues & sprints" },
      { name: "Airtable", slug: "airtable", color: "#18BFFF", desc: "Bases as structured sources" },
    ],
  },
  {
    name: "Files & storage",
    items: [
      { name: "Google Drive", slug: "googledrive", color: "#4285F4", desc: "Index docs, sheets & PDFs", popular: true },
      { name: "Dropbox", slug: "dropbox", color: "#0061FF", desc: "Sync folders into sources" },
      { name: "OneDrive", slug: "microsoftonedrive", color: "#0078D4", desc: "Microsoft 365 storage" },
      { name: "Box", slug: "box", color: "#0061D5", desc: "Enterprise content" },
    ],
  },
  {
    name: "CRM & automation",
    items: [
      { name: "Salesforce", slug: "salesforce", color: "#00A1E0", desc: "Accounts, contacts & opportunities" },
      { name: "HubSpot", slug: "hubspot", color: "#FF7A59", desc: "CRM, deals & tickets" },
      { name: "Zapier", slug: "zapier", color: "#FF4F00", desc: "Connect 6,000+ more apps" },
    ],
  },
];

const TOTAL = CATEGORIES.reduce((n, c) => n + c.items.length, 0);

function Logo({ slug, name, color }: { slug: string; name: string; color: string }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
        style={{ background: color }}
      >
        {name[0]}
      </span>
    );
  }
  return (
    // Self-hosted brand SVGs (served from /public/integrations) — no external CDN, so
    // they render reliably for the client. Brands without a logo file fall back to the
    // brand-colored initial tile above.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/integrations/${slug}.svg`}
      alt=""
      width={36}
      height={36}
      onError={() => setErr(true)}
      className="size-9 shrink-0 rounded-xl bg-canvas p-1.5"
    />
  );
}

export function IntegrationsPanel() {
  const [query, setQuery] = useState("");
  const [requested, setRequested] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATEGORIES;
    return CATEGORIES.map((c) => ({
      ...c,
      items: c.items.filter((i) => i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)),
    })).filter((c) => c.items.length > 0);
  }, [query]);

  return (
    <div className="max-w-4xl space-y-6" data-testid="integrations-panel">
      {/* intro + search */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Integrations</h3>
          <p className="mt-1 max-w-xl text-[13px] text-faint">
            Connect your tools so the assistant can answer across them — {TOTAL} available.
            Setup is enabled per workspace; ask your admin to turn one on.
          </p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            data-testid="integrations-search"
            className="h-9 w-60 rounded-xl border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-faint focus:border-accent-ring focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>
      </div>

      {filtered.map((cat) => (
        <section key={cat.name}>
          <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
            {cat.name}
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cat.items.map((it) => {
              const isReq = requested.has(it.slug);
              return (
                <div
                  key={it.slug}
                  data-testid={`integration-${it.slug}`}
                  className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft transition-colors hover:border-line-strong"
                >
                  <Logo slug={it.slug} name={it.name} color={it.color} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink">{it.name}</span>
                      {it.popular && (
                        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                          Popular
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-faint">{it.desc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRequested((s) => new Set(s).add(it.slug))}
                    disabled={isReq}
                    data-testid={`connect-${it.slug}`}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                      isReq
                        ? "cursor-default border-line bg-canvas text-faint"
                        : "border-accent-ring bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg"
                    )}
                  >
                    {isReq ? (
                      <>
                        <Clock className="size-3.5" />
                        Requested
                      </>
                    ) : (
                      <>
                        <Plug className="size-3.5" />
                        Connect
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {filtered.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line bg-canvas px-4 py-6 text-center text-sm text-faint">
          No integrations match “{query}”.
        </p>
      )}

      <div className="flex items-start gap-2 rounded-xl border border-line bg-canvas px-4 py-3 text-xs text-faint">
        <Check className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <span>
          Don’t see your tool? Almost anything can be connected via Zapier or a CSV/Excel
          export — uploads are supported today on the Sources tab.
        </span>
      </div>
    </div>
  );
}
