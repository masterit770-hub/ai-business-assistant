// Pure save-feedback interpreter for the prompt/settings Save buttons.
//
// THE BUG THIS GUARDS (client-reported: "changing the prompt doesn't get saved"):
// the Answer Setup strip's save handler used to `await fetch(...)` and then show
// "Saved" UNCONDITIONALLY inside a try, swallowing every failure in an empty
// `catch{}`. A 4xx/5xx response (the fetch RESOLVES — it does not throw) sailed
// straight past, so a prompt the server never stored looked saved. The user edited,
// saw "Saved", reloaded, and the old value was back — exactly the report.
//
// The fix is to treat a save response HONESTLY: success is ONLY a 2xx response.
// A non-2xx response (with the route's `{ error }` body when present) and a thrown
// network error are BOTH failures that must surface a real error and must NOT show
// "Saved". This module is the single, pure, unit-tested decision both the inline
// Answer Setup strip and the Settings → Prompts panel route their save result
// through, so neither can drift back into the silent-success behaviour.
//
// Pure + dependency-free (no React, no fetch) so the unit test pins the contract
// without a DOM: it is the SAME function the live Save buttons call.

export type SaveOutcome =
  | { ok: true }
  | { ok: false; error: string };

// A minimal structural view of a fetch Response — just the fields we read. We accept
// any object shaped like this so the test can pass a plain stub and the component can
// pass a real Response.
export type SaveResponseLike = {
  ok: boolean;
  status?: number;
  // The parsed JSON body, if the caller already read it (the route returns
  // `{ error }` on failure, the effective settings on success). Optional: when the
  // body could not be parsed we fall back to a generic message.
  body?: unknown;
};

// The generic fallback shown when the server rejected the save but gave no usable
// error message (a non-JSON body, an empty body, an opaque proxy error).
export const GENERIC_SAVE_ERROR = "Couldn't save — please try again.";

// Pull a human error string out of a route error body (`{ error: "..." }`) when one
// is present; otherwise the generic fallback. Never returns an empty string.
function errorFromBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string" && e.trim()) return e.trim();
  }
  return GENERIC_SAVE_ERROR;
}

// Interpret a settings-save RESPONSE (the fetch resolved). Success ONLY when the
// response is 2xx (`ok === true`); a non-ok response is a failure carrying the
// route's error message when available. This is the line the silent-failure bug
// crossed — a non-ok response must NEVER be reported as saved.
export function interpretSaveResponse(res: SaveResponseLike): SaveOutcome {
  if (res.ok) return { ok: true };
  return { ok: false, error: errorFromBody(res.body) };
}

// Interpret a thrown error from the save attempt (the fetch itself REJECTED — a
// network failure, a CORS/abort, an offline browser). ALWAYS a failure; never a
// fake success — so the return type is the failure shape directly (`.error` is always
// present). Surfaces the error message when it's a real one, else the generic.
export function interpretSaveThrow(err: unknown): { ok: false; error: string } {
  if (err instanceof Error && err.message.trim()) {
    return { ok: false, error: err.message.trim() };
  }
  return { ok: false, error: GENERIC_SAVE_ERROR };
}
