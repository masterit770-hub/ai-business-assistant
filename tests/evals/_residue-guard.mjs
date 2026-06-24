// SHARED RESIDUE GUARD for the integration eval shards (tests/evals/*.mjs).
//
// WHY THIS EXISTS (the load-bearing false-green fix — task #79): every eval that creates a
// THROWAWAY owner (create auth user → ingest her files → assert → delete) must leave the
// shared Supabase DB exactly as it found it. The participation-count harness did NOT — its
// cleanup enumerated `listUploadedTables(OWNER)` only AFTER ingest and deleted just those,
// with NO pre/post orphan assertion. When a run errored mid-ingest, or a delete partially
// failed, the throwaway owner's rows LEAKED. Those orphans then polluted the next run's
// catalog (any NULL-owner row is visible to every member; an undeleted owner's tables can
// collide on a sanitized table name) → a FALSE GREEN that read as "7/7" while the DB was
// dirty. A leaking harness made BOTH graders unreliable.
//
// THE GUARD (mirrors the verifier's pre-flight, in ONE reusable place so it can't drift):
//   • assertCleanBefore() — BEFORE creating any throwaway owner, count orphan throwaway
//     rows. If the DB is already dirty (a prior run leaked), ABORT LOUDLY with exit 1 — a
//     dirty starting state means every result this run produces is untrustworthy, so we
//     refuse to run rather than emit a false green over polluted data.
//   • assertCleanAfter() — AFTER cleanup, re-count. If this run LEAKED, FAIL the run
//     (exit 1) so the leak surfaces immediately instead of silently corrupting the NEXT run.
//
// WHAT COUNTS AS A THROWAWAY ORPHAN: a throwaway owner is an auth user whose email is in
// the reserved `@nucleus-eval.invalid` domain (EVERY eval uses it). An orphan is:
//   (a) any such auth user that still EXISTS, plus
//   (b) any doc_chunks / uploaded_rows row owned by such a user (or by an owner_id that is
//       NOT a real account — we treat any owner_id tied to a throwaway-domain user as residue).
// We do NOT touch real accounts (the demo-admin 3d1ca025 / the client b01c311e) or
// NULL-owner shared rows that predate the run — only rows tied to throwaway users.
//
// USAGE in a shard (creates an owner):
//   import { assertCleanBefore, assertCleanAfter } from "./_residue-guard.mjs";
//   await assertCleanBefore("participation-count");   // before newOwner()
//   …run…
//   await cleanup();                                  // your own owner+table deletes
//   await assertCleanAfter("participation-count");    // after cleanup, before exit
//
// It reads creds from process.env (the shard's loadEnvFile already ran). It imports the
// project's service-role client so it scopes exactly like the engine.

const THROWAWAY_DOMAIN = "@nucleus-eval.invalid";

// Lazily import the project's admin client so this helper has no top-level side effects
// (a shard that skips on missing creds never reaches here).
async function db() {
  const { admin, supabaseEnabled } = await import("../../src/lib/engine/supabase.ts");
  if (!supabaseEnabled()) throw new Error("residue-guard: Supabase not configured");
  return admin();
}

/**
 * Enumerate every throwaway auth user (email in the reserved domain) by paging the admin
 * user list. Returns their ids. These are the ONLY owners the guard considers residue.
 */
