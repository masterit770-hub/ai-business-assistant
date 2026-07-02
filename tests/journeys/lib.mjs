// Shared harness for the Nucleus journey + component suite.
//
// Independent acceptance tests: they drive the LIVE deployed app through a real
// Chromium and assert the REAL user-visible outcome — never just an HTTP 200.
// Credentials are read from /home/codex/Projects/nucleus/.secrets/demo-accounts.txt
// at runtime (never hardcoded, never logged). Nothing here prints a secret.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Default = the LIVE production deployment. This literal is pinned to
// PRODUCTION_FRONTEND_URL (src/lib/backend-redirect.ts) by tests/unit/prod-url-pin.test.mts
// — a rename that leaves this behind fails that test instead of silently certifying a
// dead deployment. Set NUCLEUS_BASE=http://localhost:3000 to run against the dev server.
export const BASE = process.env.NUCLEUS_BASE || "https://nucleus-770.vercel.app";
// LOUD on import — every consumer (the runner AND ad-hoc scripts) sees where asks will
// go. The runner has its own preflight banner, but a one-off script importing this lib
// gets no other warning, and an unset NUCLEUS_BASE aims at LIVE PROD (billed asks) —
// exactly how an unintended prod call happened on 2026-07-02 (call-log ON-5).
console.error(
  `[journeys/lib] target BASE = ${BASE} (${process.env.NUCLEUS_BASE ? "from NUCLEUS_BASE" : "DEFAULT → LIVE PROD — set NUCLEUS_BASE for a local run"})`
);
const CHROME =
  process.env.NUCLEUS_CHROME ||
  "/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const ACCOUNTS_FILE =
  process.env.NUCLEUS_ACCOUNTS || "/home/codex/Projects/nucleus/.secrets/demo-accounts.txt";

// ⛔ TEST-ACTOR DENYLIST — the REAL CLIENT's account must NEVER be a journey actor.
// The accounts file legitimately lists her login (ops/restore reasons), and the old
// parser collapsed "last email under the header" — which silently made HER live
// account the `member` actor for EVERY journey once her entry was appended (caught
// 2026-07-03: days of RUN=B certifications had been running on the client's account).
// A safety interlock is deliberately explicit: this list names the protected account.
const CLIENT_ACCOUNT_DENYLIST = new Set(["aditesadi@gmail.com"]);
function assertNotClientAccount(email, where) {
  if (email && CLIENT_ACCOUNT_DENYLIST.has(email.toLowerCase())) {
    throw new Error(
      `${where} resolved to the REAL CLIENT's account — journeys must never act on it. ` +
        `Fix the accounts file/bucket, do not remove this guard.`
    );
  }
}

// Parse the demo-accounts file into { admin: {email,password}, member: {email,password} }.
// The file groups creds under "ADMIN (...)" and "REGULAR USER (...)" headers with
// indented "email:" / "password:" lines. We never echo any value we read here.
// Each bucket takes the FIRST complete email+password pair after its header (the file's
// intended TEST account) — never a later entry (the client's login sits further down).
export function readAccounts() {
  const raw = readFileSync(ACCOUNTS_FILE, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = { admin: {}, member: {} };
  let bucket = null;
  for (const line of lines) {
    if (/ADMIN/i.test(line) && /:/.test(line) === false) bucket = "admin";
    else if (/ADMIN/i.test(line)) bucket = "admin";
    if (/REGULAR USER|MEMBER/i.test(line)) bucket = "member";
    const m = line.match(/^\s*(email|password)\s*:\s*(.+?)\s*$/i);
    if (m && bucket && !(out[bucket].email && out[bucket].password)) {
      const key = m[1].toLowerCase();
      // First COMPLETE pair wins: only fill a field while the pair is incomplete.
      if (!out[bucket][key]) out[bucket][key] = m[2];
    }
  }
  if (!out.admin.email || !out.admin.password) {
    throw new Error("could not parse admin credentials from accounts file");
  }
  assertNotClientAccount(out.admin.email, "readAccounts().admin");
  assertNotClientAccount(out.member.email, "readAccounts().member");
  return out;
}

// Find a SPECIFIC account in the accounts file by email and return { email, password }.
// The file lists several emails under one "REGULAR USER" header, so the generic bucket
// parser collapses them to the last one — this helper resolves a named account exactly
// (e.g. the DEMO regular user nucleus.user@meridian.co for the demo-only Sample-data
// check, distinct from a non-demo regular user listed under the same header). Returns the
// email + the FIRST password line that follows it. Never logs the password.
export function readNamedAccount(email) {
  assertNotClientAccount(email, "readNamedAccount()");
  const lines = readFileSync(ACCOUNTS_FILE, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const em = lines[i].match(/^\s*email\s*:\s*(.+?)\s*$/i);
    if (em && em[1].toLowerCase() === email.toLowerCase()) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const pw = lines[j].match(/^\s*password\s*:\s*(.+?)\s*$/i);
        if (pw) return { email: em[1], password: pw[1] };
        // Stop if we hit the next email before a password (no paired password).
        if (/^\s*email\s*:/i.test(lines[j])) break;
      }
    }
  }
  throw new Error(`no account with email ${email} (and a paired password) in accounts file`);
}

