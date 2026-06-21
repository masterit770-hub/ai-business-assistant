// Map a raw engine/provider failure into a clean, actionable line for the end user.
// The real detail (status + provider blob) is kept server-side (logged in the route);
// this is purely what we SHOW. Pure + dependency-free so it can be unit-tested.
//
// chatCloud()/chatHipaa() throw an Error whose message is `"<provider> (<model>) <status>:
// <body>"` (see llm.ts). We classify on that string. Known cases get a specific line;
// everything else gets a calm generic one — we NEVER dump the raw provider body.

const RATE_LIMIT_RE =
  /\b(429|rate.?limit|exhausted|quota|resource[_ ]?exhausted|too many requests|insufficient.?quota)\b/i;
const AUTH_RE =
  /\b(401|403|invalid.?api.?key|invalid key|unauthorized|permission denied|api key not valid|invalid.?x.?api.?key)\b/i;
const TIMEOUT_RE = /\b(timed? ?out|timeout|etimedout|deadline|aborted|abort)\b/i;

export function friendlyAskError(raw: unknown): string {
  const msg = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  if (RATE_LIMIT_RE.test(msg)) {
    return "The AI provider's rate limit was hit — wait a moment and retry.";
  }
  if (AUTH_RE.test(msg)) {
    return "The cloud model key looks invalid — check it in Settings → Model.";
  }
  if (TIMEOUT_RE.test(msg)) {
    return "That took too long — try again.";
  }
  return "Something went wrong generating the answer — try again.";
}
