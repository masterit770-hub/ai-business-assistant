// TOPOLOGY B (self-host): the Nucleus engine running ON the box talks DIRECTLY to
// localhost Ollama (no tunnel), in Local mode, and produces a cited answer. Run with
// NO Supabase env → settings are in-process (isolated; does NOT touch prod settings).
// Proves the self-host data path the doc describes. Uses the warm qwen2.5:1.5b.
import { setSetting } from "../src/lib/engine/settings.ts";
import { answerQuestion } from "../src/lib/engine/answer.ts";

await setSetting("model_mode", "local");
await setSetting("local_endpoint", "http://localhost:11434/v1");
await setSetting("local_model", "qwen2.5:1.5b");

const questions = [
  "What does the case file say about child support for the Carter case?",
  "How many contracts are expiring in the next 90 days?",
];
for (const q of questions) {
  const r = await answerQuestion(q, { role: "admin" });
  const a = r.answer ?? "";
  console.log("\n================================================================");
  console.log("Q:", q);
  console.log("mode=" + r.mode + " | retrieval=" + (r.inspector?.retrievalMethod ?? "?"));
  console.log("ANSWER:", a.slice(0, 300).replace(/\n/g, " "));
  console.log("CITES:", [...a.matchAll(/\[[SP]:[^\]]+\]/g)].map((m) => m[0]).join(" ") || "(none)");
  console.log("reached-localhost-Ollama (not 'couldn't reach'):", !/couldn't reach|isn't set up/i.test(a));
}
console.log("\n[self-host local data-path test complete]");
