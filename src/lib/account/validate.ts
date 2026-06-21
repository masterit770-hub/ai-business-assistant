// Pure validation for the per-user Account page. Kept in its own module (no React,
// no Supabase) so it is the SAME code path the account-panel runs AND unit tests
// exercise directly — a test green here means the live form gates the same way.

// Supabase Auth requires a password of at least 6 characters by default. We match
// that floor so the client-side check rejects before the network round-trip
// (the server still enforces it as the real boundary).
export const MIN_PASSWORD_LENGTH = 6;

export type PasswordValidation = { ok: true } | { ok: false; error: string };

// Validate a new-password + confirmation pair. Order matters: empty → too-short →
// mismatch, so the user sees the most actionable message first.
export function validatePassword(password: string, confirm: string): PasswordValidation {
  if (!password || !confirm) {
    return { ok: false, error: "Enter and confirm your new password." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password !== confirm) {
    return { ok: false, error: "The two passwords don’t match." };
  }
  return { ok: true };
}

export const MAX_DISPLAY_NAME_LENGTH = 80;

export type DisplayNameValidation = { ok: true; value: string } | { ok: false; error: string };

// Validate a display name. Trimmed; must be non-empty after trim and within a sane
// length. Returns the trimmed value so the caller saves exactly what was validated.
export function validateDisplayName(name: string): DisplayNameValidation {
  const value = name.trim();
  if (!value) {
    return { ok: false, error: "Enter a display name." };
  }
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, value };
}

// The label shown for a user across the app: their saved display name if set,
// otherwise their email, otherwise a neutral placeholder. Single source of truth so
// the user menu and the account page agree.
export function resolveDisplayLabel(
  displayName: string | null | undefined,
  email: string | null | undefined
): string {
  const name = displayName?.trim();
  if (name) return name;
  if (email) return email;
  return "Not signed in";
}
