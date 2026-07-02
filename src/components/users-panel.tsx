"use client";

import { useEffect, useState } from "react";
import {
  Shield,
  Loader2,
  AlertCircle,
  RefreshCw,
  UserPlus,
  Copy,
  Check,
  Link2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The credentials block an admin hands a new teammate after creating their account:
// a clickable invite link (set-your-own-password) + the temp password as a fallback.
type Invite = { email: string; inviteLink: string | null; tempPassword: string };

type UserStatus = "active" | "deactivated";
type AdminUser = {
  id: string;
  email: string;
  role: "user" | "admin";
  status: UserStatus;
  createdAt: string;
  lastSignInAt: string | null;
  isSelf?: boolean;
};

const statusPill: Record<UserStatus, { label: string; cls: string; dot: string }> = {
  active: { label: "Active", cls: "border-accent/20 bg-accent-soft text-accent", dot: "bg-accent" },
  deactivated: { label: "Deactivated", cls: "border-line bg-muted text-faint", dot: "bg-faint" },
};

function initials(email: string) {
  return email.split("@")[0].slice(0, 2).toUpperCase();
}
function ago(iso: string | null) {
  if (!iso) return "never";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The REAL Users admin panel — backed by the Supabase admin API. Lists actual
// users; Deactivate bans the user (their session is revoked + future tokens are
// rejected → kicked out on their next request). Reactivate un-bans.
export function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);
  // After a successful create, hold the invite/credentials to hand the teammate.
  const [invite, setInvite] = useState<Invite | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/admin/users");
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "failed to load users");
      setUsers(d.users);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load users");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function toggle(u: AdminUser) {
    setBusyId(u.id);
    setError(null);
    try {
      const action = u.status === "deactivated" ? "reactivate" : "deactivate";
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: u.id, action }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "action failed");
      setUsers((prev) => prev?.map((x) => (x.id === u.id ? { ...x, status: d.status } : x)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const email = newEmail.trim();
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", email, password: newPassword }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "could not create user");
      // Surface the invite link + temp password so the admin has something to send.
      setInvite(
        (d.invite as Invite | undefined) ?? {
          email,
          inviteLink: null,
          tempPassword: newPassword,
        }
      );
      setNewEmail("");
      setNewPassword("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create user");
    } finally {
      setCreating(false);
    }
  }

  // Promote/demote via the existing setRole action, with a confirm and optimistic
  // list update. The server refuses a self-demote (lockout guard); we surface that.
  async function setUserRole(u: AdminUser, nextRole: "user" | "admin") {
    if (nextRole === u.role) return;
    const verb = nextRole === "admin" ? "Make admin" : "Make member";
    if (!window.confirm(`${verb}: change ${u.email}'s role to "${nextRole}"?`)) return;
    setBusyId(u.id);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: u.id, action: "setRole", role: nextRole }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "could not change role");
      setUsers((prev) => prev?.map((x) => (x.id === u.id ? { ...x, role: d.role } : x)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not change role");
    } finally {
      setBusyId(null);
    }
  }

  const activeCount = users?.filter((u) => u.status === "active").length ?? 0;

  return (
    <div className="rounded-2xl border border-line bg-surface shadow-soft" data-testid="users-panel">
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <Shield className="size-4 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold text-ink">Users &amp; access</h2>
          <p className="text-sm text-faint">
            {users ? `${activeCount} active · ${users.length} total` : "Loading…"}
          </p>
        </div>
        <span className="rounded-full border border-accent-ring bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent">
          Live
        </span>
        <button onClick={load} className="text-faint hover:text-ink" title="Refresh">
          <RefreshCw className="size-4" />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700">
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}

      {/* create a new account (admin) */}
      <form
        onSubmit={createUser}
        className="flex flex-wrap items-end gap-3 border-b border-line bg-canvas px-6 py-4"
        data-testid="create-user-form"
      >
        <div className="flex-1 min-w-[180px] space-y-1">
          <label className="text-xs font-medium text-faint">New user email</label>
          <Input
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="teammate@company.com"
            className="h-9"
          />
        </div>
        <div className="min-w-[150px] space-y-1">
          <label className="text-xs font-medium text-faint">Temp password</label>
          <Input
            type="text"
            required
            minLength={6}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="min 6 chars"
            className="h-9"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          disabled={creating}
          className="h-9 gap-1.5 bg-accent text-accent-fg hover:bg-accent/90"
        >
          {creating ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
          Create account
        </Button>
      </form>

      {/* invite hand-off card — shown after a create or a row "Copy invite" */}
      {invite && (
        <div
          data-testid="invite-card"
          className="border-b border-accent-ring bg-accent-soft/60 px-6 py-4"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Link2 className="size-4 text-accent" />
              Invite for <span className="font-mono text-[13px]">{invite.email}</span>
            </p>
            <button
              onClick={() => setInvite(null)}
              className="text-faint hover:text-ink"
              title="Dismiss"
              data-testid="invite-dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
          <p className="mb-3 text-xs text-subtle">
            Share these sign-in details with the teammate. They can change their password
            from the Account page once they’re signed in.
          </p>

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <CopyField label="Email" value={invite.email} testid="invite-email" mono />
            <CopyField
              label="Temp password"
              value={invite.tempPassword}
              testid="invite-password"
              mono
            />
          </div>
        </div>
      )}

      {!users && !error && (
        <div className="flex items-center gap-2 px-6 py-8 text-sm text-faint">
          <Loader2 className="size-4 animate-spin" /> Loading real users…
        </div>
      )}

      {users && (
        <ul className="divide-y divide-line">
          {users.map((u) => {
            const pill = statusPill[u.status];
            const isOff = u.status === "deactivated";
            return (
              <li
                key={u.id}
                data-testid={`user-row-${u.email}`}
                className={cn("flex items-center gap-4 px-6 py-4", isOff && "opacity-60")}
              >
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                    isOff ? "bg-muted text-faint" : "bg-accent text-accent-fg"
                  )}
                >
                  {initials(u.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium text-ink">
                    {u.email}
                    {u.isSelf && <span className="text-xs font-normal text-faint">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-faint">
                    last sign-in {ago(u.lastSignInAt)}
                  </p>
                </div>
                {/* role control: a pill showing the current role + a toggle that
                    promotes/demotes via setRole (with a confirm). Self-demote is
                    blocked server-side, so we don't offer it on your own row. */}
                <div className="hidden items-center gap-1.5 sm:flex">
                  <span
                    data-testid={`user-role-${u.email}`}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                      u.role === "admin"
                        ? "border-accent-ring bg-accent-soft text-accent"
                        : "border-line bg-muted text-faint"
                    )}
                  >
                    {u.role}
                  </span>
                  {!u.isSelf && (
                    <button
                      onClick={() => setUserRole(u, u.role === "admin" ? "user" : "admin")}
                      disabled={busyId === u.id}
                      data-testid={`user-role-toggle-${u.email}`}
                      title={u.role === "admin" ? "Demote to member" : "Promote to admin"}
                      className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-subtle transition-colors hover:border-accent-ring hover:text-ink disabled:opacity-50"
                    >
                      {u.role === "admin" ? "Make member" : "Make admin"}
                    </button>
                  )}
                </div>
                <span
                  data-testid={`user-status-${u.email}`}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                    pill.cls
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", pill.dot)} />
                  {pill.label}
                </span>
                {u.isSelf ? (
                  <span className="w-[110px] text-right text-xs text-faint">—</span>
                ) : (
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => toggle(u)}
                    disabled={busyId === u.id}
                    data-testid={`user-toggle-${u.email}`}
                    className={cn(
                      "h-9 w-[110px] border-line",
                      isOff ? "text-accent hover:bg-accent-soft" : "text-red-600 hover:border-red-200 hover:bg-red-50"
                    )}
                  >
                    {busyId === u.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : isOff ? (
                      "Reactivate"
                    ) : (
                      "Kick out"
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="border-t border-line px-6 py-3 text-xs text-faint">
        Live · real Supabase users. Deactivate bans the user and revokes their sessions —
        they’re signed out and blocked on their next request.
      </p>
    </div>
  );
}

// A read-only field with a Copy button — the building block of the invite card so the
// admin can one-click copy the link / email / temp password to paste to a teammate.
function CopyField({
  label,
  value,
  testid,
  mono,
}: {
  label: string;
  value: string;
  testid: string;
  mono: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (e.g. insecure context) — the value is still selectable */
    }
  }
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-[11px] font-medium text-faint">{label}</label>
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={value}
          data-testid={`${testid}-value`}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-xs text-ink",
            mono && "font-mono"
          )}
        />
        <button
          type="button"
          onClick={onCopy}
          data-testid={`${testid}-copy`}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-subtle transition-colors hover:border-accent-ring hover:text-ink"
        >
          {copied ? (
            <>
              <Check className="size-3.5 text-accent" strokeWidth={2.5} />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
