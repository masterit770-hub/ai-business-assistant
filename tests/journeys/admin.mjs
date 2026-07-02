// JOURNEY 8 — ADMIN. Users panel can create a user (surfaces invite link/credentials);
// a role-change control exists. Report present/absent. Created test users are left
// deactivated (kicked out) to avoid leaving an active stray login.
import { launch, signIn, makeRecorder, BASE } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("ADMIN");
  const browser = await launch();
  try {
    // Settings is now SUB-TABBED (Prompts · Models · Appearance · Users); the panels are
    // kept mounted but `hidden` when inactive, so the Users panel is in the DOM yet not
    // visible/clickable until its tab is active. SimpleTabs honors ?tab=<value>, so deep-
    // link straight to the Users tab. (An earlier version landed on the default Prompts
    // tab and FALSE-FAILED: users-panel hidden→not "visible", create-user inputs not
    // actionable — a stale test from the redesign, not a product break.)
    const { ctx, page } = await signIn(browser, "admin", "/settings?tab=users");
    // The role-change controls live in a `hidden ... sm:flex` container, so a narrow
    // viewport hides them. Use a desktop width to exercise the real admin UI.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/settings?tab=users`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000); // let the real user list load
    await page.locator('[data-testid="users-panel"]').waitFor({ state: "visible", timeout: 30000 }).catch(() => {});

    const panelVisible = await page.locator('[data-testid="users-panel"]').isVisible().catch(() => false);
    rec.check(panelVisible, "admin Users panel renders", "");

    // 8a. A role-change control exists on at least one non-self user row.
    const roleToggles = await page.locator('[data-testid^="user-role-toggle-"]').count();
    rec.check(roleToggles > 0, "a role-change control exists (Make admin/Make member)", `toggles=${roleToggles}`);

    // 8b. Create a user → an invite/credentials card surfaces (invite link OR temp password).
    const testEmail = `qa-verify-${Date.now()}@example.com`;
    page.on("dialog", (d) => d.accept().catch(() => {}));
    const form = page.locator('[data-testid="create-user-form"]');
    const emailInput = form.locator('input[type="email"]');
    const pwInput = form.locator('input[type="text"]');
    await emailInput.click(); await emailInput.type(testEmail, { delay: 8 });
    await pwInput.click(); await pwInput.type("TempPass123!", { delay: 8 });
    await form.locator('button[type="submit"]').click();

    const card = page.locator('[data-testid="invite-card"]');
    // Wait for either the invite card or an error banner to settle (the create hits the
    // real Supabase admin API, which can take a couple seconds).
    await Promise.race([
      card.waitFor({ state: "visible", timeout: 25000 }).catch(() => {}),
      page.locator('[data-testid="users-panel"] .bg-red-50').first().waitFor({ state: "visible", timeout: 25000 }).catch(() => {}),
    ]);
    const cardShown = await card.isVisible().catch(() => false);
    // A real create error renders in the panel's red error BANNER (the bg-red-50 row at
    // the top of the panel), NOT in a button's red text — read that precise element.
    const errText = await page.locator('[data-testid="users-panel"] .bg-red-50').first().textContent({ timeout: 1500 }).catch(() => null);
    let surfaced = false, detail = "";
    if (cardShown) {
      // CopyField renders its testid as "<id>-value" on the readonly input (and
      // "<id>-copy" on the button), so query those. A successful create surfaces an
      // invite link AND a temp password (verified against the real admin API response).
      const link = await card.locator('[data-testid="invite-link-value"]').count().catch(() => 0);
      const pw = await card.locator('[data-testid="invite-password-value"]').count().catch(() => 0);
      const linkVal = link > 0 ? await card.locator('[data-testid="invite-link-value"]').inputValue().catch(() => "") : "";
      const pwVal = pw > 0 ? await card.locator('[data-testid="invite-password-value"]').inputValue().catch(() => "") : "";
      const linkMissing = await card.locator('[data-testid="invite-link-missing"]').count().catch(() => 0);
      surfaced = (link > 0 && linkVal.length > 0) || (pw > 0 && pwVal.length > 0);
      detail = `inviteLink=${link}(${linkVal ? "set" : "empty"}) tempPassword=${pw}(${pwVal ? "set" : "empty"}) linkMissingNote=${linkMissing}`;
    } else {
      detail = errText ? `error: ${errText}` : "no invite card";
    }
    rec.check(cardShown && surfaced,
      "creating a user surfaces an invite link and/or credentials",
      detail);

    // Cleanup: deactivate the freshly-created user so we don't leave an active stray login.
    if (cardShown) {
      const toggle = page.locator(`[data-testid="user-toggle-${testEmail}"]`);
      const hasRow = await toggle.count();
      if (hasRow > 0) {
        await toggle.click().catch(() => {});
        await page.waitForTimeout(2500);
        rec.info("cleanup: deactivated the created test user", testEmail);
      } else {
        rec.info("cleanup: created test user row not found to deactivate", testEmail);
      }
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
