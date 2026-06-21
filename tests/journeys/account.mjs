// JOURNEY 7 — ACCOUNT. /account loads; save a display name; toggle theme; password mismatch rejected.
import { launch, signIn, makeRecorder, BASE } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("ACCOUNT");
  const browser = await launch();
  try {
    const { ctx, page } = await signIn(browser, "admin", "/account");
    await page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded", timeout: 45000 });

    // 7a. /account loads with the profile + password + theme sections.
    const profile = await page.locator('[data-testid="profile-section"]').isVisible().catch(() => false);
    rec.check(profile, "/account loads (profile section visible)", "");

    // 7b. Save a display name → "Saved" confirmation appears (real Supabase updateUser).
    const nameInput = page.locator('[data-testid="display-name-input"]');
    await nameInput.waitFor({ state: "visible", timeout: 20000 });
    const stamp = `QA Verify ${Date.now() % 100000}`;
    await nameInput.click();
    await nameInput.fill("");
    await nameInput.type(stamp, { delay: 15 });
    // The Save button is disabled until the name is dirty (React state). Wait for it to
    // enable before clicking, so we don't race the onChange-driven enable.
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="save-name"]');
      return b && !b.disabled;
    }, null, { timeout: 10000 });
    await page.click('[data-testid="save-name"]');
    const saved = await page.locator('[data-testid="name-saved"]').isVisible({ timeout: 15000 }).catch(() => false);
    const nameErr = await page.locator('[data-testid="name-error"]').textContent().catch(() => null);
    rec.check(saved && !nameErr, "saving a display name shows Saved (real auth update)", nameErr ? `error: ${nameErr}` : "Saved shown");

    // 7c. Toggle theme: clicking Dark sets data-theme="dark" on <html>.
    await page.click('[data-testid="theme-dark"]');
    let theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const wentDark = theme === "dark";
    await page.click('[data-testid="theme-light"]');
    theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const wentLight = theme !== "dark";
    rec.check(wentDark && wentLight, "theme toggle switches dark/light (data-theme on <html>)", `dark=${wentDark}, backToLight=${wentLight}`);

    // 7d. Password mismatch is rejected (no Supabase call, a friendly error shown).
    await page.fill('[data-testid="new-password-input"]', "abcdef12");
    await page.fill('[data-testid="confirm-password-input"]', "different99");
    await page.click('[data-testid="save-password"]');
    const pwErr = await page.locator('[data-testid="password-error"]').textContent({ timeout: 8000 }).catch(() => null);
    const pwSaved = await page.locator('[data-testid="password-saved"]').isVisible().catch(() => false);
    rec.check(!!pwErr && !pwSaved, "password mismatch is rejected with an error", pwErr ? `error: ${pwErr}` : "no error shown");

    await ctx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
