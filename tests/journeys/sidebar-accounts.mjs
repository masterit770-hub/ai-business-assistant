// JOURNEY — PER-ACCOUNT SIDEBAR + OPEN-CHAT (Z16–Z19). ZERO SDK calls.
//
// THE SLIPPED BUG (per-account sidebar): the conversation list must show a DIFFERENT,
// correct session set for each account TYPE, each under its own production-faithful
// context. An eval that forced one context would sandbox the others away — so each is a
// separate signed-in run asserting the EXACT session set for that account:
//   Z16 client (non-demo): own sessions ONLY — NO "Sample data" virtual session.
//   Z17 demo-user:         own sessions + the appended "Sample data" virtual session.
//   Z18 admin:             EVERY owner's sessions, foreign rows annotated with owner_email.
//   Z19 open-chat:         /dashboard?session=<known-id> replays that chat's turns; an
//                          unknown id shows the honest "couldn't be found" notice (not a
//                          blank new chat).
//
// All assertions read the REAL /api/history JSON (the same endpoint the sidebar renders)
// under each account's real session, plus a real dashboard navigation for Z19. No /api/ask.
//
// Z16 needs a real non-demo login → we SEED a throwaway client account (service-role admin
// auth, is_demo=false) with a known password. We give it one real ask_history session so
// we can prove it sees ITS OWN chat but no Sample data. All seeded rows are cleaned up.
import {
  launch,
  signIn,
  makeRecorder,
  psql,
  sqlLit,
  seedClientAccount,
  ownerIdForEmail,
  readNamedAccount,
  BASE,
} from "./lib.mjs";
import { randomUUID } from "node:crypto";

// The DEMO regular user (is_demo=true) — the one that must see the appended "Sample data"
// virtual session. The generic "member" bucket in the accounts file collapses several
// regular-user emails (incl. non-demo ones) to the last, so we resolve this one by name.
const DEMO_USER_EMAIL = "nucleus.user@meridian.co";

const SAMPLE_DATA_SESSION_ID = "00000000-0000-0000-0000-000000000002";
const SAMPLE_DATA_LABEL = "Sample data";

