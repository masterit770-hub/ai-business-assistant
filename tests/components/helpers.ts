// Shared component-test helpers: a route-aware fetch stub + an EngineResult fixture.
//
// The discipline (docs/testing/INDEX.md): mock ONLY the backend/fetch so we test the
// component's own state machine, never the network. `mockFetch` lets each test declare
// the exact response (or failure, or never-resolving Promise) for each route it hits,
// keyed by a substring of the URL — so a test asserts behavior against a KNOWN backend
// outcome (200 with body, 4xx/5xx error, network reject, slow in-flight call).

import { vi } from "vitest";

// A resolved HTTP response. `reject`/`pending` are explicitly `never` here so the
// union below is discriminated — checking `"pending" in r` / `"reject" in r` narrows
// `r` to this resolved shape in the else-branch.
export type HttpResponse = { ok?: boolean; status?: number; json?: unknown; reject?: never; pending?: never };
export type RouteResponse =
  | HttpResponse
  | { reject: Error } // the fetch itself rejects (network failure / offline)
  | { pending: true }; // never resolves — models an in-flight request (spinner state)

type RouteMap = Record<string, RouteResponse | ((url: string, init?: RequestInit) => RouteResponse)>;

// Build a fetch mock that dispatches by URL substring. The FIRST matching key wins, so
// list more specific paths before generic ones. An unmatched URL rejects loudly (the
// same fail-closed contract as the global default) so a missing stub is never a silent
// phantom-200. Returns the vi.fn so a test can assert call counts / bodies.
export function mockFetch(routes: RouteMap) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) {
      throw new Error(`mockFetch: no stub for ${url}`);
    }
    const entry = routes[key];
    const r = typeof entry === "function" ? entry(url, init) : entry;

    if ("pending" in r) {
      // Never resolves — models an in-flight request (spinner state). But honor an
      // AbortSignal the way the real fetch does: reject with an AbortError when the
      // caller aborts, so a Stop/cancel path exercises the component's real catch.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }
      });
    }
    if ("reject" in r) {
      throw r.reject;
    }
    // Here r is the resolved-HTTP-response shape.
    const ok = r.ok ?? true;
    const status = r.status ?? (ok ? 200 : 500);
    const body = r.json ?? {};
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// A minimal but VALID EngineResult, so AssistantConsole's turn rendering has real
// shape to work with. Override any slice per test.
export function engineResult(overrides: Partial<import("@/components/assistant/types").EngineResult> = {}) {
  const base = {
    question: "What is the total maintenance spend?",
    route: { sources: ["structured"], docFilter: null, rationale: "structured lookup" },
    answer: "The total maintenance spend is $42,000 [S:maintenance#3].",
    mode: "grounded" as const,
    grounded: true,
    evidence: {
      rows: [
        {
          table: "maintenance",
          id: 3,
          token: "[S:maintenance#3]",
          data: { vendor: "Acme", amount: 42000 },
        },
      ],
      chunks: [],
    },
    validation: { ok: true, reasons: [] },
    inspector: {
      retrievalMethod: "text-to-SQL",
      passages: 1,
      evidenceCount: 1,
      confidence: { value: 0.9, basis: "single grounded row" },
      steps: [],
      timings: { routingMs: 5, retrievalMs: 10, generationMs: 100, totalMs: 115 },
      cost: {
        liveCalls: 1,
        promptTokens: 100,
        completionTokens: 50,
        usd: 0.001,
        pricingNote: "",
        provider: "deepseek",
        model: "deepseek-chat",
      },
    },
  };
  return { ...base, ...overrides } as import("@/components/assistant/types").EngineResult;
}
