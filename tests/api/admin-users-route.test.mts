import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { adminUser, user, NextResponseShim, readJson, makeFakeAdmin, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET/POST /api/admin/users ────────────────────────────────
// The user-management surface — the ONE admin-only area. Contract:
//   • EVERY action is admin-gated (a plain user / signed-out → 403)
//   • create: requires email + a ≥6-char password (else 400)
//   • setRole: a valid role only; an admin CANNOT demote THEMSELVES (lockout guard)
//   • deactivate/reactivate: an admin CANNOT deactivate THEMSELVES
//   • an unknown action → 400
//   • kick-out is the two-layer effect: profiles.disabled + an auth ban + a global signOut
// requireAdmin + the admin Supabase client (profiles update + auth.admin) are stubbed
// with a recording fake; the handler's guards + the kick-out wiring are the real thing.

let caller: ReturnType<typeof adminUser> | null = adminUser({ id: "admin-self" });
let fake = makeFakeAdmin();
const authCalls: { fn: string; args: unknown[] }[] = [];

function authAdmin() {
  return {
    listUsers: async () => ({ data: { users: [] }, error: null }),
    createUser: async (...a: unknown[]) => { authCalls.push({ fn: "createUser", args: a }); return { data: { user: { id: "new-1" } }, error: null }; },
    updateUserById: async (...a: unknown[]) => { authCalls.push({ fn: "updateUserById", args: a }); return { error: null }; },
    signOut: async (...a: unknown[]) => { authCalls.push({ fn: "signOut", args: a }); return {}; },
    generateLink: async () => ({ data: { properties: { action_link: "https://link" } }, error: null }),
  };
}

before(() => {
  mockExports("next/server", NextResponseShim);
  mockExports("@/lib/supabase/auth", { requireAdmin: async () => caller, getCurrentUser: async () => caller });
  mockExports("@/lib/supabase/server", { createAdminClient: () => fake.client });
  // Real invite helpers (pure) — buildInviteResult/resolveAppOrigin are tested in unit;
  // here we just let them run so the create path returns a real invite payload.
});

beforeEach(() => {
  caller = adminUser({ id: "admin-self" });
  fake = makeFakeAdmin({ on: { "profiles:update": () => ({ data: null }), "profiles:select": () => ({ data: [] }) } });
  fake.client.auth = { admin: authAdmin() } as any;
  authCalls.length = 0;
});

async function GET() { return (await import("@/app/api/admin/users/route.ts")).GET(); }
async function POST(body: unknown) {
  return (await import("@/app/api/admin/users/route.ts")).POST(new Request("http://x/api/admin/users", { method: "POST", body: JSON.stringify(body) }));
}

// ── the admin-only gate (every entry point) ───────────────────────────────────────
test("GET as a non-admin → 403", async () => { caller = null; assert.equal((await GET()).status, 403); });
test("POST as a non-admin → 403", async () => { caller = null; assert.equal((await POST({ action: "deactivate", id: "x" })).status, 403); });

// ── input validation ───────────────────────────────────────────────────────────────
test("invalid JSON → 400", async () => {
  const mod = await import("@/app/api/admin/users/route.ts");
  assert.equal((await mod.POST(new Request("http://x", { method: "POST", body: "{no" }))).status, 400);
});
test("an unknown action → 400", async () => {
  assert.equal((await POST({ action: "frobnicate", id: "x" })).status, 400);
});
test("create with a short password (<6) → 400", async () => {
  const { status } = await readJson(await POST({ action: "create", email: "n@x.com", password: "12345" }));
  assert.equal(status, 400);
});
test("create with a valid email+password → ok + an invite payload", async () => {
  const { status, body } = await readJson(await POST({ action: "create", email: "n@x.com", password: "longenough" }));
  assert.equal(status, 200);
  assert.ok(body.invite, "the admin must get a usable invite payload");
  assert.ok(authCalls.find((c) => c.fn === "createUser"), "a real account must be created");
});

// ── the self-LOCKOUT guards (an admin can't lock themselves out) ──────────────────
test("an admin CANNOT demote THEMSELVES (would lose this panel) → 400", async () => {
  caller = adminUser({ id: "admin-self" });
  const { status, body } = await readJson(await POST({ action: "setRole", id: "admin-self", role: "user" }));
  assert.equal(status, 400);
  assert.match(body.error, /your own admin/i);
});
test("an admin CAN promote/demote ANOTHER user", async () => {
  caller = adminUser({ id: "admin-self" });
  const { status } = await readJson(await POST({ action: "setRole", id: "other-user", role: "admin" }));
  assert.equal(status, 200);
});
test("setRole with an invalid role → 400", async () => {
  const { status } = await readJson(await POST({ action: "setRole", id: "other", role: "superuser" }));
  assert.equal(status, 400);
});
test("an admin CANNOT deactivate THEMSELVES → 400", async () => {
  caller = adminUser({ id: "admin-self" });
  const { status, body } = await readJson(await POST({ action: "deactivate", id: "admin-self" }));
  assert.equal(status, 400);
  assert.match(body.error, /yourself/i);
});

// ── the kick-out is a TWO-LAYER effect (profiles flag + auth ban + global signOut) ─
test("deactivating another user sets the disabled flag, bans, and revokes sessions", async () => {
  caller = adminUser({ id: "admin-self" });
  const { status } = await readJson(await POST({ action: "deactivate", id: "victim" }));
  assert.equal(status, 200);
  // layer 1: profiles.disabled = true for the victim
  const upd = fake.calls.find((c) => c.table === "profiles" && c.op === "update")!;
  assert.equal(upd.eq["id"], "victim");
  // layer 2: an auth ban
  const ban = authCalls.find((c) => c.fn === "updateUserById")!;
  assert.equal(ban.args[0], "victim");
  assert.match(JSON.stringify(ban.args[1]), /ban_duration/);
  // layer 3: a global signOut revokes live sessions immediately
  const out = authCalls.find((c) => c.fn === "signOut")!;
  assert.equal(out.args[0], "victim");
  assert.equal(out.args[1], "global");
});
test("reactivating a user lifts the ban (ban_duration 'none') and does NOT signOut", async () => {
  caller = adminUser({ id: "admin-self" });
  await POST({ action: "reactivate", id: "victim" });
  const ban = authCalls.find((c) => c.fn === "updateUserById")!;
  assert.match(JSON.stringify(ban.args[1]), /none/);
  assert.equal(authCalls.find((c) => c.fn === "signOut"), undefined, "reactivate must not revoke sessions");
});
