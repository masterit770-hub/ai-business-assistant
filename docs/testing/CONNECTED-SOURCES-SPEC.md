# Connected Sources (MOCKED) + Predefined Spaces — LOCKED spec (2026-07-01)

**Single source of truth. Do not re-derive from chat.** Client wants the business DOMAIN (Knowledge
Space) separated from the DATA SOURCE (connector). Connectors are **MOCKED** — Chris: "the connectors
can be mocked, she just wants some UX change and some predefined spaces."

## Concept
Workspace (company/account) → Knowledge Spaces (business domains) → **Connected Sources** → Chats.
A Knowledge Space = business context; a Connected Source = where data comes from.

## Scope — MOCKED connectors (UX ONLY; do NOT build real integrations)
- **Real/functional source (unchanged):** "Uploaded Documents" — the files uploaded into the space
  (PDF/Excel/CSV). The answer engine reads ONLY these. **Do NOT change answer-messages.ts,
  listOwnerFiles, the space scoping, or the 6-call journey SDK flow.**
- **Mocked connectors (visual, non-functional):** cards for PDF Folder, SQLite, Excel, CRM,
  SharePoint, Google Drive, Outlook, REST API, Local Folder. Rendered as "available sources" with a
  disabled/"Coming soon" state (or a mock-connected pill that does nothing). They MUST NOT feed the
  engine or affect answers. Clearly labelled as not-yet-connected so the client isn't misled.

## UI
- Inside a space, a **"Connected Sources"** panel (data-testid="connected-sources"):
  - The real **"Uploaded Documents"** source (data-testid="source-uploaded-docs") showing the space's
    file count + list — this IS the existing per-space Sources/materials view, reframed as one source.
  - The **mocked connector cards** (data-testid="mock-connector-<key>") each with a "Coming soon" /
    disabled connect affordance (data-testid="mock-connector-status-<key>").
- Keep every existing feature/tab. Additive only.

## Predefined spaces (demo/admin account 3d1ca025 only; NEVER b01c311e)
Finance, Contracts, HR, Projects, Legal, Sales. (Finance/Contracts/HR already exist; add Projects,
Legal, Sales.) Seed idempotently; the b01c311e guard MUST hold.

## Journey impact (integrated journey, tests/journeys/lifecycle.mjs + knowledge-spaces.mjs)
- **SDK calls UNCHANGED: still 6/run (5 Haiku + 1 Sonnet), 12 total local+prod.** The mock is UI-only.
- **Add ZERO-SDK checks** (in knowledge-spaces.mjs or lifecycle's zero-SDK section):
  - the "Connected Sources" panel renders inside a space;
  - the mocked connector cards render AND show a not-connected/"coming soon" status (they are mocks);
  - the real "Uploaded Documents" source still shows ONLY that space's files (space scoping intact);
  - the predefined spaces (Finance…Sales) appear for the demo account.
- Do NOT add or remove any SDK/agentic call. Re-run the integrated journey to confirm 6 calls + green.

## Definition of done
tsc clean; the Connected-Sources UI + mocked connectors + predefined spaces built; zero-SDK journey
checks added and green; the 6-call integrated journey still passes (unchanged SDK flow). No engine/
scoping changes. Committed to a branch. Lead deploys + verifies prod.

## UNIVERSAL DEFAULT SPACES (added 2026-07-01 — Chris: "predefined space should spawn in ALL accounts + new-created ones universally")
- EVERY account (new signups AND existing accounts, INCLUDING Jenny b01c311e) automatically has the
  6 default spaces: **Finance, Contracts, HR, Projects, Legal, Sales**.
- Implement as **LAZY-INIT in the spaces layer** (in `listSpaces()` / `GET /api/spaces`): if the owner
  has NOT been seeded (check an owner-scoped `spaces_seeded` flag via the existing settings mechanism —
  `getSetting`/`setSetting`, NO migration needed), then create the 6 default spaces (idempotent — skip
  any name that already exists) and `setSetting(owner, "spaces_seeded", "1")`. Runs ONCE per account on
  first spaces access. New signups get them on first load; existing accounts on next load.
- **Respects deletion:** after the flag is set, a user deleting spaces will NOT trigger re-creation
  (gate on the flag, NOT on "0 spaces").
- **Guard note:** the additive default-spaces seed IS allowed on Jenny's account (b01c311e) — Chris
  explicitly wants it universal. The b01c311e guard still applies to any DESTRUCTIVE op (never delete
  her data / files), only the additive default spaces are permitted.
- **Journey (zero-SDK):** assert a NEW account (RUN=A signup) has all 6 default spaces on its first
  `GET /api/spaces`. Still NO new SDK calls.
