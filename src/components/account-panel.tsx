"use client";

import { useEffect, useState } from "react";
import { User, KeyRound, Palette, Check, Loader2, AlertCircle, Moon, Sun } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { THEME_KEY, currentBrand, setBrand, type Brand } from "@/components/theme-toggle";
import { validatePassword, validateDisplayName, MIN_PASSWORD_LENGTH } from "@/lib/account/validate";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

// The per-user Account page — REAL. Every signed-in member (not just admins) can:
//   1. update their display name  → supabase.auth.updateUser({ data: { display_name } })
//   2. change their password      → supabase.auth.updateUser({ password })
//   3. pick the dark/light theme  → same localStorage("ab-theme") + data-theme
//      mechanism the sidebar ThemeToggle uses.
// All three hit the LIVE Supabase auth user / DOM — no mock. The password +
// display-name checks run the shared validators in @/lib/account/validate, the
// same code the unit tests exercise.
export function AccountPanel() {
  // ── identity (loaded from the live Supabase auth user) ────────────────────
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loadedName, setLoadedName] = useState("");
  const [identityLoaded, setIdentityLoaded] = useState(false);

  // ── display-name save state ───────────────────────────────────────────────
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // ── password change state ─────────────────────────────────────────────────
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // ── theme + brand state ───────────────────────────────────────────────────
  const [theme, setTheme] = useState<Theme | null>(null);
  const [brand, setBrandSel] = useState<Brand | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      setEmail(user?.email ?? null);
      const name =
        (user?.user_metadata?.display_name as string | undefined)?.trim() ?? "";
      setDisplayName(name);
      setLoadedName(name);
      setIdentityLoaded(true);
    });
    setTheme(currentTheme());
    setBrandSel(currentBrand());
  }, []);

  async function saveDisplayName(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameSaved(false);
    const check = validateDisplayName(displayName);
    if (!check.ok) {
      setNameError(check.error);
      return;
    }
    setSavingName(true);
    try {
      const supabase = createClient();
      // PREFERRED path: store the name in the auth user's metadata so there's no
      // DB migration. The middleware/user-menu read it straight from the session.
      const { error } = await supabase.auth.updateUser({
        data: { display_name: check.value },
      });
      if (error) throw error;
      setLoadedName(check.value);
      setDisplayName(check.value);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2600);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Couldn’t save your name.");
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSaved(false);
    const check = validatePassword(password, confirm);
    if (!check.ok) {
      setPwError(check.error);
      return;
    }
    setSavingPw(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword("");
      setConfirm("");
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 2600);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Couldn’t update your password.");
    } finally {
      setSavingPw(false);
    }
  }

  function setThemeChoice(next: Theme) {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode / blocked storage — the in-session change still applies */
    }
    setTheme(next);
  }

  function pickBrand(next: Brand) {
    setBrand(next); // sets the data-brand attribute + persists "ab-brand"
    setBrandSel(next);
  }

  const BRANDS: { value: Brand; label: string; sub: string; swatch: string; soft: string }[] = [
    { value: "violet", label: "Violet", sub: "Default", swatch: "#7c3aed", soft: "#f3effe" },
    { value: "teal", label: "Teal", sub: "Alternate", swatch: "#0d9488", soft: "#f0fdfa" },
  ];

  const nameDirty = identityLoaded && displayName.trim() !== loadedName.trim();
  const isDark = theme === "dark";

  return (
    <div className="space-y-5">
      {/* ── PROFILE — display name ─────────────────────────────────────────── */}
      <form
        onSubmit={saveDisplayName}
        data-testid="profile-section"
        className="rounded-2xl border border-line bg-surface shadow-soft"
      >
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <User className="size-4 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-ink">Profile</h2>
            <p className="text-sm text-faint">The name shown for you across the workspace.</p>
          </div>
        </div>

        <div className="space-y-4 p-6">
          <div className="space-y-2">
            <Label htmlFor="account-email" className="text-sm font-semibold text-ink">
              Email
            </Label>
            <Input
              id="account-email"
              type="email"
              value={email ?? ""}
              readOnly
              disabled
              data-testid="account-email"
              className="h-11 cursor-not-allowed opacity-70"
            />
            <p className="text-xs text-faint">
              Your sign-in email. Ask an admin if it needs to change.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="display-name" className="text-sm font-semibold text-ink">
              Display name
            </Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Jenny Cohen"
              maxLength={80}
              data-testid="display-name-input"
              className="h-11"
            />
            <p className="text-xs text-faint">
              Leave blank to keep showing your email instead.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
            {nameError && (
              <span
                data-testid="name-error"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-red-600"
              >
                <AlertCircle className="size-4" />
                {nameError}
              </span>
            )}
            {nameSaved && !nameError && (
              <span
                data-testid="name-saved"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-accent"
              >
                <Check className="size-4" strokeWidth={2.5} />
                Saved
              </span>
            )}
            <Button
              type="submit"
              size="lg"
              disabled={savingName || !nameDirty}
              data-testid="save-name"
              className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50"
            >
              {savingName && <Loader2 className="size-4 animate-spin" />}
              Save name
            </Button>
          </div>
        </div>
      </form>

      {/* ── PASSWORD — change it ───────────────────────────────────────────── */}
      <form
        onSubmit={changePassword}
        data-testid="password-section"
        className="rounded-2xl border border-line bg-surface shadow-soft"
      >
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <KeyRound className="size-4 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-ink">Password</h2>
            <p className="text-sm text-faint">
              Set a new password — at least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>
        </div>

        <div className="space-y-4 p-6">
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-sm font-semibold text-ink">
              New password
            </Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              data-testid="new-password-input"
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-sm font-semibold text-ink">
              Confirm new password
            </Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••••"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              data-testid="confirm-password-input"
              className="h-11"
            />
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
            {pwError && (
              <span
                data-testid="password-error"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-red-600"
              >
                <AlertCircle className="size-4" />
                {pwError}
              </span>
            )}
            {pwSaved && !pwError && (
              <span
                data-testid="password-saved"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-accent"
              >
                <Check className="size-4" strokeWidth={2.5} />
                Password updated
              </span>
            )}
            <Button
              type="submit"
              size="lg"
              disabled={savingPw}
              data-testid="save-password"
              className="h-10 gap-2 bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-50"
            >
              {savingPw && <Loader2 className="size-4 animate-spin" />}
              Update password
            </Button>
          </div>
        </div>
      </form>

      {/* ── APPEARANCE — theme ─────────────────────────────────────────────── */}
      <div
        data-testid="theme-section"
        className="rounded-2xl border border-line bg-surface shadow-soft"
      >
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <Palette className="size-4 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-ink">Appearance</h2>
            <p className="text-sm text-faint">Brand color and light/dark theme — saved for this browser.</p>
          </div>
        </div>

        {/* Brand color (violet / teal) */}
        <div className="border-b border-line p-6">
          <span className="mb-3 block text-sm font-semibold text-ink">Brand color</span>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="brand-picker">
            {BRANDS.map((b) => {
              const active = brand === b.value;
              return (
                <button
                  key={b.value}
                  type="button"
                  onClick={() => pickBrand(b.value)}
                  data-testid={`brand-${b.value}`}
                  data-active={active}
                  aria-pressed={active}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl border bg-surface px-4 py-3 text-left transition-colors",
                    active ? "border-accent ring-2 ring-accent-ring" : "border-line hover:border-line-strong"
                  )}
                >
                  <span
                    className="size-9 shrink-0 rounded-xl border border-black/5"
                    style={{ background: `linear-gradient(135deg, ${b.swatch}, ${b.soft})` }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{b.label}</span>
                    <span className="block text-xs text-faint">{b.sub}</span>
                  </span>
                  {active && <Check className="size-4 shrink-0 text-accent" strokeWidth={2.5} />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-6">
          <span className="mb-2 block text-sm font-semibold text-ink">Theme</span>
          <div
            role="group"
            aria-label="Choose the theme: Light or Dark"
            className="inline-flex items-center gap-1 rounded-xl border border-line bg-canvas p-1"
          >
            <button
              type="button"
              onClick={() => setThemeChoice("light")}
              aria-pressed={theme === "light"}
              data-testid="theme-light"
              data-active={theme === "light"}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
                theme === "light" ? "bg-accent text-accent-fg shadow-soft" : "text-subtle hover:text-ink"
              )}
            >
              <Sun className="size-4" strokeWidth={2.2} />
              Light
            </button>
            <button
              type="button"
              onClick={() => setThemeChoice("dark")}
              aria-pressed={isDark}
              data-testid="theme-dark"
              data-active={isDark}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all",
                isDark ? "bg-accent text-accent-fg shadow-soft" : "text-subtle hover:text-ink"
              )}
            >
              <Moon className="size-4" strokeWidth={2.2} />
              Dark
            </button>
          </div>
          <p className="mt-3 text-xs text-faint">
            Saved on this device — it persists the same way as the toggle in the sidebar.
          </p>
        </div>
      </div>
    </div>
  );
}
