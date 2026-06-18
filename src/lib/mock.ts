// ─────────────────────────────────────────────────────────────────────────────
// Mock data for the Nucleus shell. Pure static content — no fetch, no DB, no keys.
// Everything the UI renders comes from here so the app boots clean with `pnpm dev`.
// ─────────────────────────────────────────────────────────────────────────────

export type Urgency = "high" | "medium" | "low";
export type DocType = "PDF" | "XLSX" | "DOCX";
export type SourceKind =
  | "Upload"
  | "Google Drive"
  | "QuickBooks"
  | "Slack"
  | "HubSpot";

export interface Document {
  id: string;
  name: string;
  type: DocType;
  source: SourceKind;
  urgency: Urgency;
  updated: string; // human-readable relative time
  owner: string;
}

export const documents: Document[] = [
  {
    id: "doc-01",
    name: "Q3_Financials.xlsx",
    type: "XLSX",
    source: "QuickBooks",
    urgency: "high",
    updated: "2 hours ago",
    owner: "Dana Whitfield",
  },
  {
    id: "doc-02",
    name: "Acme Corp — Master Services Agreement.pdf",
    type: "PDF",
    source: "Google Drive",
    urgency: "high",
    updated: "Yesterday",
    owner: "Priya Nair",
  },
  {
    id: "doc-03",
    name: "Vendor SOC 2 — Renewal Notice.pdf",
    type: "PDF",
    source: "Upload",
    urgency: "medium",
    updated: "2 days ago",
    owner: "Marcus Reed",
  },
  {
    id: "doc-04",
    name: "FY25 Headcount Plan.xlsx",
    type: "XLSX",
    source: "Google Drive",
    urgency: "medium",
    updated: "3 days ago",
    owner: "Dana Whitfield",
  },
  {
    id: "doc-05",
    name: "Northwind Logistics — Statement of Work.pdf",
    type: "PDF",
    source: "Upload",
    urgency: "low",
    updated: "Apr 28",
    owner: "Priya Nair",
  },
  {
    id: "doc-06",
    name: "Customer Pipeline — May.xlsx",
    type: "XLSX",
    source: "HubSpot",
    urgency: "medium",
    updated: "May 6",
    owner: "Leo Tanaka",
  },
  {
    id: "doc-07",
    name: "Office Lease — 410 Bryant St.pdf",
    type: "PDF",
    source: "Google Drive",
    urgency: "low",
    updated: "Apr 2",
    owner: "Marcus Reed",
  },
  {
    id: "doc-08",
    name: "Engineering Onboarding.docx",
    type: "DOCX",
    source: "Slack",
    urgency: "low",
    updated: "Mar 19",
    owner: "Leo Tanaka",
  },
];

export interface Source {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  itemCount?: number;
  lastSync?: string;
}

export const sources: Source[] = [
  {
    id: "src-drive",
    name: "Google Drive",
    description: "Contracts, decks, and shared folders",
    connected: true,
    itemCount: 1284,
    lastSync: "12 min ago",
  },
  {
    id: "src-qb",
    name: "QuickBooks",
    description: "Ledgers, invoices, and reports",
    connected: true,
    itemCount: 96,
    lastSync: "1 hour ago",
  },
  {
    id: "src-slack",
    name: "Slack",
    description: "Channels, threads, and shared files",
    connected: true,
    itemCount: 7421,
    lastSync: "4 min ago",
  },
  {
    id: "src-hubspot",
    name: "HubSpot",
    description: "Deals, contacts, and notes",
    connected: false,
  },
  {
    id: "src-gmail",
    name: "Gmail",
    description: "Email threads and attachments",
    connected: false,
  },
  {
    id: "src-notion",
    name: "Notion",
    description: "Wikis, docs, and project pages",
    connected: false,
  },
];

export interface Citation {
  source: string;
  detail: string;
}

export interface AnsweredQuestion {
  question: string;
  answer: string;
  metric?: { label: string; value: string };
  citations: Citation[];
}

// The single worked example shown in the dashboard "Ask Nucleus" panel —
// demonstrates the docs-lane + a trustworthy, cited number.
export const sampleAnswer: AnsweredQuestion = {
  question: "What's our total Q3 revenue?",
  answer:
    "Total Q3 revenue was $2.84M, up 18% from Q2. The largest contributor was the Acme Corp renewal ($410K), recognized in September.",
  metric: { label: "Q3 revenue", value: "$2,840,500" },
  citations: [
    { source: "Q3_Financials.xlsx", detail: "Sheet ‘P&L’ · cell B14" },
    { source: "QuickBooks", detail: "Income → Revenue, Jul–Sep" },
  ],
};

export const suggestedQuestions: string[] = [
  "Which contracts renew in the next 30 days?",
  "Summarize the Acme Corp MSA termination clause",
  "What was our gross margin last quarter?",
  "Who owns the Northwind SOW?",
];

export interface PricingTier {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  features: string[];
  cta: string;
  highlighted?: boolean;
}

export const pricingTiers: PricingTier[] = [
  {
    name: "Starter",
    price: "$0",
    cadence: "/ month",
    blurb: "For individuals organizing their first sources.",
    features: [
      "1 workspace",
      "Up to 200 documents",
      "2 connected sources",
      "Ask Nucleus — 100 questions / mo",
      "Community support",
    ],
    cta: "Get started",
  },
  {
    name: "Pro",
    price: "$49",
    cadence: "/ user / month",
    blurb: "For teams that live in their documents and numbers.",
    features: [
      "Unlimited documents",
      "All connectors (QuickBooks, Slack, CRM…)",
      "Trustworthy numbers with citations",
      "Unlimited questions",
      "Priority support",
    ],
    cta: "Start free trial",
    highlighted: true,
  },
  {
    name: "Business",
    price: "$129",
    cadence: "/ user / month",
    blurb: "For companies that need control and audit.",
    features: [
      "Everything in Pro",
      "SSO & SCIM provisioning",
      "Audit log & data residency",
      "Role-based source permissions",
      "Dedicated success manager",
    ],
    cta: "Contact sales",
  },
];

export interface ConnectedSource {
  label: string;
  hint: string;
}

// The chips that orbit the central "Nucleus" node on the landing page.
export const connectedSources: ConnectedSource[] = [
  { label: "PDFs", hint: "Contracts & reports" },
  { label: "Excel", hint: "Models & ledgers" },
  { label: "QuickBooks", hint: "Live financials" },
  { label: "Slack", hint: "Team knowledge" },
  { label: "CRM", hint: "Deals & contacts" },
];

export const currentUser = {
  name: "Dana Whitfield",
  email: "dana@meridian.co",
  initials: "DW",
  role: "Operations Lead",
  company: "Meridian Robotics",
};
