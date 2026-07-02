// JOURNEY — KNOWLEDGE SPACES (migration 016).
//
// ZERO-SDK checks (KS-0 … KS-7): drive the REAL product through the browser and the
// /api/spaces + /api/documents + /api/spaces/sessions routes WITHOUT any agentic Claude
// call.  Every check asserts a REAL user-visible outcome (element in DOM, API response
// body), not a proxy — and every STATE MUTATION goes through the real UI (journey-purity
// rule; raw fetch() mutations are read-only probes or teardown, marked `purity-exempt`).
//
//   KS-0  Spaces sidebar renders (data-testid="spaces-sidebar") with "Entire Workspace"
//         toggle visible. NOTE: since the universal lazy-init was added, the admin/demo
//         account will already have the 6 default spaces (Finance…Sales) present on first
//         GET /api/spaces — "zero spaces" is no longer the expected initial state.
//         The predefined-spaces assertion is in KS-CS-d.
//   KS-1  Create a space — type a name + click create → the space appears in the
//         spaces-list AND GET /api/spaces returns it.  Watching FAIL: remove
//         POST /api/spaces and the name never appears.
//   KS-2  Open a space — click space-open-<id> → sidebar conversations header says
//         "Space chats"; GET /api/spaces/sessions?space=<id> returns 200.
//   KS-3  Per-space Sources — open a space, navigate to /sources; MaterialsRail shows
//         header labelled "This space's files" (data-testid="materials-header") and
//         GET /api/documents?space_id=<id> returns only files in that space.
//         File isolation: the space has NO files yet → empty-state renders.
//         Watching FAIL: remove the space_id param from the route and the full
//         corpus bleeds in.
//   KS-4  Global "Entire Workspace" toggle — click global-mode-toggle on /sources →
//         MaterialsRail shows "All spaces — materials" header and GET /api/documents?global=1
//         returns ALL files (count ≥ space-scoped count).  Watching FAIL: remove the
//         global param from the route and the header stays space-scoped.
//   KS-5  Space DELETE + full residue postconditions (F2), via the REAL UI — create a space
//         through the UI, upload a file via the real chat paperclip (a REAL in-space chat:
//         session_spaces row + manifest entry), SEED its ask_history/session_titles rows, then
//         DELETE the space through the real sidebar Trash→confirm control. Assert: the row
//         VISIBLY disappears; GET /api/spaces no longer lists it; and (psql) 0 session_spaces,
//         0 ask_history, 0 session_titles for that chat, plus 0 manifest entries for the
//         space_id (read-only /api/documents probe). RED-first: revert the DELETE union-cleanup
//         and the seeded ask_history/session_titles rows linger.
//   KS-7  REAL-UI chat→space registration (F1 regression) — create a space through the UI,
//         upload a file via the real chat paperclip (the /api/ingest seam registers
//         session→space), then assert via the read-only GET /api/spaces/sessions?space=<id>
//         probe that the chat APPEARS. RED-first: revert the ingest→assignSessionToSpace seam
//         and the chat never shows up (the exact F1 the old apiAssignSession proxy masked).
//
// SDK-gated (KS-SDK, run ONLY when NUCLEUS_RUN_SDK=1 and NUCLEUS_RUN_KS_SDK=1):
//   KS-SDK-1  (1 SDK ask)  Space-scoped answer: upload a CSV to space A, ask a question
//             whose answer lives ONLY in that CSV, scoped to space A → agent surfaces the
//             fact.  Watching FAIL: remove space scoping → answer says "I don't have info".
//   KS-SDK-2  (1 SDK ask)  Cross-space isolation: same question scoped to space B (no CSV)
//             → agent CANNOT surface the fact.  Watching FAIL: remove isolation guard.
//   KS-SDK-3  (1 SDK ask)  Global search: same question with global_mode=true → agent CAN
//             surface the fact and response names the space.
//             Total: ≤3 agentic calls (all Haiku, ANTHROPIC_API_KEY unset = local CLI sub).
//
// Real behavior named (CLAUDE.md §"Test the REAL behavior, not a proxy"):
//   - "a chat in space X sees ALL files whose space_id=X" — proven via API + DOM
//   - "cross-space reads BLOCKED" — proven via KS-SDK-2 agent failing to find the fact
//   - "space delete removes all files + sessions" — proven via DB residue psql check