export async function launch() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

// Sign in via the real Supabase email/password form and wait until the app route
// loads (the middleware-protected page actually renders, proving the session cookie
// is set). Returns the authenticated page.
//
// Supabase free-tier auth rate-limits sequential sign-in attempts across journeys
// (typically "3 per minute" rolling window). When the rate limit fires, the form
// returns "missing email or phone" or "over email send rate limit" errors instead
// of authenticating. We auto-retry up to 3 times with 20 s back-off so the full
// suite can run end-to-end without a hard inter-journey wait that's long enough to
// clear the window (which is often 60 s). This does NOT mask real auth failures —
// if the error is not a transient rate-limit string we re-throw immediately.
const RATE_LIMIT_PHRASES = [
  "missing email or phone",
  "over email send rate limit",
  "too many requests",
  "rate limit",
  "email rate limit exceeded",
];
function isRateLimit(err) {
  const msg = (err?.message ?? "").toLowerCase();
  return RATE_LIMIT_PHRASES.some((p) => msg.includes(p));
}

export async function signIn(browser, who = "admin", target = "/dashboard") {
  // `who` is either a known bucket name ("admin"/"member") read from the accounts file,
  // OR an explicit { email, password } object (used for a seeded client account that is
  // NOT in demo-accounts.txt — e.g. the non-demo sidebar check Z16). We never log either.
  const cred =
    who && typeof who === "object" && who.email ? who : readAccounts()[who];
  if (!cred?.email) throw new Error(`no ${typeof who === "string" ? who : "explicit"} credentials`);
  // Belt at the point of use: explicit {email,password} objects bypass readAccounts,
  // so the client-account interlock must also fire here.
  assertNotClientAccount(cred.email, "signIn()");

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/sign-in?next=${encodeURIComponent(target)}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      // Wait for React to hydrate the controlled inputs before filling — the auth form
      // uses controlled inputs (onChange → setEmail). If we fill before the event
      // handlers are wired up, the native DOM value changes but the React state does
      // not, and the form submits with an empty email (browser shows a tooltip but
      // data-testid="auth-error" never appears). We detect hydration by typing into the
      // email field and confirming the value persists across a brief React re-render.
      await page.locator('input#email').waitFor({ state: "visible", timeout: 15000 });
      // Retry the fill up to 3 times in case of hydration races.
      for (let fillAttempt = 1; fillAttempt <= 3; fillAttempt++) {
        await page.locator('input#email').click();
        await page.locator('input#email').fill(cred.email);
        await page.locator('input#password').click();
        await page.locator('input#password').fill(cred.password);
        // Brief settle so React state catches up.
        await page.waitForTimeout(300);
        // Confirm the inputs hold the typed values (controlled component hydrated).
        const emailVal = await page.locator('input#email').inputValue().catch(() => "");
        const passVal = await page.locator('input#password').inputValue().catch(() => "");
        if (emailVal && passVal) break;
        if (fillAttempt === 3) throw new Error("sign-in form inputs did not retain values after 3 fill attempts (React hydration race)");
        await page.waitForTimeout(500);
      }
      await Promise.all([
        page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 45000 }),
        page.click('[data-testid="auth-submit"]'),
      ]).catch(async () => {
        // surface the auth error text if the redirect never happened
        const errText = await page
          .locator('[data-testid="auth-error"]')
          .textContent()
          .catch(() => null);
        throw new Error(`sign-in did not navigate away from /sign-in${errText ? ` (auth-error: ${errText})` : ""}`);
      });
      return { ctx, page };
    } catch (e) {
      lastError = e;
      await ctx.close().catch(() => {});
      if (!isRateLimit(e) || attempt >= 3) throw e;
      // Rate-limit back-off: 25 s is enough to clear Supabase's rolling window.
      const delay = 25000;
      console.log(`  [signIn] rate-limit detected on attempt ${attempt} — waiting ${delay / 1000} s before retry`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// A tiny assertion + result harness so each journey reports a clean PASS/FAIL line
// with concrete evidence, and the runner can aggregate.
export function makeRecorder(journey) {
  const checks = [];
  return {
    journey,
    checks,
    // ok(cond, label, evidence) — records a single check.
    check(cond, label, evidence = "") {
      checks.push({ pass: !!cond, label, evidence: String(evidence).slice(0, 300) });
      const tag = cond ? "PASS" : "FAIL";
      console.log(`  [${tag}] ${label}${evidence ? ` — ${String(evidence).slice(0, 200)}` : ""}`);
    },
    // info — a non-pass/fail observation (present/absent reporting).
    info(label, evidence = "") {
      console.log(`  [INFO] ${label}${evidence ? ` — ${String(evidence).slice(0, 200)}` : ""}`);
    },
    summary() {
      const failed = checks.filter((c) => !c.pass);
      return { journey, total: checks.length, failed: failed.length, checks };
    },
  };
}

// ── GOLDEN-VALUE matchers ────────────────────────────────────────────────────────
// A journey that only asserts "an answer came back, >40 chars, a cite chip exists" is
// VALUE-BLIND: a fluent but WRONG answer ("custody to Bob, $999/mo") sails through. These
// assert the answer contains the REAL fact from the source corpus, so a wrong-but-cited
// answer FAILS. The number matcher tolerates comma/space/no-separator + an optional $/₪
// (so "1,285" / "1285" / "$1,285" / "1 285" all match the same golden figure) but still
// pins the exact digits — it is NOT a loose substring.
export const goldenNumber = (digits) =>
  new RegExp(`[$₪]?\\s?${String(digits).split("").join("[\\s,]?")}(?!\\d)`);
// True iff `text` contains the golden figure as a real number (not a fragment of a longer one).
export const hasGoldenNumber = (text, digits) => goldenNumber(digits).test(text || "");
// True iff EVERY required fact (string → case-insensitive substring; RegExp → test) is present.
export const hasAllFacts = (text, facts) => {
  const t = text || "";
  return facts.every((f) => (f instanceof RegExp ? f.test(t) : t.toLowerCase().includes(String(f).toLowerCase())));
};

// Ask one question in the assistant console and wait for a new answered turn to appear.
// Returns the index of the new turn. Throws if neither an answer nor an error card shows.
//
// ⛔ COST: this is the ONLY helper that triggers a real /api/ask (an agentic Claude call
// on the SDK/answer engine). It is used ONLY by the bounded answer-quality module
// (answer-surface.mjs), which is gated behind NUCLEUS_RUN_SDK=1 so the SDK-call count is
// provable. Every zero-SDK check below drives the API/DOM directly and never calls this.
export async function askAndWait(page, question, { timeout = 90000 } = {}) {
  const before = await page.locator('[data-testid="chat-turn"]').count();
  await page.fill('[data-testid="assistant-console"] textarea', question);
  await page.click('[data-testid="send-ask"]');
  // Wait for either a new completed turn OR a visible error card.
  await page.waitForFunction(
    (n) => {
      const turns = document.querySelectorAll('[data-testid="chat-turn"]').length;
      const err = document.querySelector('[data-testid="ask-error"]');
      return turns > n || !!err;
    },
    before,
    { timeout }
  );
  return before;
}

// ── ZERO-SDK helpers ─────────────────────────────────────────────────────────────
// Everything below drives the REAL product (the /api routes, the DB, the browser DOM)
// WITHOUT ever triggering an agentic Claude/SDK call. They are how the 21 plumbing
// checks (ingest formats, console UX, per-account sidebar, delete, prompts, bulk-delete)
// run for free while still asserting real user-visible behavior.

const SUPABASE_ENV =
  process.env.NUCLEUS_SUPABASE_ENV || "/home/codex/Projects/nucleus/.secrets/supabase.env";

// Run a single SQL statement against the project's Postgres via psql, sourcing the
// gitignored supabase.env for creds (never printed). Returns trimmed stdout (-tA: tuples-
// only, unaligned). Throws on a non-zero exit so a seeding failure is loud, not silent.
// Used by the seed/cleanup helpers (Z13 markdown turn, Z19 open-chat, Z23 bulk-delete).
export function psql(sql) {
  const script =
    `set -a; . "${SUPABASE_ENV}"; set +a; ` +
    `PGPASSWORD="$SUPABASE_DB_PASSWORD" psql ` +
    `"host=db.\${SUPABASE_PROJECT_REF}.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" ` +
    `-tAc "$NUCLEUS_SQL"`;
  const res = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, NUCLEUS_SQL: sql },
  });
  if (res.status !== 0) {
    throw new Error(`psql failed (${res.status}): ${(res.stderr || res.stdout || "").slice(0, 300)}`);
  }
  return (res.stdout || "").trim();
}

