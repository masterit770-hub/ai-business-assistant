// Shared scaffolding for the API route-handler contract tests.
//
// These tests drive the REAL route handler (the thing under test). Only the I/O
// seams the handler talks to are mock.module()'d: the auth resolver, the Supabase
// client(s), the persistence stores, and NextResponse. The handler's own logic —
// auth gating, input validation, role checks, the write-only-key protection, the
// self-lockout guards, owner-scoping, and error→status mapping — runs for real.
//
// Run with: node --experimental-strip-types --experimental-test-module-mocks \
//             --import ./tests/api/_harness/alias-register.mjs --test tests/api/*.test.mts

import { mock } from "node:test";

// Mock a module's exports. The node:test RUNTIME takes { exports } (the { namedExports }
// form is deprecated), but the installed @types/node still types the option as
// { namedExports }. This one cast keeps every test file tsc-clean AND runtime-correct,
// so we never scatter `as any` across the suites.
export function mockExports(specifier: string, exports: Record<string, unknown>): void {
  mock.module(specifier, { exports } as unknown as Parameters<typeof mock.module>[1]);
}

export type Role = "user" | "admin";
export type FakeUser = {
  id: string;
  email: string | null;
  role: Role;
  disabled: boolean;
  isDemo: boolean;
};

export function user(over: Partial<FakeUser> = {}): FakeUser {
  return { id: "user-1", email: "u@x.com", role: "user", disabled: false, isDemo: false, ...over };
}
export function adminUser(over: Partial<FakeUser> = {}): FakeUser {
  return user({ id: "admin-1", email: "a@x.com", role: "admin", ...over });
}

// A faithful NextResponse.json shim — exactly the status/JSON-body semantics the
// handlers rely on (NextResponse.json is a thin wrapper over the web Response.json).
export const NextResponseShim = {
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
};

// Read a handler Response back as { status, body } so tests assert on real values.
export async function readJson(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  let body: unknown = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body };
}

// ── A recording fake Supabase query-builder ──────────────────────────────────────
// Mimics the chainable PostgREST builder the handlers use (.from().select().eq()
// .order().limit() / .update().eq() / .delete().eq().select() / .upsert()). Every
// call is recorded so a test can assert the OWNER-SCOPING a handler applied (e.g. a
// member's read carries .eq("owner_id", <self>); an admin's does not). The terminal
// result is whatever the test seeds per table+op. This lets the per-user-isolation
// CONTRACT be asserted deterministically without a live DB.
//
// ⚠ FAITHFUL-FAKE TRIPWIRE — this fake does NOT filter by owner. `.eq()` only RECORDS the
// filter into `rec.eq`; `result()` returns the SEEDED rows for the table+op regardless of
// any recorded filters. So an owner-scoping test MUST assert `rec.eq["owner_id"]` (or drive
// the catalog-scoping path) — NEVER infer isolation from the returned data shape alone (e.g.
// "empty came back" / "only my row came back"). A test that asserts only the data shape would
// pass even if the handler dropped its owner filter entirely: a silent faithful-fake hole.
export type Recorded = { op: string; table: string; eq: Record<string, unknown>; args: unknown[] };

export type SeedResult = { data?: unknown; error?: { message: string } | null; count?: number | null };
type Responder = (rec: Recorded) => SeedResult;

export function makeFakeAdmin(opts: {
  // Per table+op responder, e.g. { "ask_history:select": rec => ({ data: [...] }) }.
  on?: Record<string, Responder>;
  authAdmin?: Record<string, (...a: any[]) => any>;
} = {}) {
  const calls: Recorded[] = [];
  const on = opts.on ?? {};

  function builder(table: string, op: string) {
    const rec: Recorded = { op, table, eq: {}, args: [] };
    const result = () => {
      const key = `${table}:${op}`;
      const r = on[key] ? on[key](rec) : { data: [], error: null, count: null };
      return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
    };
    const chain: any = {
      payload: (entry: unknown) => { rec.args.push(entry); return chain; },
      select: (...a: unknown[]) => { rec.args.push(["select", ...a]); return chain; },
      eq: (col: string, val: unknown) => { rec.eq[col] = val; return chain; },
      in: (col: string, vals: unknown) => { rec.eq[`in:${col}`] = vals; return chain; },
      order: (...a: unknown[]) => { rec.args.push(["order", ...a]); return chain; },
      limit: (...a: unknown[]) => { rec.args.push(["limit", ...a]); return chain; },
      maybeSingle: async () => result(),
      single: async () => result(),
      upsert: (...a: unknown[]) => { rec.op = "upsert"; rec.args.push(["upsert", ...a]); calls.push(rec); return result(); },
      // delete()/select() returns a thenable resolving to the result.
      then: (resolve: (v: unknown) => void) => { calls.push(rec); resolve(result()); },
    };
    return chain;
  }

  const client = {
    from: (table: string) => ({
      select: (...a: unknown[]) => { const c = builder(table, "select"); c.select(...a); return c; },
      update: (vals: unknown) => { const c = builder(table, "update"); c.payload(["update", vals]); return c; },
      delete: () => builder(table, "delete"),
      upsert: (vals: unknown, o?: unknown) => { const c = builder(table, "upsert"); return c.upsert(vals, o); },
      insert: (vals: unknown) => { const c = builder(table, "insert"); c.payload(["insert", vals]); return c; },
    }),
    auth: { admin: opts.authAdmin ?? {} },
  };
  return { client, calls };
}
