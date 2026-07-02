// Run a STRUCTURED (SQL) question on the weak 1.5b local model and show the full
// chain + the derived confidence score. In-memory settings (no prod). Localhost Ollama.
import { setSetting } from "../src/lib/engine/settings.ts";
import { answerQuestion } from "../src/lib/engine/answer.ts";

await setSetting("model_mode", "local");
await setSetting("local_endpoint", "http://localhost:11434/v1");
await setSetting("local_model", "qwen2.5:1.5b");

const q = "How many contracts are expiring in the next 90 days, and what is their total annual cost?";
const r = await answerQuestion(q, { role: "admin" });
const a = r.answer ?? "";
const blob = JSON.stringify(r);
const sql = [...blob.matchAll(/SELECT[^"\\]*?(?=["\\])/gi)].map((m) => m[0].replace(/\s+/g, " ").trim());
console.log("Q:", q);
console.log("ROUTER sources:", JSON.stringify(r.route?.sources));
console.log("GENERATED SQL:", [...new Set(sql)].join(" | ") || "(none)");
console.log("ROWS retrieved:", r.evidence?.rows?.length ?? 0);
console.log("MODE:", r.mode, "| grounded:", r.grounded);
console.log("CONFIDENCE:", JSON.stringify(r.inspector?.confidence));
console.log("CITES:", [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)");
console.log("ANSWER:", a.slice(0, 260).replace(/\n/g, " "));
