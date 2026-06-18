"use client";

import { useEffect, useState } from "react";
import { Shield, Loader2, AlertCircle, RefreshCw, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", email: newEmail.trim(), password: newPassword }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "could not create user");
      setNewEmail("");
      setNewPassword("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create user");
    } finally {
      setCreating(false);
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
                <span
                  className={cn(
                    "hidden rounded-full border px-2.5 py-0.5 text-[11px] font-medium sm:inline-flex",
                    u.role === "admin"
                      ? "border-accent-ring bg-accent-soft text-accent"
                      : "border-line bg-muted text-faint"
                  )}
                >
                  {u.role}
                </span>
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