// Single-quote-escape a string literal for inline SQL (doubles every ' ). We pass values
// through the env for the SQL TEXT itself, but ids/labels embedded in a statement use this.
export function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Look up a profile's auth user id (owner_id) by email — needed to seed owner-scoped rows
// (ask_history, etc.) for a specific signed-in account. Returns null if not found.
export function ownerIdForEmail(email) {
  const out = psql(`select id from public.profiles where email = ${sqlLit(email)} limit 1;`);
  return out || null;
}

// Upload a file to /api/ingest THROUGH the page's authenticated session (its cookies), as
// real multipart/form-data — exactly what the Upload button posts. Returns the parsed JSON
// response ({ ok, ingested, zeroContent, ... } or { error }). NO agentic call: ingest is
// the document/SQL lane (text extraction + local e5 embeddings), never a Claude call.
// `bytes` is a number[] (so it survives the page.evaluate boundary), `type` the MIME type.
export async function uploadFileBytes(page, { name, type, bytes, sessionId = null, base = BASE }) {
  return page.evaluate(
    async ([n, t, b, sid, baseUrl]) => {
      const u8 = new Uint8Array(b);
      const fd = new FormData();
      fd.append("file", new File([u8], n, { type: t }), n);
      if (sid) fd.append("session_id", sid);
      const r = await fetch(`${baseUrl}/api/ingest`, { method: "POST", body: fd });
      let body;
      try {
        body = await r.json();
      } catch {
        body = { error: await r.text().catch(() => "non-JSON response") };
      }
      return { status: r.status, ...body };
    },
    [name, type, bytes, sessionId, base]
  );
}

