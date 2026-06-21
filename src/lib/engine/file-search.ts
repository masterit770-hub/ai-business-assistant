// Gemini File Search — the managed RAG backend for the DOCUMENT lane.
//
// Why: it auto-chunks/embeds/persists uploaded files in a store Gemini manages,
// which solves Vercel's read-only/ephemeral-FS upload problem for free (uploaded
// docs survive cold starts + are shared across instances — true persistence the
// in-memory backend lacked).
//
// How it slots into the engine: File Search retrieval is exposed only through
// `generateContent` (there is no retrieve-only endpoint), so we make ONE
// generateContent call with the file_search tool and read back BOTH the answer
// text AND `groundingMetadata.groundingChunks`. We map each grounding chunk to the
// engine's existing [P:<doc>#<page>] citation token so the UI keeps rendering
// chips and the answer stays traceable.
//
// ⚠️ QUOTA: File Search queries run through generateContent, which on the FREE
// tier is capped per-day (GenerateRequestsPerDayPerProjectPerModel-FreeTier).
// That budget is currently exhausted on the demo key → queries 429 intermittently.
// Indexing (upload+import) is NOT gated the same way and works reliably. Production
// needs a paid/quota'd key. This module surfaces a 429 honestly (never a fake
// answer) and retries briefly to catch an open window.
import { GoogleGenAI } from "@google/genai";

const STORE_ENV = "GEMINI_FILE_SEARCH_STORE"; // the persistent store resource name
// File Search queries run on gemini-2.5-flash-lite: its free-tier daily quota is
// SEPARATE from (and higher than) gemini-2.5-flash, so doc queries don't share
// the budget the core DeepSeek path never touches anyway. Override via env.
const MODEL = process.env.GEMINI_FS_MODEL ?? "gemini-2.5-flash-lite";

// The SDK prefers GOOGLE_API_KEY; accept either so .secrets/gemini.env works as-is.
function apiKey(): string | undefined {
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
}

export function fileSearchEnabled(): boolean {
  return Boolean(apiKey());
}

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!fileSearchEnabled()) throw new Error("Gemini API key not configured (GEMINI_API_KEY).");
  if (!_client) _client = new GoogleGenAI({ apiKey: apiKey()! });
  return _client;
}

export class QuotaExhaustedError extends Error {
  constructor(detail: string) {
    super(
      "Gemini File Search quota exhausted (free-tier daily generateContent limit). " +
        "A paid/quota'd Gemini key is required for document queries. Detail: " +
        detail
    );
    this.name = "QuotaExhaustedError";
  }
}

function isQuota(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /429|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(m);
}

// Worth a retry: 429 (rate/quota), 503 (model "high demand" spike), OR a transient
// transport blip to the Gemini endpoint ("terminated"/"fetch failed"/socket resets).
// flash-lite intermittently 503s under load and the upstream fetch occasionally
// drops mid-stream; a brief backoff clears both. (A dropped fetch used to escape the
// retry loop and fail the whole request — including bundled answers that don't even
// need Gemini.)
function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return (
    isQuota(e) ||
    /\b503\b|UNAVAILABLE|high demand|overloaded/i.test(m) ||
    /terminated|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(m)
  );
}

/**
 * The persistent File Search store, created once and reused. The resource name is
 * cached in env (GEMINI_FILE_SEARCH_STORE) so every instance shares ONE store —
 * that's what makes an uploaded doc query-able from any instance / after a cold
 * start. If no store is configured, one is created and its name returned (the
 * caller should persist it to env for true cross-instance sharing).
 */
export async function ensureStore(): Promise<string> {
  const configured = process.env[STORE_ENV];
  if (configured) return configured;
  const store = await client().fileSearchStores.create({
    config: { displayName: "nucleus-documents" },
  });
  if (!store.name) throw new Error("file search store creation returned no name");
  return store.name;
}

const API = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD_API = "https://generativelanguage.googleapis.com/upload/v1beta";

/**
 * Upload + import a file into the store (the durable indexing step). Reliable on
 * the free key. Returns once Gemini has finished chunking/embedding the file.
 *
 * Implemented with the raw REST two-step (Files API raw upload → store importFile
 * → poll) rather than the SDK's path-based helper: the SDK helper reads the file
 * itself and, inside the Next.js server bundle, its internal multipart response
 * comes back empty ("Unexpected end of JSON input"). The plain-fetch path is
 * bundling-safe and verified end-to-end.
 */
