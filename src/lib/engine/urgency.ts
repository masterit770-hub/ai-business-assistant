// Urgency classification — on upload, a document is classified high/medium/low by
// a REAL LLM call using the admin-editable urgency prompt, so the dashboard badge
// reflects the document's actual content (not a mock). The classification is
// stored on the document row and surfaced via the docs listing.
import { chat } from "./llm.ts";
import { getSetting } from "./settings.ts";

export type Urgency = "high" | "medium" | "low";

const VALID = new Set<Urgency>(["high", "medium", "low"]);

/**
 * Classify a document's urgency from a representative text sample. Uses the
 * admin-editable urgency prompt (Prompt-config panel), so editing that prompt
 * changes how documents are prioritized. Defaults to "medium" if the model
 * returns something unparseable (never throws — a bad classification must not
 * block an upload).
 */
export async function classifyUrgency(sampleText: string, today: string): Promise<Urgency> {
  const prompt = await getSetting("urgency_prompt");
  const sample = sampleText.slice(0, 4000); // enough signal; keeps the call cheap
  try {
    const raw = await chat(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: `Today is ${today}. Classify this document's urgency. Reply with ONLY one word — high, medium, or low.\n\nDOCUMENT:\n${sample}`,
        },
      ],
      { temperature: 0 }
    );
    const word = raw.trim().toLowerCase().match(/high|medium|low/)?.[0] as Urgency | undefined;
    return word && VALID.has(word) ? word : "medium";
  } catch {
    return "medium";
  }
}
