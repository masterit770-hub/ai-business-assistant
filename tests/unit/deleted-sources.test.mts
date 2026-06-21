import { test } from "node:test";
import assert from "node:assert/strict";
import { vectorSearch, getVectors } from "../../src/lib/engine/retrieval.ts";
import { introspectSchema, resetStore } from "../../src/lib/engine/structured-store.ts";
import { bundledSources } from "../../src/lib/engine/bundled-sources.ts";
import {
  setDeletedSnapshotForTest,
  deletedSourceIds,
  isSourceDeleted,
} from "../../src/lib/engine/deleted-sources.ts";

// Workspace-level soft-delete of BUNDLED data. These drive the REAL retrieval code
// paths (vectorSearch over the bundled index, introspectSchema over the bundled
// SQLite, bundledSources over both) and prove that a source recorded in the
// deleted-set is EXCLUDED everywhere — so a deleted bundled doc/table can never appear
// in an answer — while an empty set is byte-for-byte the prior behavior.

function clearDeleted() {
  setDeletedSnapshotForTest([]);
  resetStore();
}

test("baseline: nothing deleted → both bundled docs are retrievable + both lanes full", () => {
  clearDeleted();
  // Use a real indexed embedding as the query so vectorSearch runs its real cosine path.
  const idx = getVectors();
  const familyRec = idx.records.find((r) => r.doc === "family-court")!;
  const hits = vectorSearch(familyRec.embedding, 19);
  const docsHit = new Set(hits.map((h) => h.doc));
  assert.ok(docsHit.has("family-court"), "family-court retrievable when nothing is hidden");
  assert.ok(docsHit.has("carter-story"), "carter-story retrievable when nothing is hidden");

  const catalog = introspectSchema().catalog;
  assert.ok(catalog.some((t) => t.table === "contracts"), "bundled table present in catalog");

  const sources = bundledSources();
  assert.ok(sources.some((s) => s.doc === "family-court"));
  assert.ok(sources.some((s) => s.doc === "contracts"));
});

test("a deleted bundled DOC is excluded from vectorSearch (never appears in an answer)", () => {
  clearDeleted();
  setDeletedSnapshotForTest(["family-court"]);
  assert.equal(isSourceDeleted("family-court"), true);

  const idx = getVectors();
  const familyRec = idx.records.find((r) => r.doc === "family-court")!;
  // Even querying with the family-court chunk's OWN embedding, it must not come back.
  const hits = vectorSearch(familyRec.embedding, 19);
  assert.ok(
    hits.every((h) => h.doc !== "family-court"),
    "the hidden doc is filtered out of retrieval entirely"
  );
  // The other bundled doc is unaffected.
  assert.ok(hits.some((h) => h.doc === "carter-story"), "non-hidden bundled doc still retrievable");
  clearDeleted();
});

test("a deleted bundled TABLE is dropped from the text-to-SQL catalog", () => {
  clearDeleted();
  let catalog = introspectSchema().catalog;
  assert.ok(catalog.some((t) => t.table === "contracts"), "contracts present before deletion");

  setDeletedSnapshotForTest(["contracts"]);
  resetStore();
  catalog = introspectSchema().catalog;
  assert.ok(
    !catalog.some((t) => t.table === "contracts"),
    "the hidden bundled table is absent from the catalog the planner + guard use"
  );
  // A sibling table is still queryable.
  assert.ok(catalog.some((t) => t.table === "maintenance"), "non-hidden bundled table still present");
  clearDeleted();
});

test("bundledSources (the dashboard list) omits any hidden doc OR table", () => {
  clearDeleted();
  setDeletedSnapshotForTest(["carter-story", "maintenance"]);
  resetStore();
  const sources = bundledSources();
  assert.ok(!sources.some((s) => s.doc === "carter-story"), "hidden doc omitted from the list");
  assert.ok(!sources.some((s) => s.doc === "maintenance"), "hidden table omitted from the list");
  // Non-hidden sources remain.
  assert.ok(sources.some((s) => s.doc === "family-court"));
  assert.ok(sources.some((s) => s.doc === "contracts"));
  clearDeleted();
});

test("the deleted-set snapshot reflects exactly what was recorded", () => {
  clearDeleted();
  assert.equal(deletedSourceIds().size, 0);
  setDeletedSnapshotForTest(["family-court", "contracts"]);
  assert.deepEqual([...deletedSourceIds()].sort(), ["contracts", "family-court"]);
  clearDeleted();
  assert.equal(deletedSourceIds().size, 0);
});