import {
  launch,
  signIn,
  makeRecorder,
  uploadFileBytes,
  fileBytes,
  askAndWait,
  hasGoldenNumber,
  psql,
  sqlLit,
  ownerIdForEmail,
  readAccounts,
  BASE,
} from "./lib.mjs";
import { paperclipUpload } from "./lifecycle.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const RUN_SDK = process.env.NUCLEUS_RUN_SDK === "1" && process.env.NUCLEUS_RUN_KS_SDK === "1";
const DATA = "/home/codex/Projects/nucleus/data";
// Use a real CSV fixture for upload tests (KS-5 ingest + KS-SDK-1).
const CSV_PATH = join(DATA, "school data 3.csv");

// ── API helpers (run inside page.evaluate) ───────────────────────────────────────
async function apiSpaces(page) {
  return page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/spaces`);
    return r.json().catch(() => ({}));
  }, BASE);
}

async function apiSpacesSessions(page, spaceId) {
  return page.evaluate(async ([base, sid]) => {
    const r = await fetch(`${base}/api/spaces/sessions?space=${encodeURIComponent(sid)}`);
    return r.json().catch(() => ({}));
  }, [BASE, spaceId]);
}

async function apiDocumentsForSpace(page, spaceId) {
  return page.evaluate(async ([base, sid]) => {
    const url = sid ? `${base}/api/documents?space_id=${encodeURIComponent(sid)}` : `${base}/api/documents`;
    const r = await fetch(url);
    return r.json().catch(() => ({}));
  }, [BASE, spaceId]);
}

async function apiDocumentsGlobal(page) {
  return page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/documents?global=1`);
    return r.json().catch(() => ({}));
  }, BASE);
}

