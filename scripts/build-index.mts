// build-index — deterministically rebuilds data-index/ from data/.
//   data-index/contracts.sqlite  : CSV → SQLite (structured store)
//   data-index/vectors.json      : PDF chunks + local multilingual embeddings (RAG store)
// Run by `npm run build:index` (and as the first step of `npm run build`).
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDatabase } from "../src/lib/engine/loader";
import { pdfToChunks } from "../src/lib/engine/pdf";
import { embedPassage } from "../src/lib/engine/embeddings";
import { DOCUMENTS, type VectorIndex } from "../src/lib/engine/documents";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");
const OUT = join(ROOT, "data-index");
const SQLITE = join(OUT, "contracts.sqlite");
const VECTORS = join(OUT, "vectors.json");

async function main() {
  mkdirSync(OUT, { recursive: true });

  // ── 1. CSV → SQLite ────────────────────────────────────────────────────
  if (existsSync(SQLITE)) rmSync(SQLITE);
  console.log("Building SQLite from CSVs...");
  const { db, report } = buildDatabase(DATA, SQLITE);
  db.close();
  for (const r of report) {
    console.log(
      `  ${r.table}: ${r.rows} rows` +
        (r.malformedCells ? `  (${r.malformedCells} malformed cells quarantined)` : "")
    );
  }

  // ── 2. PDFs → chunks → local embeddings → vectors.json ─────────────────
  console.log("Building vector index from PDFs (local embeddings)...");
  const records: VectorIndex["records"] = [];
  let dim = 0;
  for (const d of DOCUMENTS) {
    const chunks = pdfToChunks(join(DATA, d.file), d.doc);
    console.log(`  ${d.doc}: ${chunks.length} chunks`);
    for (const c of chunks) {
      const embedding = await embedPassage(c.text);
      dim = embedding.length;
      records.push({ doc: c.doc, page: c.page, text: c.text, embedding });
    }
  }
  const index: VectorIndex = { model: "Xenova/multilingual-e5-small", dim, records };
  writeFileSync(VECTORS, JSON.stringify(index));
  console.log(`  wrote ${records.length} vectors (dim ${dim}) → data-index/vectors.json`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
