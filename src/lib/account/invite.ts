// Pure helpers for the admin "invite a new teammate" flow. No React, no Supabase —
// so the same code path the API uses is exercised directly by unit tests.
//
// Onboarding a real teammate needs TWO things the admin can hand off:
//   1. an invite LINK the teammate clicks to set their own password, and
//   2. a temp PASSWORD fallback they can sign in with if the link can't be used
//      (SMTP off, link expired, copy/paste mangled, etc.).
// These helpers compute the request origin a link should point back to, and shape
// the credentials block the UI renders. The actual link is minted server-side by
// Supabase admin `generateLink` (service role) — that part can't be pure.

// Derive the app's own origin from an incoming request, so an invite/recovery link
// redirects back to THIS deployment (prod, a preview, or localhost) — no env needed.
// Order: an explicit configured site URL → the request's forwarded host → the
// request URL's own origin. Returns null only if nothing usable is present.
export function resolveAppOrigin(req: {
  url: string;
  headers: { get(name: string): string | null };
}): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return stripTrailingSlash(explicit);

  // Behind Vercel's proxy the original host/proto live in x-forwarded-* headers.
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto") ||
      (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return stripTrailingSlash(`${proto}://${host}`);
  }

  try {
    return stripTrailingSlash(new URL(req.url).origin);
  } catch {
    return null;
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// Where an invite/recovery link should land the new teammate. We point at the
// sign-in page (the app has no standalone reset page); the recovery token in the
// link establishes their session, and they set a password from the account area.
export function inviteRedirectUrl(origin: string | null): string | undefined {
  if (!origin) return undefined;
  return `${stripTrailingSlash(origin)}/sign-in`;
}

export type InviteResult = {
  email: string;
  // The clickable link the teammate uses to get in and set their own password.
  // Null when generateLink wasn't available/usable — the UI then leans on password.
  inviteLink: string | null;
  // Always present: the temp password the admin set, as the guaranteed fallback.
  tempPassword: string;
};

// Shape the credentials block returned to the admin after a create. Never throws,
// never logs — the caller renders this verbatim in a copyable card.
export function buildInviteResult(args: {
  email: string;
  inviteLink: string | null;
  tempPassword: string;
}): InviteResult {
  return {
    email: args.email.trim(),
    inviteLink: args.inviteLink && args.inviteLink.length > 0 ? args.inviteLink : null,
    tempPassword: args.tempPassword,
  };
}