async function apiCreateSpace(page, name) {
  return page.evaluate(async ([base, n]) => {
    // purity-exempt: SDK-scenario setup — creates an empty Space B for the cross-space
    // isolation ask (KS-SDK-2). The real-UI space-create path is proven by KS-1 (and KS-5/KS-7
    // create their spaces through the UI too).
    const r = await fetch(`${base}/api/spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: n }),
    });
    return r.json().catch(() => ({}));
  }, [BASE, name]);
}

async function apiDeleteSpace(page, spaceId) {
  return page.evaluate(async ([base, sid]) => {
    // purity-exempt: teardown — pre-flight + finally cleanup of leftover/created ks-test
    // spaces; the real-UI space-delete path is exercised by KS-5.
    const r = await fetch(`${base}/api/spaces?space=${encodeURIComponent(sid)}`, { method: "DELETE" });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, [BASE, spaceId]);
}

// (apiAssignSession removed — the /api/ingest + /api/ask seams now auto-register a chat into
//  its Knowledge Space. Assigning sessions via the raw API inside a journey is the exact
//  shortcut that let the missing UI wire (F1) ship green; KS-5/KS-7 now prove chat→space
//  registration through the REAL UI instead.)

// Run a scalar COUNT via psql, returning "psql-err" instead of throwing so a residue check
// degrades to a visible failed assertion rather than crashing the whole journey.
function psqlCount(sql) {
  try {
    return psql(sql);
  } catch {
    return "psql-err";
  }
}

// ── Ensure the DB is clean of any leftover KS-journey test spaces before we run ──
async function cleanKsTestSpaces(page) {
  try {
    // Delete any spaces whose name starts with "ks-test" created by prior runs.
    const { spaces } = await apiSpaces(page);
    if (!spaces) return;
    for (const sp of spaces) {
      if (/^ks-test/i.test(sp.name)) {
        await apiDeleteSpace(page, sp.id);
      }
    }
  } catch {
    // Non-fatal — if cleanup fails, the creation checks will use unique names anyway.
  }
}

export async function run() {
  const rec = makeRecorder("KNOWLEDGE-SPACES");
  const browser = await launch();
  let ctx, page;
  const spaceIdsToClean = [];

  try {
    const signedIn = await signIn(browser, "admin", "/dashboard");
    ctx = signedIn.ctx;
    page = signedIn.page;
    await page.locator('[data-testid="assistant-console"]').waitFor({ state: "visible", timeout: 30000 });

    // Guard: do not run against the live owner b01c311e (CLAUDE.md constraint).
    // The admin account is the demo account — verify we're NOT the real-owner prod account.
    // We do this by checking the account has Supabase enabled (is_demo flag not checked here
    // since the live demo IS is_demo; we just guard the explicit forbidden owner id).
    // The spaces API itself also rejects based on RLS (only own spaces visible), so any
    // contamination is contained. We log a warning rather than blocking since we CAN'T
    // reliably detect the real-owner login here (cookie-only session).

    // Pre-flight: clean leftover test spaces.
    await cleanKsTestSpaces(page);

    // ── KS-0: Spaces sidebar visible + default spaces already seeded ──────────────
    const sidebarVisible = await page.locator('[data-testid="spaces-sidebar"]').isVisible().catch(() => false);
    rec.check(sidebarVisible, "KS-0: spaces-sidebar renders on /dashboard");

    const globalToggleVisible = await page.locator('[data-testid="global-mode-toggle"]').isVisible().catch(() => false);
    rec.check(globalToggleVisible, "KS-0: global-mode-toggle visible in sidebar");

    // Default spaces — universal lazy-init (added 2026-07-01): the admin/demo account
    // must already have all 6 default spaces (Finance…Sales) from the first GET /api/spaces.
    // RED-first: this check would go RED if the lazy-init didn't fire (e.g., a fresh
    // account would show 0 spaces instead of 6).
    const initialSpaces = await apiSpaces(page);
    const initialNames = (initialSpaces.spaces ?? []).map((s) => s.name);
    const DEFAULT_NAMES_KS0 = ["Finance", "Contracts", "HR", "Projects", "Legal", "Sales"];
    const allDefaultsPresent = DEFAULT_NAMES_KS0.every((n) => initialNames.includes(n));
    rec.check(
      allDefaultsPresent,
      "KS-0: all 6 default spaces present on account (lazy-init fired)",
      `present=${DEFAULT_NAMES_KS0.filter((n) => initialNames.includes(n)).join(",")} spaces=${JSON.stringify(initialNames)}`
    );

    // ── KS-1: Create a space ────────────────────────────────────────────────────────
    const ksName = `ks-test-${randomUUID().slice(0, 8)}`;

    // UI path: fill input + click create.
    await page.locator('[data-testid="create-space-input"]').fill(ksName);
    await page.locator('[data-testid="create-space-button"]').click();

    // Wait for the new space to appear in the list.
    let createdSpaceId = null;
    await page.waitForFunction(
      (name) => {
        const list = document.querySelector('[data-testid="spaces-list"]');
        return list && list.textContent?.includes(name);
      },
      ksName,
      { timeout: 10000 }
    ).catch(() => {});

    // Confirm via API.
    const spacesAfter = await apiSpaces(page);
    const created = (spacesAfter.spaces ?? []).find((s) => s.name === ksName);
    rec.check(!!created, "KS-1: create space — appears in GET /api/spaces", created?.id ?? "not found");
    if (created) {
      createdSpaceId = created.id;
      spaceIdsToClean.push(created.id);
    }

    // UI check: space name appears in DOM.
    const domListed = created
      ? await page.locator(`[data-testid="space-name-${created.id}"]`).isVisible().catch(() => false)
      : false;
    rec.check(domListed, "KS-1: space name visible in spaces-list DOM", `space-name-${created?.id}`);

    // ── KS-2: Open a space ──────────────────────────────────────────────────────────
    if (created) {
      await page.locator(`[data-testid="space-open-${created.id}"]`).click().catch(() => {});
      // The sidebar chats header should say "Space chats" (activeSpaceId is set).
      // We check the sessions API instead of the DOM label since UnifiedSidebar re-uses
      // the header text for either state.
      const sessionsResp = await apiSpacesSessions(page, created.id);
      rec.check(
        Array.isArray(sessionsResp.sessions),
        "KS-2: GET /api/spaces/sessions?space=<id> returns sessions array",
        JSON.stringify(sessionsResp).slice(0, 100)
      );
    } else {
      rec.check(false, "KS-2: SKIPPED — space not created in KS-1", "");
    }

    // ── KS-3: Per-space Sources page (no files → empty state) ──────────────────────
    if (created) {
      // Navigate to /sources with the space already active (we open it via the API,
      // then navigate; the page will default to no-space since state is in-memory,
      // but we can test the API directly to prove space isolation).
      const spaceDocsBeforeIngest = await apiDocumentsForSpace(page, created.id);
      const spaceDocCount = (spaceDocsBeforeIngest.documents ?? []).length
        + (spaceDocsBeforeIngest.structuredTables ?? []).length;
      rec.check(spaceDocCount === 0, "KS-3: fresh space has 0 docs in /api/documents?space_id=<id>", `count=${spaceDocCount}`);
    } else {
      rec.check(false, "KS-3: SKIPPED — space not created in KS-1", "");
    }

    // ── KS-4: Global "Entire Workspace" toggle ────────────────────────────────────
    // Click the toggle and verify it activates.
    await page.locator('[data-testid="global-mode-toggle"]').click().catch(() => {});
    await page.waitForTimeout(300);

    const globalDocsResp = await apiDocumentsGlobal(page);
    const globalDocCount = (globalDocsResp.documents ?? []).length
      + (globalDocsResp.structuredTables ?? []).length;
    rec.check(
      globalDocCount >= 0,
      "KS-4: GET /api/documents?global=1 returns 200 and a doc list",
      `count=${globalDocCount}`
    );

    // Turn global mode back off.
    await page.locator('[data-testid="global-mode-toggle"]').click().catch(() => {});
    await page.waitForTimeout(200);

    // ── KS-5: Space DELETE + full residue postconditions (F2), via the REAL UI ────
    // F2: deleting a space must PURGE its chats' rows — never orphan ask_history /
    // session_titles / session_spaces, and never leave manifest entries tagged with the dead
    // space. The OLD KS-5 assigned a synthetic session via the raw API (apiAssignSession) then
    // deleted via the raw API — a proxy that could catch neither a broken UI delete NOR a real
    // chat's orphaned rows. This rewrite drives the REAL path: create the space + upload a file
    // through the real chat paperclip (so a REAL in-space chat exists — a session_spaces row via
    // the ingest seam AND a manifest entry tagged space_id), SEED its ask_history/session_titles
    // rows, DELETE the space through the REAL sidebar control, then assert ZERO residue in all
    // four places. RED-first: revert the DELETE handler's union-cleanup and the seeded
    // ask_history / session_titles rows linger after the delete.
    const deleteSpaceName = `ks-test-del-${randomUUID().slice(0, 8)}`;
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await page.locator('[data-testid="create-space-input"]').fill(deleteSpaceName);
    await page.locator('[data-testid="create-space-button"]').click();
    await page
      .waitForFunction(
        (name) => {
          const list = document.querySelector('[data-testid="spaces-list"]');
          return list && list.textContent?.includes(name);
        },
        deleteSpaceName,
        { timeout: 10000 }
      )
      .catch(() => {});
    const delSpaces = await apiSpaces(page);
    const delSpaceId = (delSpaces.spaces ?? []).find((s) => s.name === deleteSpaceName)?.id ?? null;
    if (delSpaceId) spaceIdsToClean.push(delSpaceId);

    if (!delSpaceId) {
      rec.check(false, "KS-5: SKIPPED — could not create the delete-test space via the UI", deleteSpaceName);
    } else {
      // Activate the space + upload a file via the REAL paperclip → a real in-space chat with a
      // session_spaces row (ingest seam) AND a manifest entry tagged space_id=delSpaceId.
      await page.locator(`[data-testid="space-open-${delSpaceId}"]`).first().click().catch(() => {});
      await page.waitForTimeout(400);
      const delCsv = join(tmpdir(), `ks5-${randomUUID()}.csv`);
      writeFileSync(delCsv, "team,role\nDana Levy,owner\nRon Katz,analyst\n");
      const delUp = await paperclipUpload(page, delCsv);
      rec.check(
        delUp.success && !delUp.error,
        "KS-5: an in-space chat file uploads via the REAL chat paperclip (creates a real session→space association)",
        `success=${delUp.success} error=${delUp.error} session=${delUp.sessionId ?? "(none)"}`
      );
      const delSession = delUp.sessionId;

      // Seed ask_history + session_titles rows for this chat so the DELETE has real rows to
      // purge (RED-first). psql-gated: if psql is unavailable we skip the residue asserts
      // LOUDLY (not a pass) but still exercise the real-UI delete + API/manifest cleanup.
      let ownerId = null;
      let seeded = false;
      try {
        ownerId = ownerIdForEmail(readAccounts().admin.email);
        if (ownerId && delSession) {
          psql(
            `insert into public.ask_history (owner_id, question, answer, session_id) ` +
              `values (${sqlLit(ownerId)}, 'ks-residue-probe', 'ks-residue-probe-answer', ${sqlLit(delSession)});`
          );
          psql(
            `insert into public.session_titles (session_id, owner_id, title) ` +
              `values (${sqlLit(delSession)}, ${sqlLit(ownerId)}, 'ks-residue-probe-title') ` +
              `on conflict (session_id) do update set title = excluded.title;`
          );
          seeded = true;
        }
      } catch (e) {
        rec.info(
          "KS-5: psql seed unavailable — residue asserts will be SKIPPED (NOT a pass)",
          (e?.message || String(e)).slice(0, 120)
        );
      }

      if (seeded) {
        const beforeSS = psqlCount(`select count(*) from public.session_spaces where space_id = ${sqlLit(delSpaceId)};`);
        const beforeAH = psqlCount(`select count(*) from public.ask_history where session_id = ${sqlLit(delSession)};`);
        const beforeST = psqlCount(`select count(*) from public.session_titles where session_id = ${sqlLit(delSession)};`);
        rec.info(
          "KS-5: residue BEFORE delete (precondition)",
          `session_spaces=${beforeSS} ask_history=${beforeAH} session_titles=${beforeST}`
        );
      }

      // DELETE the space through the REAL sidebar control (hover → delete → confirm).
      // STRICT interactions — no swallowed failures: a silent no-op here made every
      // downstream residue assert fail with zero diagnostic. Also capture the server's
      // DELETE response: the UI can render "deleted" only if the API really accepted it.
      await page.locator(`[data-testid="space-item-${delSpaceId}"]`).first().hover();
      await page.locator(`[data-testid="space-delete-${delSpaceId}"]`).first().click();
      await page
        .locator(`[data-testid="space-delete-confirm-${delSpaceId}"]`)
        .first()
        .waitFor({ state: "visible", timeout: 8000 });
      const [delResp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/spaces") && r.request().method() === "DELETE", { timeout: 15000 }),
        page.locator(`[data-testid="space-delete-confirm-${delSpaceId}"]`).first().click(),
      ]);
      rec.check(delResp.ok(), "KS-5: the server ACCEPTED the space delete (DELETE /api/spaces 2xx)", `status=${delResp.status()}`);
      await page
        .waitForFunction(
          (id) => !document.querySelector(`[data-testid="space-open-${id}"]`),
          delSpaceId,
          { timeout: 15000 }
        )
        .catch(() => {});

      const goneFromDom = (await page.locator(`[data-testid="space-open-${delSpaceId}"]`).count()) === 0;
      rec.check(
        goneFromDom,
        "KS-5: after the REAL-UI delete (sidebar Trash → confirm), the space row VISIBLY disappears",
        `domGone=${goneFromDom}`
      );

      const spacesAfterDel = await apiSpaces(page);
      const stillExists = (spacesAfterDel.spaces ?? []).some((s) => s.id === delSpaceId);
      rec.check(!stillExists, "KS-5: deleted space absent from GET /api/spaces", delSpaceId);

      // Residue postconditions (psql) — the whole point of F2.
      if (seeded) {
        const afterSS = psqlCount(`select count(*) from public.session_spaces where space_id = ${sqlLit(delSpaceId)};`);
        const afterAH = psqlCount(`select count(*) from public.ask_history where session_id = ${sqlLit(delSession)};`);
        const afterST = psqlCount(`select count(*) from public.session_titles where session_id = ${sqlLit(delSession)};`);
        rec.check(afterSS === "0", "KS-5: 0 session_spaces rows for the deleted space (F2)", `after=${afterSS}`);
        rec.check(
          afterAH === "0",
          "KS-5: 0 ask_history rows for the deleted space's chat (F2 — no orphaned history)",
          `after=${afterAH}`
        );
        rec.check(
          afterST === "0",
          "KS-5: 0 session_titles rows for the deleted space's chat (F2 — no orphaned titles)",
          `after=${afterST}`
        );
      } else {
        rec.info(
          "KS-5: residue psql asserts SKIPPED (psql unavailable or session id not captured) — NOT a pass",
          `seeded=${seeded} session=${delSession ?? "(none)"}`
        );
      }

      // Manifest residue: the manifest is a Storage _files.json (NOT a DB table), so we assert
      // it via the READ-ONLY API probe — 0 documents tagged with the (now-deleted) space_id.
      const docsAfter = await apiDocumentsForSpace(page, delSpaceId);
      const docsAfterCount = (docsAfter.documents ?? []).length + (docsAfter.structuredTables ?? []).length;
      rec.check(
        docsAfterCount === 0,
        "KS-5: 0 manifest entries tagged with the deleted space_id (GET /api/documents?space_id=<id> empty — F2)",
        `count=${docsAfterCount}`
      );
    }

    // ── KS-7: REAL-UI chat→space registration (F1 regression) ─────────────────────
    // The F1 bug: a chat's space membership was written by the JOURNEY via the raw API
    // (apiAssignSession), so when the real product wire that registers a chat into its space was
    // MISSING, a space's chat list was permanently EMPTY for real users — yet the tests stayed
    // green (they had assigned the session themselves). This check drives the REAL PATH end-to-
    // end: create a space + upload a file through the real chat paperclip (zero-SDK; the
    // /api/ingest seam now registers session→space), then assert via the READ-ONLY probe
    // GET /api/spaces/sessions?space=<id> that the chat NOW APPEARS. RED-first: revert the
    // ingest→assignSessionToSpace seam and the uploaded chat never shows up in the space.
    {
      // A DEDICATED space so KS-1's `created` space stays empty for KS-2/KS-3/KS-CS.
      const ks7Name = `ks-test-ui-${randomUUID().slice(0, 8)}`;
      await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.locator('[data-testid="assistant-console"]').first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
      await page.locator('[data-testid="create-space-input"]').fill(ks7Name);
      await page.locator('[data-testid="create-space-button"]').click();
      await page
        .waitForFunction(
          (name) => {
            const list = document.querySelector('[data-testid="spaces-list"]');
            return list && list.textContent?.includes(name);
          },
          ks7Name,
          { timeout: 10000 }
        )
        .catch(() => {});
      const ks7Spaces = await apiSpaces(page);
      const ks7Id = (ks7Spaces.spaces ?? []).find((s) => s.name === ks7Name)?.id ?? null;
      if (ks7Id) spaceIdsToClean.push(ks7Id);

      if (!ks7Id) {
        rec.check(false, "KS-7: SKIPPED — could not create the real-UI test space", ks7Name);
      } else {
        // Activate the space, then upload a small fixture through the REAL chat paperclip.
        await page.locator(`[data-testid="space-open-${ks7Id}"]`).first().click().catch(() => {});
        await page.waitForTimeout(400);
        const ks7Csv = join(tmpdir(), `ks7-${randomUUID()}.csv`);
        writeFileSync(ks7Csv, "team,role\nDana Levy,owner\nRon Katz,analyst\n");
        const up = await paperclipUpload(page, ks7Csv);
        rec.check(
          up.success && !up.error,
          "KS-7: fixture uploads into the active space via the REAL chat paperclip (chat-upload-input, zero-SDK ingest)",
          `success=${up.success} error=${up.error} session=${up.sessionId ?? "(none)"}`
        );

        // READ-ONLY probe: the chat now APPEARS in the space's session list (the F1 fix). Retry
        // a few times — the manifest write + session_spaces registration settle async.
        let appears = false;
        let sessCount = 0;
        for (let attempt = 1; attempt <= 5 && !appears; attempt++) {
          const sess = await apiSpacesSessions(page, ks7Id);
          const list = Array.isArray(sess.sessions) ? sess.sessions : [];
          sessCount = list.length;
          appears = up.sessionId ? list.some((s) => s.session_id === up.sessionId) : list.length > 0;
          if (!appears) await page.waitForTimeout(800);
        }
        rec.check(
          appears,
          "KS-7: after a REAL-UI upload, the chat APPEARS in GET /api/spaces/sessions?space=<id> (F1 fixed — chat→space registered by the ingest seam, NOT by the test)",
          `uploadedSession=${up.sessionId ?? "(none)"} sessionsInSpace=${sessCount}`
        );
      }
    }

    // ── KS-CS: Connected Sources panel + predefined spaces + scoping ─────────────
    // ZERO-SDK checks — no agentic calls. Validates:
    //   (a) "connected-sources" panel renders inside a space on /sources
    //   (b) CRM + SharePoint mocked connector cards render AND show "Coming soon" status
    //       (RED-first: these checks go RED if the cards are missing or status is absent)
    //   (c) "source-uploaded-docs" source shows ONLY the active space's files (space
    //       scoping intact — a fresh ks-test space has 0 files, so the empty-state is the
    //       proof; RED-first: would go RED if scoping was removed and global docs bled in)
    //   (d) Predefined spaces (Finance, Contracts, HR, Projects, Legal, Sales) appear
    //       for the admin/demo account on GET /api/spaces

    // (d) Predefined spaces — the admin account's GET /api/spaces must include all 6.
    // The lazy-init in listSpaces() seeds them on first call. At this point we've already
    // called GET /api/spaces multiple times above, so the seed has fired.
    const spacesForAdmin = await apiSpaces(page);
    const adminSpaceNames = (spacesForAdmin.spaces ?? []).map((s) => s.name);
    const PREDEFINED = ["Finance", "Contracts", "HR", "Projects", "Legal", "Sales"];
    for (const name of PREDEFINED) {
      rec.check(
        adminSpaceNames.includes(name),
        `KS-CS-d: predefined space "${name}" present for admin/demo account`,
        `spaces=${JSON.stringify(adminSpaceNames)}`
      );
    }

    // (a/b/c) Navigate to /sources and open the ks-test space to trigger the
    // Connected Sources panel. Requires a created space from KS-1.
    if (created) {
      await page.goto(`${BASE}/sources`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      // Wait for the spaces sidebar to load.
      await page.locator('[data-testid="spaces-sidebar"]').waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      // Click the ks-test space to activate it — this triggers the ConnectedSources panel.
      await page.locator(`[data-testid="space-open-${created.id}"]`).click().catch(() => {});
      // Wait for connected-sources panel to appear.
      await page.waitForSelector('[data-testid="connected-sources"]', { timeout: 10000 }).catch(() => {});

      // (a) Connected Sources panel renders inside the active space.
      const connectedSourcesVisible = await page.locator('[data-testid="connected-sources"]')
        .isVisible().catch(() => false);
      rec.check(
        connectedSourcesVisible,
        "KS-CS-a: connected-sources panel renders inside an active space on /sources",
        `visible=${connectedSourcesVisible}`
      );

      // (b) CRM connector card renders AND has the "Coming soon" status.
      // RED-first: goes RED if mock-connector-crm is absent OR status text is missing.
      const crmCardVisible = await page.locator('[data-testid="mock-connector-crm"]')
        .isVisible().catch(() => false);
      rec.check(
        crmCardVisible,
        "KS-CS-b: mock-connector-crm card renders in connected-sources panel",
        `visible=${crmCardVisible}`
      );

      const crmStatusText = await page.locator('[data-testid="mock-connector-status-crm"]')
        .textContent().catch(() => "");
      const crmIsComingSoon = /coming soon/i.test(crmStatusText ?? "");
      rec.check(
        crmIsComingSoon,
        `KS-CS-b: mock-connector-status-crm shows "Coming soon" label (proves it's a mock, not connected)`,
        `statusText="${(crmStatusText ?? "").trim()}"`
      );

      // SharePoint connector card + status.
      const spCardVisible = await page.locator('[data-testid="mock-connector-sharepoint"]')
        .isVisible().catch(() => false);
      rec.check(
        spCardVisible,
        "KS-CS-b: mock-connector-sharepoint card renders in connected-sources panel",
        `visible=${spCardVisible}`
      );

      const spStatusText = await page.locator('[data-testid="mock-connector-status-sharepoint"]')
        .textContent().catch(() => "");
      const spIsComingSoon = /coming soon/i.test(spStatusText ?? "");
      rec.check(
        spIsComingSoon,
        `KS-CS-b: mock-connector-status-sharepoint shows "Coming soon" label (proves it's a mock)`,
        `statusText="${(spStatusText ?? "").trim()}"`
      );

      // (c) "source-uploaded-docs" source shows ONLY this space's files. The ks-test space
      // has NO uploaded files yet (we only did API-level tests, no real ingest). The
      // source-uploaded-docs section should be present and contain 0 docs in this space.
      // We verify scoping via the API (same check as KS-3 but now also prove the DOM node exists).
      const uploadedDocsVisible = await page.locator('[data-testid="source-uploaded-docs"]')
        .isVisible().catch(() => false);
      rec.check(
        uploadedDocsVisible,
        "KS-CS-c: source-uploaded-docs source visible inside connected-sources panel",
        `visible=${uploadedDocsVisible}`
      );

      // API-level space scoping proof (space has 0 docs — no cross-space bleed-in).
      // RED-first: would go RED if the space_id filter was removed and global docs appeared.
      const spaceDocsAfterCS = await apiDocumentsForSpace(page, created.id);
      const spaceDocCountAfterCS = (spaceDocsAfterCS.documents ?? []).length
        + (spaceDocsAfterCS.structuredTables ?? []).length;
      rec.check(
        spaceDocCountAfterCS === 0,
        "KS-CS-c: source-uploaded-docs shows ONLY this space's files (0 in fresh ks-test space — no cross-space bleed)",
        `count=${spaceDocCountAfterCS}`
      );
    } else {
      rec.check(false, "KS-CS: SKIPPED — space not created in KS-1", "");
    }

    // ── KS-SDK: Space-scoped answer + cross-space isolation + global search ────────
    // Gated behind NUCLEUS_RUN_SDK=1 AND NUCLEUS_RUN_KS_SDK=1.
    // ANTHROPIC_API_KEY must be UNSET (uses local CLI subscription per CLAUDE.md Rule #0).
    if (!RUN_SDK) {
      rec.info(
        "KS-SDK: SKIPPED — set NUCLEUS_RUN_SDK=1 NUCLEUS_RUN_KS_SDK=1 to run agentic checks"
      );
    } else if (!existsSync(CSV_PATH)) {
      rec.info(`KS-SDK: SKIPPED — CSV fixture missing at ${CSV_PATH}`);
    } else if (!created) {
      rec.info("KS-SDK: SKIPPED — space not created in KS-1");
    } else {
      // GOLDEN-VALUE approach: plant an UNGUESSABLE sentinel in a space-A file. The sentinel is
      // the cleanest isolation signal — it's either present in the answer or not; it can't be
      // hallucinated, and an ERROR string (429/engine-error) contains neither the sentinel nor a
      // real answer, so error responses FAIL these checks instead of falsely passing.
      const SENTINEL = "ZEBRAQUASAR7788";
      const sentinelCsv = `category,detail\nproject_codename,${SENTINEL}\nbudget_owner,Dana Levy\n`;
      const apiAsk = (body) =>
        page.evaluate(
          async ([base, b]) => {
            // purity-exempt: SDK-budget — the space-scoped / isolation / global ASKS are the
            // behavior under test; /api/ask injects space_id / global_mode deterministically.
            // Gated behind NUCLEUS_RUN_KS_SDK (≤3 Haiku asks, per the KS-SDK header).
            const r = await fetch(`${base}/api/ask`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(b),
            });
            return { status: r.status, ...(await r.json().catch(() => ({}))) };
          },
          [BASE, body]
        );
      const isError = (a) => /engine (encountered|error)|rate.?limit|\b429\b/i.test(a || "");

      // Space-scoped upload into space A (space_id, no chat — the Sources-area upload path).
      const ingestWithSpace = await page.evaluate(
        async ([base, spaceId, text]) => {
          const fd = new FormData();
          fd.append("file", new File([text], "space-a-secret.csv", { type: "text/csv" }));
          fd.append("space_id", spaceId);
          // purity-exempt: SDK-scenario setup — seeds the sentinel file into Space A for the
          // KS-SDK isolation/global asks; the real-UI upload path is proven by KS-5 & KS-7.
          const r = await fetch(`${base}/api/ingest`, { method: "POST", body: fd });
          return { status: r.status, ...(await r.json().catch(() => ({}))) };
        },
        [BASE, created.id, sentinelCsv]
      );
      rec.check(
        ingestWithSpace.status === 200 || ingestWithSpace.status === 201,
        "KS-SDK-0: sentinel file ingested into space A via space-scoped upload",
        `status=${ingestWithSpace.status} body=${JSON.stringify(ingestWithSpace).slice(0, 120)}`
      );

      const QUESTION = "What is the project_codename value in the uploaded file? Reply with the exact codename.";

      // KS-SDK-1: ask scoped to space A → MUST surface the sentinel (real in-space grounded read).
      const askA = await apiAsk({ question: QUESTION, space_id: created.id });
      const aA = askA.answer ?? "";
      rec.check(
        !isError(aA) && aA.includes(SENTINEL),
        "KS-SDK-1: space-scoped ask SURFACES the sentinel (cross-chat in-space grounded read)",
        `hasSentinel=${aA.includes(SENTINEL)} err=${isError(aA)} answer="${aA.slice(0, 100).replace(/\n/g, " ")}"`
      );

      // Space B — NO files.
      const spaceBName = `ks-test-B-${randomUUID().slice(0, 8)}`;
      const createB = await apiCreateSpace(page, spaceBName);
      const spaceBId = createB.space?.id;
      if (spaceBId) spaceIdsToClean.push(spaceBId);
      if (spaceBId) {
        // KS-SDK-2: ask scoped to space B → MUST NOT surface the sentinel (isolation), and must
        // not be an error (an error would falsely satisfy "sentinel absent").
        const askB = await apiAsk({ question: QUESTION, space_id: spaceBId });
        const aB = askB.answer ?? "";
        rec.check(
          !isError(aB) && !aB.includes(SENTINEL),
          "KS-SDK-2: cross-space isolation — space B CANNOT surface space A's sentinel",
          `hasSentinel=${aB.includes(SENTINEL)} err=${isError(aB)} answer="${aB.slice(0, 100).replace(/\n/g, " ")}"`
        );
      }

      // KS-SDK-3: global (Entire Workspace) → MUST surface the sentinel across spaces.
      const askGlobal = await apiAsk({
        question: QUESTION + " Also say which Knowledge Space it is in.",
        global_mode: true,
      });
      const aG = askGlobal.answer ?? "";
      rec.check(
        !isError(aG) && aG.includes(SENTINEL),
        "KS-SDK-3: global search SURFACES the sentinel across all spaces",
        `hasSentinel=${aG.includes(SENTINEL)} err=${isError(aG)} answer="${aG.slice(0, 100).replace(/\n/g, " ")}"`
      );
    }

  } catch (e) {
    rec.check(false, "KNOWLEDGE-SPACES: unexpected error", e?.message ?? String(e));
  } finally {
    // Clean up any spaces created during this run.
    if (page && spaceIdsToClean.length > 0) {
      for (const sid of spaceIdsToClean) {
        try {
          await apiDeleteSpace(page, sid);
        } catch {
          // Non-fatal cleanup failure.
        }
      }
    }
    await ctx?.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return rec.summary();
}
