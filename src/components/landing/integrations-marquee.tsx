"use client";

import { useState } from "react";

// LANDING integrations showcase — two rows of brand logos auto-scrolling in opposite
// directions (an "advanced" connectors strip). Logos are self-hosted (/public/
// integrations/*.svg); brands without a logo fall back to a brand-colored initial tile.
type Tool = { name: string; slug: string; color: string };

const ROW1: Tool[] = [
  { name: "Gmail", slug: "gmail", color: "#EA4335" },
  { name: "Slack", slug: "slack", color: "#4A154B" },
  { name: "Microsoft Excel", slug: "microsoftexcel", color: "#217346" },
  { name: "Google Sheets", slug: "googlesheets", color: "#34A853" },
  { name: "QuickBooks", slug: "quickbooks", color: "#2CA01C" },
  { name: "Monday.com", slug: "mondaydotcom", color: "#FF3D57" },
  { name: "Notion", slug: "notion", color: "#0F0F0F" },
  { name: "Salesforce", slug: "salesforce", color: "#00A1E0" },
  { name: "HubSpot", slug: "hubspot", color: "#FF7A59" },
  { name: "Stripe", slug: "stripe", color: "#635BFF" },
  { name: "Google Drive", slug: "googledrive", color: "#4285F4" },
];

const ROW2: Tool[] = [
  { name: "Outlook", slug: "microsoftoutlook", color: "#0078D4" },
  { name: "Microsoft Teams", slug: "microsoftteams", color: "#6264A7" },
  { name: "Dropbox", slug: "dropbox", color: "#0061FF" },
  { name: "OneDrive", slug: "microsoftonedrive", color: "#0078D4" },
  { name: "Box", slug: "box", color: "#0061D5" },
  { name: "Asana", slug: "asana", color: "#F06A6A" },
  { name: "Trello", slug: "trello", color: "#0052CC" },
  { name: "Jira", slug: "jira", color: "#0052CC" },
  { name: "Airtable", slug: "airtable", color: "#18BFFF" },
  { name: "Xero", slug: "xero", color: "#13B5EA" },
  { name: "Zapier", slug: "zapier", color: "#FF4F00" },
];

function Chip({ name, slug, color }: Tool) {
  const [err, setErr] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-soft">
      {err ? (
        <span
          className="flex size-7 items-center justify-center rounded-lg text-xs font-bold text-white"
          style={{ background: color }}
        >
          {name[0]}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/integrations/${slug}.svg`}
          alt=""
          width={28}
          height={28}
          onError={() => setErr(true)}
          className="size-7 rounded-lg bg-canvas p-1"
        />
      )}
      <span className="whitespace-nowrap text-sm font-medium text-ink">{name}</span>
    </div>
  );
}

function Row({ tools, reverse }: { tools: Tool[]; reverse?: boolean }) {
  // duplicate the row so the -50% translate loops seamlessly
  const doubled = [...tools, ...tools];
  return (
    <div className={`marquee${reverse ? " marquee-reverse" : ""}`}>
      {doubled.map((t, i) => (
        <Chip key={`${t.slug}-${i}`} {...t} />
      ))}
    </div>
  );
}

export function IntegrationsMarquee() {
  return (
    <div className="marquee-mask space-y-3 py-2">
      <Row tools={ROW1} />
      <Row tools={ROW2} reverse />
    </div>
  );
}
