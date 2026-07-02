/**
 * The LIVE production Vercel frontend for Nucleus — the SINGLE SOURCE OF TRUTH for
 * the deployment URL. The middleware's BACKEND_ONLY fallback, and (via the prod-url
 * pin test) every journey/eval harness default + the README, are asserted against
 * this constant so a deployment rename can't leave a harness silently certifying a
 * stale deployment. When the deployment is renamed, change it HERE only.
 */
export const PRODUCTION_FRONTEND_URL = "https://nucleus-770.vercel.app";

/**
 * Pure helper for the BACKEND_ONLY redirect logic (extracted for testability —
 * no Next.js deps, no env side-effects).
 *
 * BACKEND_ONLY MODE (Fly): when backendOnly=true, any path NOT under /api/ is
 * redirected 308 to the Vercel frontend. /api/* passes through.
 *
 * @returns the redirect destination URL, or null to pass through.
 */
export function backendOnlyRedirect(
  path: string,
  backendOnly: boolean,
  frontendUrl: string
): string | null {
  if (!backendOnly) return null;
  if (path.startsWith("/api/")) return null;
  return `${frontendUrl}${path}`;
}
