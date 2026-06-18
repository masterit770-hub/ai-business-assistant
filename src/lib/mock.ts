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

// Example prompts shown in the Ask panel. These MUST map to the real bundled
// corpus (contracts / maintenance / the Carter case file) so every suggestion
// returns a grounded, cited answer — never a "no source" miss. (The previous set
// named Acme Corp / Northwind / "gross margin", entities that don't exist in the
// data, which contradicted what the Documents view shows.) Verified live to return
// [S:contracts#…] / [S:maintenance#…] / [P:family-court#…] citations.
export const suggestedQuestions: string[] = [
  "How many vendor contracts are there, and what is their combined annual value?",
  "What is the total maintenance spend across all invoices?",
  "Who are the parties in the Carter family court case, and what was decided?",
  "Which contracts expire in the next 90 days?",
];


export const currentUser = {
  name: "Dana Whitfield",
  email: "dana@meridian.co",
  initials: "DW",
  role: "Operations Lead",
  company: "Meridian Robotics",
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin seed data — demo-grade. The Users panel and Prompt config below are
// SHELLS: real, interactive UI over seed data, but NOT auth-enforced (a later
// phase). Labelled "Demo" in the UI so nobody mistakes them for live RBAC.
// ─────────────────────────────────────────────────────────────────────────────

export type MemberStatus = "active" | "invited" | "deactivated";
export type MemberRole = "Owner" | "Admin" | "Member" | "Viewer";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: MemberRole;
  status: MemberStatus;
  lastActive: string;
}

export const teamMembers: TeamMember[] = [
  {
    id: "u-01",
    name: "Dana Whitfield",
    email: "dana@meridian.co",
    initials: "DW",
    role: "Owner",
    status: "active",
    lastActive: "Active now",
  },
  {
    id: "u-02",
    name: "Priya Nair",
    email: "priya@meridian.co",
    initials: "PN",
    role: "Admin",
    status: "active",
    lastActive: "12 min ago",
  },
  {
    id: "u-03",
    name: "Marcus Reed",
    email: "marcus@meridian.co",
    initials: "MR",
    role: "Member",
    status: "active",
    lastActive: "2 hours ago",
  },
  {
    id: "u-04",
    name: "Leo Tanaka",
    email: "leo@meridian.co",
    initials: "LT",
    role: "Member",
    status: "active",
    lastActive: "Yesterday",
  },
  {
    id: "u-05",
    name: "Sofia Alvarez",
    email: "sofia@meridian.co",
    initials: "SA",
    role: "Viewer",
    status: "invited",
    lastActive: "Invite pending",
  },
  {
    id: "u-06",
    name: "Tom Becker",
    email: "tom@contractor.io",
    initials: "TB",
    role: "Viewer",
    status: "deactivated",
    lastActive: "Deactivated Apr 30",
  },
];

// The default prompts the Prompt-config surface edits. The system prompt governs
// grounded generation; the urgency prompt drives the green/amber/red doc badges.
export const defaultSystemPrompt = `You answer business questions using ONLY the retrieved evidence.
- Attach an inline citation token to EVERY factual claim, copied verbatim from the evidence (e.g. [S:contracts#12] for a row, [P:family-court#24] for a page).
- Use ONLY tokens that appear in the evidence. Never invent a citation.
- The structured (SQL) and document (PDF) sources are unrelated — never merge or join them.
- If the evidence does not contain the answer, say so plainly. Do NOT fabricate.
- Be concise and concrete; state verified aggregates exactly.`;

export const defaultUrgencyPrompt = `Classify each document's urgency for the dashboard badge.
- HIGH (red): contracts/notices expiring within 30 days, renewals, anything time-critical or financially material this month.
- MEDIUM (amber): items needing attention this quarter — pending reviews, upcoming renewals 30–90 days out.
- LOW (green): reference material, completed items, nothing time-sensitive.
Return exactly one of: high | medium | low.`;
