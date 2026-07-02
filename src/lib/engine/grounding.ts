// GROUNDING DERIVATION — the pure core of the Messages-API engine's evidence/citations panel.
//
// Given the model's final answer text, the files that were prepared for the turn, and whether the
// server-side file tools actually ran, this decides:
//   - the display answer (the mandatory trailing "SOURCES_USED:" contract line stripped off),
//   - which files count as EVIDENCE (drive the citations panel), and
//   - whether the answer is GROUNDED at all.
//
// Priority of evidence (strongest first):
//   1. Explicit [P:doc#page] citation tokens in the answer text (the model pointed at a passage).
//   2. The agent's own "SOURCES_USED: <files>" declaration (exact filename or basename match).
//   3. A FLOOR backstop for a weak model that SKIPPED the SOURCES_USED line entirely — mark every
//      attached file as evidence when a substantive answer came back over readable files.
//
// The floor exists ONLY to cover a *missing* declaration. An explicit "SOURCES_USED: NONE" is a
// deliberate statement that no files were used (e.g. a general-knowledge answer) and MUST be
// honored — firing the floor there produced FALSE citations (files the model explicitly did not
// use). Hence `sourcesLine` distinguishes "declared" / "none" / "absent", and the floor may fire
// only when the line is ABSENT. Explicit [P:] tokens still win over a NONE line (rule 1 > rule 2).

import { extractCitationTokens } from "./citations.ts";

/** The subset of a prepared file that grounding needs (name for evidence, isPdf for the floor). */
export type GroundingPreparedFile = { name: string; isPdf: boolean };

export type GroundingInput = {
  /** The model's full final answer text, still including any trailing SOURCES_USED: line. */
  finalAnswer: string;
  /** The files attached to this turn (already fetched + uploaded). */
  preparedFiles: GroundingPreparedFile[];
  /** True if a server-side code-execution / file tool actually ran this turn. */
  usedFileTools: boolean;
};

export type GroundingResult = {
  /** finalAnswer with the trailing SOURCES_USED: contract line stripped. */
  displayAnswer: string;
  /** File names the agent listed after SOURCES_USED: (empty for NONE / absent). */
  declaredSources: string[];
  /** The files that count as evidence for the citations panel. */
  evidenceSourceNames: Set<string>;
  /** Whether the answer is grounded in at least one file. */
  grounded: boolean;
  /** Every [P:...]/[S:...] citation token found in the answer. */
  citedTokens: string[];
  /** How the model's SOURCES_USED contract line resolved. */
  sourcesLine: "declared" | "none" | "absent";
};

// The trailing contract line. Anchored to end-of-line (m flag), value may be empty ("SOURCES_USED:"
// with nothing after it reads as a NONE-equivalent — a present-but-blank declaration, not absent).
const SOURCES_LINE_RE = /SOURCES_USED:[ \t]*([^\n]*?)[ \t]*$/im;
// Strip the whole SOURCES_USED line (and any blank lines leading into it) from the shown answer.
const SOURCES_STRIP_RE = /\n*[ \t]*SOURCES_USED:[ \t]*.*$/im;

export function deriveGrounding(input: GroundingInput): GroundingResult {
  const { finalAnswer, preparedFiles, usedFileTools } = input;

  // 1) Parse the agent's SOURCES_USED declaration and classify the line.
  const declaredSources: string[] = [];
  let sourcesLine: "declared" | "none" | "absent";
  const sm = finalAnswer.match(SOURCES_LINE_RE);
  if (!sm) {
    sourcesLine = "absent";
  } else {
    const raw = sm[1].trim();
    if (!raw || /^none$/i.test(raw)) {
      sourcesLine = "none";
    } else {
      sourcesLine = "declared";
      declaredSources.push(...raw.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }

  const displayAnswer = finalAnswer.replace(SOURCES_STRIP_RE, "").trimEnd();

  // 2) Evidence — [P:] tokens (rule 1) then declared filenames (rule 2).
  const citedTokens = extractCitationTokens(finalAnswer);
  const evidenceSourceNames = new Set<string>();
  for (const token of citedTokens) {
    const m = token.match(/^\[P:(.+)#(\d+)\]$/);
    if (m) evidenceSourceNames.add(m[1]);
  }
  for (const declared of declaredSources) {
    const match = preparedFiles.find((f) => f.name === declared || f.name.split("/").pop() === declared);
    if (match) evidenceSourceNames.add(match.name);
  }

  // 3) Floor backstop — ONLY when the SOURCES_USED line is ABSENT (the model SKIPPED it). An
  //    explicit "SOURCES_USED: NONE" is a deliberate "no files used" and must be honored — firing
  //    the floor there produced false citations (F3). [P:] tokens above already win over NONE.
  //    Otherwise: files attached AND a substantive answer came back (covers PDFs read via document
  //    blocks with no code-exec tool use).
  if (
    sourcesLine === "absent" &&
    evidenceSourceNames.size === 0 &&
    preparedFiles.length > 0 &&
    (usedFileTools || preparedFiles.some((f) => f.isPdf)) &&
    displayAnswer.length > 40
  ) {
    for (const f of preparedFiles) evidenceSourceNames.add(f.name);
  }

  const grounded = evidenceSourceNames.size > 0;
  return { displayAnswer, declaredSources, evidenceSourceNames, grounded, citedTokens, sourcesLine };
}