// Read a file from disk into a plain number[] so it can cross the page.evaluate boundary.
export function fileBytes(absPath) {
  const buf = readFileSync(absPath);
  return Array.from(buf);
}

// Build a 1-page, IMAGE-ONLY (scanned-style) PDF in scratchpad and return its absolute
// path. The page is a rasterized image of text — there is NO text layer, so unpdf extracts
// nothing; this is the exact shape that USED to 500 the ingest route (Bug 1). We rasterize
// with Pillow (text drawn onto a bitmap) and embed that bitmap as the sole PDF page via
// reportlab — both confirmed present on this box. Deterministic content so the probe can
// also assert the agent reads it. Returns null (with a reason) if the tooling is missing,
// so the journey can SKIP honestly rather than fail on an environment gap.
export function makeImageOnlyPdf(outPath, text = "SCANNED CONFIDENTIAL MEMO — image only, no text layer.") {
  const py = `
import sys
try:
    from PIL import Image, ImageDraw
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
except Exception as e:
    print("MISSING:" + str(e)); sys.exit(3)
import io
# 1) draw the text onto a bitmap (this becomes pixels — NOT a selectable text layer)
img = Image.new("RGB", (1000, 1400), "white")
d = ImageDraw.Draw(img)
for i, line in enumerate(${JSON.stringify(text)}.split("\\n")):
    d.text((60, 80 + i*60), line, fill="black")
buf = io.BytesIO(); img.save(buf, format="PNG"); buf.seek(0)
# 2) embed the bitmap as the only page of a PDF (so the PDF has zero extractable text)
c = canvas.Canvas(${JSON.stringify(outPath)}, pagesize=(595, 842))
c.drawImage(ImageReader(buf), 0, 0, width=595, height=842)
c.showPage(); c.save()
print("OK")
`;
  const res = spawnSync("python3", ["-c", py], { encoding: "utf8", timeout: 30000 });
  const out = (res.stdout || "") + (res.stderr || "");
  if (res.status === 0 && out.includes("OK")) return { ok: true, path: outPath };
  return { ok: false, reason: out.trim().slice(0, 200) };
}