export async function uploadToStore(
  buf: Uint8Array,
  displayName: string,
  mimeType = "application/octet-stream",
  ownerId?: string,
  meta?: { docId?: string; label?: string; urgency?: string }
): Promise<{ fileId: string }> {
  const key = apiKey()!;
  const store = await ensureStore();

  // 1. Upload into the Files API via the RESUMABLE protocol so we can set a
  //    display_name — Gemini surfaces that as the grounding chunk `title` at query
  //    time, so the [P:<doc>#page] citation chip shows the doc id instead of the
  //    opaque media id (and durably, with no cross-instance mapping). displayName
  //    here is the doc id derived from the filename by the caller.
  const bytes = buf.slice();
  // 1a. start: declare size/type + display_name, get the resumable upload URL.
  const startRes = await fetch(`${UPLOAD_API}/files?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) throw new Error(`files upload start failed (${startRes.status}): ${(await startRes.text()).slice(0, 200)}`);
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("files upload start returned no resumable URL");
  // 1b. upload + finalize in one request.
  const upRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Length": String(bytes.byteLength),
    },
    body: new Blob([bytes], { type: mimeType }),
  });
  if (!upRes.ok) throw new Error(`files upload failed (${upRes.status}): ${(await upRes.text()).slice(0, 200)}`);
  const upJson = (await upRes.json()) as { file?: { name?: string; state?: string } };
  const fileName = upJson?.file?.name;
  if (!fileName) throw new Error("files upload returned no file name");

  // 2. Import the uploaded file into the File Search store, tagging it with the
  //    owner (so queries can be scoped per-user — custom_metadata is filterable)
  //    AND the doc id / label / urgency (so the dashboard list can be rebuilt
  //    DURABLY from the store, not the per-Lambda in-memory registry).
  const customMeta: { key: string; string_value: string }[] = [];
  if (ownerId) customMeta.push({ key: "owner_id", string_value: ownerId });
  if (meta?.docId) customMeta.push({ key: "doc_id", string_value: meta.docId });
  if (meta?.label) customMeta.push({ key: "label", string_value: meta.label });
  if (meta?.urgency) customMeta.push({ key: "urgency", string_value: meta.urgency });
  const importBody: Record<string, unknown> = { file_name: fileName };
  if (customMeta.length) importBody.custom_metadata = customMeta;
  const impRes = await fetch(`${API}/${store}:importFile?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(importBody),
  });
  if (!impRes.ok) throw new Error(`importFile failed (${impRes.status}): ${(await impRes.text()).slice(0, 200)}`);
  const imp = (await impRes.json()) as { name?: string; done?: boolean; error?: unknown };
  if (imp.error) throw new Error(`indexing failed: ${JSON.stringify(imp.error).slice(0, 200)}`);

  // The grounding chunk's `title` at query time is the Files API id WITHOUT the
  // "files/" prefix (e.g. "ey2dkxujiox4"). Return it so the caller can map that
  // opaque id back to our human doc id for the [P:<doc>#page] citation chip.
  const fileId = fileName.replace(/^files\//, "");

  // 3. Poll the operation until indexing completes (small files finish fast; the
  //    import often returns already-done synchronously).
  if (imp.name && !imp.done) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const st = await fetch(`${API}/${imp.name}?key=${key}`);
      const j = (await st.json().catch(() => ({}))) as { done?: boolean; error?: unknown };
      if (j.error) throw new Error(`indexing failed: ${JSON.stringify(j.error).slice(0, 200)}`);
      if (j.done) break;
    }
  }
  return { fileId };
}

type StoreDocument = {
  name?: string;
  displayName?: string;
  customMetadata?: { key: string; stringValue?: string }[];
};

