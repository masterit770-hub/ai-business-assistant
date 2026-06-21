// JOURNEY 8 — ADMIN. Users panel can create a user (surfaces invite link/credentials);
// a role-change control exists. Report present/absent. Created test users are left
// deactivated (kicked out) to avoid leaving an active stray login.
import { launch, signIn, makeRecorder, BASE } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("ADMIN");
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/settings");
    // The role-change controls live in a `hidden ... sm:flex` container, so a narrow
    // viewport hides them. Use a desktop width to exercise the real admin UI.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 45000 });
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
    await form.locator('input[type="email"]').fill(testEmail);
    await form.locator('input[type="text"]').fill("TempPass123!");
    await form.locator('button[type="submit"]').click();

    const card = page.locator('[data-testid="invite-card"]');
    const cardShown = await card.isVisible({ timeout: 20000 }).catch(() => false);
    // A real create error renders in the panel's red error BANNER (the bg-red-50 row at
    // the top of the panel), NOT in a button's red text — read that precise element.
    const errText = await page.locator('[data-testid="users-panel"] .bg-red-50').first().textContent({ timeout: 1500 }).catch(() => null);
    let surfaced = false, detail = "";
    if (cardShown) {
      const link = await card.locator('[data-testid="invite-link"]').count().catch(() => 0);
      const pw = await card.locator('[data-testid="invite-password"]').count().catch(() => 0);
      const linkMissing = await card.locator('[data-testid="invite-link-missing"]').count().catch(() => 0);
      surfaced = (link > 0) || (pw > 0);
      detail = `inviteLink=${link} tempPassword=${pw} linkMissingNote=${linkMissing}`;
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