// Parse supabase.env into a plain object (KEY=VALUE lines). Never logs values.
function readSupabaseEnv() {
  const raw = readFileSync(SUPABASE_ENV, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// ── Seed a dedicated NON-DEMO client account (for the per-account sidebar Z16) ──────
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from supabase.env (never logged) and,
// via the Admin auth API, ensures a STABLE test user exists with a known password and
// is_demo=false — the production-faithful "real client" context. Idempotent: if the user
// already exists we just (re)set its password + confirm it. Returns { email, password,
// id } or throws. The password is generated per call but returned to the caller (never
// printed). This is the only legitimate use of the service-role key in the suite: it
// provisions a THROWAWAY test identity, it does NOT touch a real client's account.
export async function seedClientAccount({
  email = "journey-client@nucleus-test.invalid",
  password,
} = {}) {
  const { createClient } = await import("@supabase/supabase-js");
  const env = readSupabaseEnv();
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in supabase.env");
  const pass = password || `Journey!${Math.random().toString(36).slice(2, 10)}A9`;
  const sb = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Find an existing user with this email (paginate the admin list — small project).
  let existingId = null;
  for (let page = 1; page <= 10 && !existingId; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const hit = (data?.users || []).find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
    if (hit) existingId = hit.id;
    if ((data?.users || []).length < 200) break;
  }

  let id;
  if (existingId) {
    const { error } = await sb.auth.admin.updateUserById(existingId, { password: pass, email_confirm: true });
    if (error) throw new Error(`updateUserById failed: ${error.message}`);
    id = existingId;
  } else {
    const { data, error } = await sb.auth.admin.createUser({ email, password: pass, email_confirm: true });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    id = data.user.id;
  }

  // Ensure the profile row exists and is a NON-DEMO regular user (the real-client context).
  // The profiles trigger usually creates the row on signup; upsert to be safe + force flags.
  psql(
    `insert into public.profiles (id, email, role, is_demo) values (${sqlLit(id)}, ${sqlLit(email)}, 'user', false) ` +
      `on conflict (id) do update set is_demo = false, role = 'user', email = ${sqlLit(email)};`
  );
  return { email, password: pass, id };
}
