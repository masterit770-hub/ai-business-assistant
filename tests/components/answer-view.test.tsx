// AnswerView — the grounded-answer renderer (src/components/assistant/answer-view.tsx).
//
// THE BAR (this file): the assistant's answer is MARKDOWN (the Claude models emit it),
// so it must render to REAL markdown elements — headings, lists, tables, bold, inline
// code — NOT as raw "**bold**" / "## heading" / "| a | b |" source text. AND the existing
// behaviour must survive the change: citation tokens still become clickable chips, raw
// HTML in model output is NEVER injected (no XSS), and Hebrew answers keep dir="rtl".
//
// RED-FIRST: before the fix the answer was dropped into a single `whitespace-pre-wrap`
// <div> with only a citation-splitter — so markdown rendered as literal source. These
// element-shape assertions (getByRole("heading"), <table>, <strong>, <code>) FAIL on
// that raw-text render and pass only once a real markdown renderer is wired in.
//
// ISOLATION: AnswerView is presentational; we render it directly with a hand-built
// EngineResult (no console, no fetch). Only answer-helpers' resolveCitation is exercised
// for real (the chip behaviour we must preserve).

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { engineResult } from "./helpers";
import { AnswerView } from "@/components/assistant/answer-view";

describe("AnswerView markdown rendering", () => {
  it("renders a markdown HEADING as a real heading element, not literal '##' text", () => {
    const result = engineResult({
      answer: "## Quarterly summary\n\nThe spend held flat.",
      // a general (non-grounded) answer keeps the test focused on the body markdown
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
    });
    render(<AnswerView result={result} />);

    const answer = screen.getByTestId("answer");
    // A real <h2> (or any heading) with the text — NOT a literal "## Quarterly summary".
    const heading = within(answer).getByRole("heading", { name: /quarterly summary/i });
    expect(heading).toBeInTheDocument();
    // The raw markdown markers must NOT survive as visible text.
    expect(answer.textContent).not.toContain("## Quarterly summary");
  });

  it("renders a markdown BULLET LIST as <ul>/<li>, not literal '- ' lines", () => {
    const result = engineResult({
      answer: "Findings:\n\n- first point\n- second point\n- third point",
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
    });
    render(<AnswerView result={result} />);

    const answer = screen.getByTestId("answer");
    const items = within(answer).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("first point");
    // The literal bullet markers are gone (they're real <li>s now).
    expect(answer.textContent).not.toContain("- first point");
  });

  it("renders a GFM TABLE as a real <table> with header + body cells", () => {
    const result = engineResult({
      answer:
        "Here is the breakdown:\n\n" +
        "| Vendor | Amount |\n" +
        "| --- | --- |\n" +
        "| Acme | 42000 |\n" +
        "| Globex | 13500 |\n",
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
    });
    render(<AnswerView result={result} />);

    const answer = screen.getByTestId("answer");
    const table = within(answer).getByRole("table");
    expect(table).toBeInTheDocument();
    // Header cells (GFM tables → remark-gfm).
    expect(within(table).getByRole("columnheader", { name: /vendor/i })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /amount/i })).toBeInTheDocument();
    // Body cells.
    expect(within(table).getByRole("cell", { name: "Acme" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "42000" })).toBeInTheDocument();
    // The raw pipe-table source must NOT be visible.
    expect(answer.textContent).not.toContain("| Vendor | Amount |");
  });

  it("renders **bold** as <strong> and `code` as <code>, not literal asterisks/backticks", () => {
    const result = engineResult({
      answer: "The **total** is stored in the `maintenance` table.",
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
    });
    const { container } = render(<AnswerView result={result} />);

    const answer = screen.getByTestId("answer");
    const strong = container.querySelector('[data-testid="answer"] strong');
    const code = container.querySelector('[data-testid="answer"] code');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent("total");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("maintenance");
    // The raw markdown markers are gone.
    expect(answer.textContent).not.toContain("**total**");
    expect(answer.textContent).not.toContain("`maintenance`");
  });

  it("STILL turns citation tokens into clickable chips inside markdown prose", async () => {
    // The chip behaviour is load-bearing and must survive the markdown switch: a [S:…#n]
    // token embedded in a markdown sentence still resolves to a clickable chip that
    // reveals its source row.
    const result = engineResult({
      answer: "The total spend is **$42,000** [S:maintenance#3] this quarter.",
      // grounded (default) so the evidence row from engineResult() resolves the token.
    });
    render(<AnswerView result={result} />);

    const chip = screen.getByTestId("citation-chip");
    expect(chip).toHaveTextContent("[S:maintenance#3]");
    // Clicking reveals the cited source row.
    await userEvent.click(chip);
    expect(screen.getByTestId("citation-source")).toBeInTheDocument();
    // And the bold is real markdown, not literal asterisks.
    expect(screen.getByTestId("answer").textContent).not.toContain("**$42,000**");
  });

  it("does NOT inject raw HTML from model output (no XSS surface)", () => {
    // Model-generated markdown may contain an HTML-looking string; with raw HTML disabled
    // (the default for react-markdown — we do NOT enable rehype-raw) it must render as
    // TEXT, never as a live element.
    const result = engineResult({
      answer: 'Be careful: <img src=x onerror="alert(1)"> is just text.',
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
    });
    const { container } = render(<AnswerView result={result} />);
    const answer = screen.getByTestId("answer");
    // No live <img> element was created from the model string.
    expect(container.querySelector('[data-testid="answer"] img')).toBeNull();
    // The literal text is shown instead.
    expect(answer.textContent).toContain("is just text.");
  });

  it("preserves RTL direction for a Hebrew answer", () => {
    const result = engineResult({
      answer: "## סיכום\n\nההוצאה נשארה יציבה.",
      mode: "general",
      grounded: false,
      evidence: { rows: [], chunks: [] },
    });
    render(<AnswerView result={result} />);
    const answer = screen.getByTestId("answer");
    // dir="auto" is the component's contract: the browser derives direction from the
    // first strong character, so a Hebrew answer renders RTL and MIXED Hebrew/English
    // answers each resolve correctly (a hardcoded dir="rtl" would break mixed content;
    // jsdom can't compute resolved direction, so the mechanism is what's assertable).
    expect(answer).toHaveAttribute("dir", "auto");
    // And it's still a real heading, not "## סיכום".
    expect(within(answer).getByRole("heading", { name: /סיכום/ })).toBeInTheDocument();
  });
});