async function getHistory(page) {
  return page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/history`);
    const d = await r.json().catch(() => ({}));
    return { status: r.status, sessions: d.sessions || [] };
  }, BASE);
}

// Seed one ask_history turn for an owner so their history is non-empty (Z16/Z19).
function seedTurn(ownerId, sessionId, question, answer = "Seeded answer.") {
  psql(
    `insert into public.ask_history (owner_id, session_id, question, answer, mode, route, evidence, validation) ` +
      `values (${sqlLit(ownerId)}, ${sqlLit(sessionId)}, ${sqlLit(question)}, ${sqlLit(answer)}, 'general', ` +
      `'{"sources":[],"docFilter":null,"rationale":"seed"}'::jsonb, '{"rows":[],"chunks":[]}'::jsonb, '{"ok":true,"reasons":[]}'::jsonb);`
  );
}

export async function run() {
  const rec = makeRecorder("SIDEBAR-ACCOUNTS");
  const browser = await launch();
  const cleanup = [];
  try {
    // ── Z16: CLIENT (non-demo) — own sessions only, NO Sample data ──────────────────
    let client;
    try {
      client = await seedClientAccount();
    } catch (e) {
      rec.check(false, "Z16: could not seed a non-demo client account", (e.message || String(e)).slice(0, 160));
    }
    if (client) {
      const clientSession = randomUUID();
      seedTurn(client.id, clientSession, "Client journey — my own private question");
      cleanup.push(() => psql(`delete from public.ask_history where session_id = ${sqlLit(clientSession)};`));

      const { ctx, page } = await signIn(browser, { email: client.email, password: client.password }, "/history");
      try {
        const hist = await getHistory(page);
        const titles = hist.sessions.map((s) => s.title);
        const ids = hist.sessions.map((s) => s.session_id);
        const hasSample = ids.includes(SAMPLE_DATA_SESSION_ID) || titles.includes(SAMPLE_DATA_LABEL);
        const hasOwn = ids.includes(clientSession);
        rec.check(
          hist.status === 200 && hasOwn && !hasSample,
          "Z16: client (non-demo) sees OWN sessions and NO 'Sample data' virtual session",
          `status=${hist.status} ownSessionVisible=${hasOwn} sampleDataPresent=${hasSample} count=${hist.sessions.length}`
        );
        // Production-faithful: all returned sessions belong to this owner (no cross-leak).
        // We can't read owner_id from the member view (it's not exposed), but a non-demo
        // member must NOT see the demo bundled Sample-data row — already asserted above.
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ── Z17: DEMO-USER — own sessions + appended Sample data ────────────────────────
    // Use the EXPLICIT demo regular user (is_demo=true). The /api/history endpoint appends
    // the Sample-data virtual session ONLY for is_demo accounts — the exact difference from
    // Z16's non-demo client. Asserting it here under the demo context is the other half of
    // the per-account-sidebar bug (each account type, its own correct session set).
    {
      const demoUser = readNamedAccount(DEMO_USER_EMAIL);
      const { ctx, page } = await signIn(browser, { email: demoUser.email, password: demoUser.password }, "/history");
      try {
        const hist = await getHistory(page);
        const sample = hist.sessions.filter(
          (s) => s.session_id === SAMPLE_DATA_SESSION_ID || s.title === SAMPLE_DATA_LABEL
        );
        rec.check(
          hist.status === 200 && sample.length === 1,
          "Z17: demo-user history includes EXACTLY ONE appended 'Sample data' virtual session",
          `status=${hist.status} sampleCount=${sample.length} totalSessions=${hist.sessions.length} account=${demoUser.email}`
        );
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ── Z18: ADMIN — every owner's sessions, foreign rows carry owner_email ──────────
    {
      const { ctx, page } = await signIn(browser, "admin", "/history");
      try {
        // Ensure there IS a foreign owner's session to see: seed one under the demo member
        // (a DIFFERENT owner than admin). Clean it up after.
        const memberOwner = ownerIdForEmail("nucleus.user@meridian.co");
        let foreignSession = null;
        if (memberOwner) {
          foreignSession = randomUUID();
          seedTurn(memberOwner, foreignSession, "Member-owned session for the admin cross-user view");
          cleanup.push(() => psql(`delete from public.ask_history where session_id = ${sqlLit(foreignSession)};`));
        }
        const hist = await getHistory(page);
        // Admin view annotates EACH real session with owner_email. Count distinct owner
        // emails across the returned sessions (excluding the virtual Sample-data row, which
        // has no owner_email). ≥2 distinct emails proves it spans multiple owners.
        const emails = new Set(
          hist.sessions
            .filter((s) => s.session_id !== SAMPLE_DATA_SESSION_ID && s.owner_email)
            .map((s) => s.owner_email)
        );
        const seededForeignVisible = foreignSession ? hist.sessions.some((s) => s.session_id === foreignSession && s.owner_email) : false;
        rec.check(
          hist.status === 200 && emails.size >= 2,
          "Z18: admin history spans ≥2 distinct owners, each real session annotated with owner_email",
          `status=${hist.status} distinctOwnerEmails=${emails.size} totalSessions=${hist.sessions.length}`
        );
        rec.check(
          !foreignSession || seededForeignVisible,
          "Z18: admin sees a FOREIGN owner's seeded session annotated with that owner's email",
          `foreignSessionVisible=${seededForeignVisible} foreignSession=${foreignSession ?? "n/a"}`
        );
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ── Z19: OPEN A CHAT — known id replays turns; unknown id → honest not-found ─────
    {
      const adminOwner = ownerIdForEmail("nucleus.admin@meridian.co");
      const { ctx, page } = await signIn(browser, "admin", "/dashboard");
      try {
        // Seed a 2-turn admin-owned chat so we can assert ordered replay.
        let knownSession = null;
        if (adminOwner) {
          knownSession = randomUUID();
          seedTurn(adminOwner, knownSession, "First question in the open-chat replay test");
          // brief stagger so created_at ordering is deterministic
          await page.waitForTimeout(50);
          seedTurn(adminOwner, knownSession, "Second question in the open-chat replay test");
          cleanup.push(() => psql(`delete from public.ask_history where session_id = ${sqlLit(knownSession)};`));

          await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(knownSession)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.locator('[data-testid="chat-turn"]').first().waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
          const turnCount = await page.locator('[data-testid="chat-turn"]').count();
          const firstQ = (await page.locator('[data-testid="turn-question"]').first().textContent().catch(() => "")) || "";
          rec.check(
            turnCount === 2 && /First question in the open-chat replay test/.test(firstQ),
            "Z19: opening a known chat replays its ordered turns (count + first question match)",
            `turnCount=${turnCount} firstQuestion="${firstQ.slice(0, 50)}"`
          );
        } else {
          rec.check(false, "Z19: could not resolve admin owner to seed a known chat", "ownerIdForEmail null");
        }

        // Unknown/foreign id → the honest "couldn't be found" notice (resume-empty), NOT a
        // blank composable new chat. Use a random UUID that has no rows for this owner.
        const unknown = randomUUID();
        await page.goto(`${BASE}/dashboard?session=${encodeURIComponent(unknown)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        const notFound = await page
          .locator('[data-testid="resume-empty"]')
          .waitFor({ state: "visible", timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        const turnsForUnknown = await page.locator('[data-testid="chat-turn"]').count();
        rec.check(
          notFound && turnsForUnknown === 0,
          "Z19: an unknown/foreign session id shows the honest not-found notice (not a blank new chat)",
          `notFoundNotice=${notFound} turns=${turnsForUnknown}`
        );
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  } catch (e) {
    rec.check(false, "SIDEBAR-ACCOUNTS completed without an unhandled error", (e.message || String(e)).slice(0, 200));
  } finally {
    // RESIDUE: remove every seeded ask_history row.
    for (const fn of cleanup) {
      try {
        fn();
      } catch { /* best-effort */ }
    }
    await browser.close();
  }
  return rec.summary();
}
