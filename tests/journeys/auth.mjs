// JOURNEY 1 — AUTH. Unauthenticated app routes redirect to /sign-in; admin can sign in.
import { launch, signIn, BASE, makeRecorder } from "./lib.mjs";

export async function run() {
  const rec = makeRecorder("AUTH");
  const browser = await launch();
  try {
    // 1a. Each protected route, visited with NO session, must redirect to /sign-in.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const path of ["/dashboard", "/account", "/history", "/settings"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      const finalPath = new URL(page.url()).pathname;
      rec.check(
        finalPath === "/sign-in",
        `unauth ${path} redirects to /sign-in`,
        `landed on ${finalPath}`
      );
    }
    await ctx.close();

    // 1b. Admin signs in and actually reaches the gated dashboard (session cookie real).
    const { ctx: actx, page: apage } = await signIn(browser, "admin", "/dashboard");
    const onApp = new URL(apage.url()).pathname;
    rec.check(onApp.startsWith("/dashboard"), "admin sign-in reaches /dashboard", `at ${onApp}`);
    const consoleVisible = await apage
      .locator('[data-testid="assistant-console"]')
      .isVisible()
      .catch(() => false);
    rec.check(consoleVisible, "authenticated dashboard renders the assistant console", "");
    await actx.close();
  } finally {
    await browser.close();
  }
  return rec.summary();
}