/** Read EVERY document in the store (paginated, page_size max 20). */
async function listAllStoreDocuments(): Promise<StoreDocument[]> {
  const key = apiKey()!;
  const store = await ensureStore();
  const all: StoreDocument[] = [];
  let pageToken = "";
  for (let page = 0; page < 50; page++) {
    const url =
      `${API}/${store}/documents?key=${key}&page_size=20` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`list documents failed (${res.status})`);
    const j = (await res.json()) as { documents?: StoreDocument[]; nextPageToken?: string };
    all.push(...(j.documents ?? []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return all;
}

export type StoreDocMeta = { doc: string; label: string; urgency: string | null };

/**
 * The dashboard's uploaded-document list, rebuilt DURABLY from the File Search
 * store's custom_metadata (doc_id / label / urgency / owner_id) — NOT the
 * per-Lambda in-memory registry, so it survives cold starts and is consistent
 * across instances. Owner-scoped: a user sees their own docs (+ shared/untagged);
 * an admin (no ownerId) sees all. Deduped by doc_id (a re-upload makes >1 store
 * document share a doc_id).
 */
export async function listStoreDocuments(ownerId?: string): Promise<StoreDocMeta[]> {
  const docs = await listAllStoreDocuments();
  const byDoc = new Map<string, StoreDocMeta>();
  for (const d of docs) {
    const m = new Map((d.customMetadata ?? []).map((x) => [x.key, x.stringValue ?? ""]));
    const docId = m.get("doc_id");
    if (!docId) continue; // only docs we tagged (skip stray/legacy uploads)
    const owner = m.get("owner_id");
    // Owner scope: own docs + shared (no owner). Admin (no ownerId) sees all.
    if (ownerId && owner && owner !== ownerId) continue;
    if (!byDoc.has(docId)) {
      byDoc.set(docId, { doc: docId, label: m.get("label") || docId, urgency: m.get("urgency") || null });
    }
  }
  return [...byDoc.values()];
}

/**
 * Delete an uploaded document from the File Search store by its Gemini FILE ID
 * (the store document's displayName is the file id). We list the store's
 * documents (page_size max 20 — paginate) and DELETE every one whose displayName
 * matches (force=true — the doc has chunks). Returns the count removed.
 * Indexing-side API → not query-quota gated.
 */
export async function deleteDocumentByFileId(fileId: string): Promise<number> {
  const docs = await listAllStoreDocuments();
  return deleteStoreDocs(docs.filter((d) => d.displayName === fileId));
}

/**
 * Delete a document by OUR doc id, looked up via its doc_id custom_metadata.
 * Durable across instances (doesn't rely on the in-memory file-id map), so the
 * dashboard delete works even on a cold Lambda.
 */
export async function deleteDocumentByDocId(docId: string): Promise<number> {
  const docs = await listAllStoreDocuments();
  return deleteStoreDocs(
    docs.filter((d) =>
      (d.customMetadata ?? []).some((m) => m.key === "doc_id" && m.stringValue === docId)
    )
  );
}

async function deleteStoreDocs(matches: StoreDocument[]): Promise<number> {
  const key = apiKey()!;
  let deleted = 0;
  for (const d of matches) {
    if (!d.name) continue;
    const del = await fetch(`${API}/${d.name}?force=true&key=${key}`, { method: "DELETE" });
    if (del.ok) deleted++;
  }
  return deleted;
}

// Map a Gemini file id (the grounding `title`) → our human doc id. Set at upload
// time, read at query time so citations show [P:<doc>#page] not the opaque id.
const g2 = globalThis as unknown as { __fsTitleMap?: Record<string, string> };
export function registerTitleMapping(fileId: string, docId: string): void {
  if (!g2.__fsTitleMap) g2.__fsTitleMap = {};
  g2.__fsTitleMap[fileId] = docId;
}
function resolveDocId(title: string | undefined): string {
  if (!title) return "document";
  return g2.__fsTitleMap?.[title] ?? docIdFromTitle(title);
}

export type FileSearchChunk = { doc: string; page: number; text: string };
export type FileSearchResult = { answer: string; chunks: FileSearchChunk[] };

// Turn a grounding chunk's source title into a stable [P:<doc>#page] doc id.
function docIdFromTitle(title: string | undefined): string {
  if (!title) return "document";
  return (
    title
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "document"
  );
}

/**
 * Query the document lane via File Search. Returns Gemini's grounded answer plus
 * the retrieved chunks mapped to the engine's citation shape (doc + page + text).
 * Retries a 429 a few times (the free-tier daily window opens intermittently);
 * throws QuotaExhaustedError if it stays exhausted, so the caller can surface an
 * honest error instead of an empty/fake answer.
 */
export async function queryFileSearch(
  question: string,
  ownerId?: string
): Promise<FileSearchResult> {
  const store = await ensureStore();
  const ai = client();
  // Per-user isolation: scope File Search retrieval to the caller's OWN uploads.
  // Every uploaded doc is tagged with its uploader's owner_id (see uploadToStore),
  // so `owner_id = "<caller>"` returns exactly that user's docs and NEVER another
  // user's. The SHARED corpus (the bundled Carter index) is in the LOCAL store, not
  // File Search, so it's included for everyone separately (see answer.ts) — it is
  // not affected by this filter. When ownerId is absent (admin, or an unscoped
  // direct call) no filter is applied → all uploaded docs are visible.
  const fileSearch: Record<string, unknown> = { fileSearchStoreNames: [store] };
  if (ownerId) {
    fileSearch.metadataFilter = `owner_id = "${ownerId}"`;
  }
  let lastErr = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: question,
        config: { tools: [{ fileSearch }] },
      });
      const answer = resp.text ?? "";
      const gm = resp.candidates?.[0]?.groundingMetadata;
      const chunks: FileSearchChunk[] = (gm?.groundingChunks ?? [])
        .map((c) => {
          const rc = c.retrievedContext;
          if (!rc) return null;
          return {
            doc: resolveDocId(rc.title ?? undefined),
            page: typeof rc.pageNumber === "number" ? rc.pageNumber : 1,
            text: rc.text ?? "",
          };
        })
        .filter((c): c is FileSearchChunk => c !== null);
      return { answer, chunks };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (!isTransient(e)) throw e;
      // Brief backoff to ride out a 429/503 spike (flash-lite clears in a few tries).
      if (attempt < 6) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  // Stayed transient through every retry. If it was a quota wall, surface the honest
  // "needs a paid key" message; a pure transport failure gets its own error so the
  // caller (and any user-facing message) isn't told "quota" for a network drop.
  if (isQuota(new Error(lastErr))) throw new QuotaExhaustedError(lastErr.slice(0, 160));
  throw new Error(`File Search unavailable (transient transport failure): ${lastErr.slice(0, 160)}`);
}
