import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { user, readJson, mockExports } from "./_harness/harness.mts";

// ── Contract under test: GET /api/table ───────────────────────────────────────────
// The handler's wiring is the thing under test: auth gate, the required ?table param,
// the OWNER-SCOPED catalog (a member's scope holds only their own uploaded tables →
// another member's table resolves to null → 404), the hidden-set exclusion, and the
// CSV-vs-paged branch (CSV must not be silently truncated to the UI page). The store
// + introspection + the pure decideAccess helper are stubbed/real respectively; here
// we assert the HANDLER composes them correctly.
//
// NOTE: this route returns the WEB Response.json directly (not NextResponse), so it
// needs no next/server shim.

let current: ReturnType<typeof user> | null = user();
let scopeSeen: { ownerId: unknown; isAdmin: boolean } | null = null;
let catalog: { table: string; columns: { name: string; type: string }[] }[] = [];
let hidden = new Set<string>();
const dbRows = [{ name: "Alice", amount: 10 }, { name: "Bob", amount: 20 }];

before(() => {
  mockExports("@/lib/supabase/auth", { getCurrentUser: async () => current });
  mockExports("@/lib/engine/deleted-sources", { refreshDeletedSources: async () => {}, deletedSourceIds: () => hidden });
  mockExports("@/lib/engine/bundled-sources", { bundledSources: () => [{ doc: "contracts", kind: "structured" }] });
  mockExports("@/lib/engine/structured-store", {
      hydrateUploadedTables: async () => {},
      introspectSchema: (_d: number, _b: boolean, scope: { ownerId: unknown; isAdmin: boolean }) => {
        scopeSeen = scope;
        return { catalog };
      },
      getStore: () => ({
        prepare: (sql: string) => ({
          get: () => ({ n: dbRows.length }),
          all: (...args: unknown[]) => {
            // CSV path binds (CSV_MAX_ROWS); paged binds (limit, offset).
            return /OFFSET/.test(sql) ? dbRows.slice(Number(args[1]) || 0, (Number(args[1]) || 0) + (Number(args[0]) || dbRows.length)) : dbRows;
          },
        }),
      }),
    });
});

beforeEach(() => {
  current = user();
  scopeSeen = null;
  hidden = new Set();
  catalog = [{ table: "my_table", columns: [{ name: "name", type: "TEXT" }, { name: "amount", type: "INTEGER" }] }];
});

async function GET(qs: string) {
  return (await import("@/app/api/table/route.ts")).GET(new Request(`http://x/api/table?${qs}`));
}

// ── auth + input ──────────────────────────────────────────────────────────────────
test("unauthenticated → 401", async () => { current = null; assert.equal((await GET("table=my_table")).status, 401); });
test("disabled user → 401", async () => { current = user({ disabled: true }); assert.equal((await GET("table=my_table")).status, 401); });
test("missing ?table → 400", async () => { assert.equal((await GET("")).status, 400); });

// ── owner-scoped catalog (the isolation contract) ─────────────────────────────────
test("a MEMBER introspects with their own ownerId + isAdmin=false", async () => {
  current = user({ id: "mem-3", role: "user" });
  await GET("table=my_table");
  assert.deepEqual(scopeSeen, { ownerId: "mem-3", isAdmin: false });
});
test("an ADMIN introspects unscoped (ownerId undefined, isAdmin=true)", async () => {
  current = user({ id: "adm", role: "admin" });
  await GET("table=my_table");
  assert.deepEqual(scopeSeen, { ownerId: undefined, isAdmin: true });
});
test("a table NOT in the caller's scoped catalog → 404 (another member's table)", async () => {
  catalog = [{ table: "someone_elses", columns: [] }];
  assert.equal((await GET("table=my_table")).status, 404);
});
test("a HIDDEN (admin-deleted) table → not served", async () => {
  hidden = new Set(["my_table"]);
  const res = await GET("table=my_table");
  assert.notEqual(res.status, 200, "a hidden table must never be served with a 200");
});

// ── happy path: real columns + rows + paging metadata ─────────────────────────────
test("returns the canonical columns + rows + total + hasMore", async () => {
  const { status, body } = await readJson(await GET("table=My_Table")); // case-insensitive match
  assert.equal(status, 200);
  assert.equal(body.table, "my_table");
  assert.deepEqual(body.columns.map((c: any) => c.name), ["name", "amount"]);
  assert.equal(body.total, 2);
  assert.equal(body.rows.length, 2);
  assert.equal(body.hasMore, false);
});

// ── CSV export must not be silently truncated to the UI page ──────────────────────
test("?format=csv returns a real CSV attachment, not JSON", async () => {
  const res = await GET("table=my_table&format=csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const text = await res.text();
  assert.match(text, /name/);
  assert.match(text, /Alice/);
  assert.match(text, /Bob/);
});
