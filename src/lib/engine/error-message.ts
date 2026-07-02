// Map a raw engine/provider failure into a clean, actionable line for the end user.
// The real detail (status + provider blob) is kept server-side (logged in the route);
// this is purely what we SHOW. Pure + dependency-free so it can be unit-tested.
//
// chatCloud()/chatHipaa() throw an Error whose message is `"<provider> (<model>) <status>:
// <body>"` (see llm.ts) for non-auth failures, OR a TYPED error with a stable `code` for
// the two "the model could not RUN" cases the client cares about:
//   • CLOUD_PROVIDER_NOT_CONFIGURED — a cloud provider is selected but has NO saved key
//   • CLOUD_PROVIDER_AUTH           — the saved key was REJECTED (a 401/403)
// Both MUST surface a clear, actionable "set/fix your model key in Settings → Models"
// line and produce NO answer — never a silent degrade to a generic 'general' reply. We
// classify on the typed code FIRST (robust to message wording), then on the string for
// the older blob-shaped errors. We NEVER dump the raw provider body.

const RATE_LIMIT_RE =
  /\b(429|rate.?limit|exhausted|quota|resource[_ ]?exhausted|too many requests|insufficient.?quota|overloaded|credit balance|usage limit|monthly|billing)/i;
const AUTH_RE =
  /\b(401|403|invalid.?api.?key|invalid key|unauthorized|permission denied|api key not valid|invalid.?x.?api.?key)\b/i;
const TIMEOUT_RE = /\b(timed? ?out|timeout|etimedout|deadline|aborted|abort)\b/i;

// The clear, actionable line for a model that could not RUN because its key is missing
// or not working. This is the message the client required: it names the fix location and
// makes plain that NO answer was produced (so a failed model can never look like a real
// answer). `provider` names the selected backend when known.
function keyMessage(provider?: string): string {
  const who = provider && provider !== "the selected" ? `the "${provider}" ` : "your AI ";
  return `${who}model key isn't set or isn't working — set or fix it in Settings → Models. No answer was generated.`;
}

export function friendlyAskError(raw: unknown): string {
  const code = raw instanceof Error ? (raw as { code?: string }).code : undefined;
  const provider = raw instanceof Error ? (raw as { provider?: string }).provider : undefined;
  // TYPED model-run failures FIRST (most specific, message-independent).
  if (code === "CLOUD_PROVIDER_NOT_CONFIGURED" || code === "CLOUD_PROVIDER_AUTH") {
    return keyMessage(provider);
  }
  const msg = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  if (RATE_LIMIT_RE.test(msg)) {
    return "The Claude API key has reached its usage limit — please try again later.";
  }
  if (AUTH_RE.test(msg)) {
    // A blob-shaped 401/403 from an untyped path → the same clear key guidance.
    return keyMessage(provider);
  }
  if (TIMEOUT_RE.test(msg)) {
    return "That took too long — try again.";
  }
  return "Something went wrong generating the answer — try again.";
}
