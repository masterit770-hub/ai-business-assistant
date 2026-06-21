// Show EXACTLY what happens on a weak (1.5b) local model: did the router route to
// RAG + did retrieval find the docs, but the generator failed to cite? Dumps the
// router decision, retrieved-doc count, mode, the inspector's citation-check line,
// and whether the retrieved docs are still preserved. In-memory settings (no prod).
import { setSetting } from "../src/lib/engine/settings.ts";
import { answerQuestion } from "../src/lib/engine/answer.ts";

await setSetting("model_mode", "local");
await setSetting("local_endpoint", "http://localhost:11434/v1");
await setSetting("local_model", "qwen2.5:1.5b");

const r = await answerQuestion("What does the case file say about child support for the Carter case?", { role: "admin" });
const a = r.answer ?? "";
console.log("ROUTER picked sources:", JSON.stringify(r.route?.sources));
console.log("RETRIEVAL method:", r.inspector?.retrievalMethod);
console.log("DOCS retrieved (preserved):", (r.evidence?.chunks?.length ?? 0), "chunks from", JSON.stringify([...new Set((r.evidence?.chunks ?? []).map((c) => c.doc))]));
console.log("ANSWER mode:", r.mode, "| grounded:", r.grounded);
console.log("CITATIONS in answer:", [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)");
console.log("VALIDATION:", JSON.stringify(r.validation));
// The inspector's Safety / Citation-check step (what the UI shows):
const steps = r.inspector?.steps ?? r.inspector?.trace ?? [];
const cc = (Array.isArray(steps) ? steps : []).filter((s) => JSON.stringify(s).match(/citation|safety|general/i));
console.log("CITATION-CHECK step(s):", JSON.stringify(cc).slice(0, 400));
console.log("\nANSWER text:", a.slice(0, 220).replace(/\n/g, " "));
