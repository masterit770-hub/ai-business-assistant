// CSV → SQLite loader. Builds the bundled read-only structured store.
// Malformed cells (`error: undefined method ...`) are loaded as NULL with a
// per-row `__malformed` flag + a quarantine count — never crash, never silently
// drop. See docs/architecture.md and docs/features/shared-engine/reference.md.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "./csv.ts";
import { TABLES, isMalformedCell, toISODate, type TableSpec } from "./schema.ts";

export type LoadReport = { table: string; rows: number; malformedCells: number };

function createTable(db: Database.Database, spec: TableSpec) {
  const cols = spec.columns.map((c) => `${c.col} ${c.type}`).join(", ");
  const dateCols = (spec.dateColumns ?? []).map((c) => `${c}_iso TEXT`).join(", ");
  db.exec(
    `CREATE TABLE ${spec.table} (
       id INTEGER PRIMARY KEY,
       ${cols}${dateCols ? ", " + dateCols : ""},
       __malformed INTEGER NOT NULL DEFAULT 0
     )`
  );
}

function loadTable(db: Database.Database, spec: TableSpec, dataDir: string): LoadReport {
  const raw = readFileSync(join(dataDir, spec.csv), "utf8");
  const records = parseCsv(raw);
  const dateCols = spec.dateColumns ?? [];
  const colNames = [
    "id",
    ...spec.columns.map((c) => c.col),
    ...dateCols.map((c) => `${c}_iso`),
    "__malformed",
  ];
  const placeholders = colNames.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO ${spec.table} (${colNames.join(", ")}) VALUES (${placeholders})`
  );

  let malformedCells = 0;
  let id = 0;
  const tx = db.transaction(() => {
    for (const rec of records) {
      id++;
      let rowMalformed = 0;
      const values: (string | number | null)[] = [id];
      for (const c of spec.columns) {
        const v = rec[c.csv] ?? "";
        if (isMalformedCell(v)) {
          malformedCells++;
          rowMalformed = 1;
          values.push(null);
          continue;
        }
        if (c.type === "REAL") {
          const n = parseFloat(v);
          values.push(Number.isFinite(n) ? n : null);
        } else if (c.type === "INTEGER") {
          const n = parseInt(v, 10);
          values.push(Number.isInteger(n) ? n : null);
        } else {
          values.push(v === "" ? null : v);
        }
      }
      for (const dc of dateCols) {
        const src = rec[spec.columns.find((c) => c.col === dc)?.csv ?? ""] ?? "";
        values.push(isMalformedCell(src) ? null : toISODate(src));
      }
      values.push(rowMalformed);
      insert.run(...values);
    }
  });
  tx();
  return { table: spec.table, rows: records.length, malformedCells };
}

/** Build the full DB in-memory or to a file. Returns the db + a load report. */
export function buildDatabase(dataDir: string, filePath?: string) {
  const db = new Database(filePath ?? ":memory:");
  // DELETE journal (not WAL) so the built .sqlite is a single self-contained file
  // with no -wal/-shm sidecars — it copies/bundles cleanly to serverless.
  db.pragma("journal_mode = DELETE");
  const report: LoadReport[] = [];
  for (const spec of TABLES) {
    createTable(db, spec);
    report.push(loadTable(db, spec, dataDir));
  }
  // A meta table so the running app can surface data-quality honestly.
  db.exec(`CREATE TABLE _load_report (table_name TEXT, rows INTEGER, malformed_cells INTEGER)`);
  const ins = db.prepare(`INSERT INTO _load_report VALUES (?, ?, ?)`);
  for (const r of report) ins.run(r.table, r.rows, r.malformedCells);
  return { db, report };
}

export { TABLES };