async function listThrowawayOwnerIds(client) {
  const ids = new Set();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`residue-guard: listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) {
      if ((u.email || "").toLowerCase().endsWith(THROWAWAY_DOMAIN)) ids.add(u.id);
    }
    if (users.length < 200) break;
  }
  return ids;
}

/**
 * Count residue: throwaway auth users that still exist + their rows in doc_chunks and
 * uploaded_rows. Returns a {users, docChunks, uploadedRows, total, ownerIds} breakdown so
 * the caller can print a precise diagnosis (and so the guard can offer to purge).
 */
export async function countResidue() {
  const client = await db();
  const ownerIds = [...(await listThrowawayOwnerIds(client))];
  let docChunks = 0;
  let uploadedRows = 0;
  // Count rows owned by throwaway users. `.in()` caps at a sane batch; chunk the ids.
  for (let i = 0; i < ownerIds.length; i += 100) {
    const batch = ownerIds.slice(i, i + 100);
    if (batch.length === 0) continue;
    const dc = await client.from("doc_chunks").select("id", { count: "exact", head: true }).in("owner_id", batch);
    if (!dc.error) docChunks += dc.count ?? 0;
    const ur = await client.from("uploaded_rows").select("id", { count: "exact", head: true }).in("owner_id", batch);
    if (!ur.error) uploadedRows += ur.count ?? 0;
  }
  return {
    users: ownerIds.length,
    docChunks,
    uploadedRows,
    total: ownerIds.length + docChunks + uploadedRows,
    ownerIds,
  };
}

function banner(evalName, r, phase) {
  const line = "═".repeat(72);
  console.log("\n" + line);
  console.log(`🟥 RESIDUE GUARD (${phase}) — ${evalName}: DB is DIRTY, NOT residue-clean.`);
  console.log(`   throwaway owners=${r.users}, orphan doc_chunks=${r.docChunks}, orphan uploaded_rows=${r.uploadedRows} (total ${r.total}).`);
  console.log(`   A dirty DB makes every result this run produces untrustworthy (the false-green this guard prevents).`);
  if (r.ownerIds.length) console.log(`   leaked owner ids: ${r.ownerIds.map((x) => x.slice(0, 8)).join(", ")}`);
  console.log(`   PURGE with: node tests/evals/_residue-guard.mjs --purge   (deletes ONLY @${THROWAWAY_DOMAIN} owners + their rows).`);
  console.log(line);
}

/**
 * FK-SETTLE a freshly-created throwaway owner: wait until auth.admin.getUserById confirms the new
 * auth.users row is VISIBLE before the caller ingests. admin.createUser() can RETURN before the row
 * is consistent for the doc_chunks / uploaded_rows owner_id FK; an immediate ingest then throws
 * "violates foreign key constraint ..._owner_id_fkey" → 0 rows persist → empty catalog → a flaky
 * false FAILURE (the FK-race that confounded grade after grade). Shared so every eval settles the
 * same way. Product is unaffected — a real user exists long before they upload; this only bites the
 * throwaway create-then-immediately-ingest test pattern. Returns the id (so it can wrap a return).
 */
export async function settleOwner(id) {
  const client = await db();
  for (let i = 0; i < 15; i++) {
    const g = await client.auth.admin.getUserById(id);
    if (!g.error && g.data?.user?.id === id) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return id;
}

/**
 * Pre-flight: ABORT (exit 1) if the DB already has throwaway residue from a prior leaked
 * run. We never run a real-data eval over a polluted catalog — the result would be a false
 * green. Returns the clean count on success.
 */
export async function assertCleanBefore(evalName) {
  const r = await countResidue();
  if (r.total > 0) {
    banner(evalName, r, "PRE-FLIGHT");
    process.exit(1);
  }
  console.log(`✓ residue-guard PRE-FLIGHT clean (${evalName}): 0 throwaway owners, 0 orphan rows.`);
  return r;
}

/**
 * Post-run: FAIL (exit 1) if THIS run leaked — its cleanup left throwaway residue behind.
 * Surfaces a leak immediately instead of letting it silently corrupt the next run.
 */
export async function assertCleanAfter(evalName) {
  const r = await countResidue();
  if (r.total > 0) {
    banner(evalName, r, "POST-RUN");
    process.exit(1);
  }
  console.log(`✓ residue-guard POST-RUN clean (${evalName}): the run left 0 residue.`);
  return r;
}

/**
 * Purge ALL throwaway residue — delete every @nucleus-eval.invalid owner and its rows.
 * Used by the --purge CLI to recover after a known-leaked run (the verifier's manual
 * cleanup, now reproducible). NEVER touches a real account or a NULL-owner shared row.
 */
export async function purgeResidue() {
  const client = await db();
  const ownerIds = [...(await listThrowawayOwnerIds(client))];
  let dc = 0;
  let ur = 0;
  let users = 0;
  for (const id of ownerIds) {
    const d1 = await client.from("doc_chunks").delete({ count: "exact" }).eq("owner_id", id);
    if (!d1.error) dc += d1.count ?? 0;
    const d2 = await client.from("uploaded_rows").delete({ count: "exact" }).eq("owner_id", id);
    if (!d2.error) ur += d2.count ?? 0;
    await client.auth.admin.deleteUser(id).catch(() => {});
    // Authoritative: is the user gone now?
    const chk = await client.auth.admin.getUserById(id);
    if ((chk.error && /not found/i.test(chk.error.message)) || !chk.data?.user) users++;
  }
  return { users, docChunks: dc, uploadedRows: ur, ownerIds };
}

// CLI: `node tests/evals/_residue-guard.mjs` prints the residue count;
//      `node tests/evals/_residue-guard.mjs --purge` deletes all throwaway residue.
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const WANT = new Set(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  for (const rel of [".env.local", ".secrets/supabase.env", ".vercel-prod.env"]) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      if (!WANT.has(k)) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
    }
  }
  if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (process.argv.includes("--purge")) {
    const r = await purgeResidue();
    console.log(`PURGED throwaway residue: ${r.users} owners, ${r.docChunks} doc_chunks rows, ${r.uploadedRows} uploaded_rows rows.`);
    const after = await countResidue();
    console.log(after.total === 0 ? "✓ DB is now residue-clean." : `🟥 residue remains: ${after.total}`);
    process.exit(after.total === 0 ? 0 : 1);
  } else {
    const r = await countResidue();
    console.log(`THROWAWAY RESIDUE: ${r.users} owners, ${r.docChunks} orphan doc_chunks, ${r.uploadedRows} orphan uploaded_rows (total ${r.total}).`);
    if (r.ownerIds.length) console.log(`  owner ids: ${r.ownerIds.map((x) => x.slice(0, 8)).join(", ")}`);
    console.log(r.total === 0 ? "✓ residue-clean." : "🟥 dirty — run with --purge to clean.");
    process.exit(0);
  }
}
