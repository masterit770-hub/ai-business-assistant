import { Suspense } from "react";
import { AuthShell } from "@/components/auth-shell";
import { AuthForm } from "@/components/auth-form";

export default function SignInPage() {
  return (
    <AuthShell>
      <div className="rounded-2xl border border-line bg-surface p-8 shadow-card">
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Welcome back
          </h1>
          <p className="mt-1.5 text-sm text-faint">
            Sign in to your Nucleus workspace
          </p>
        </div>

        <div className="mt-7">
          <Suspense fallback={null}>
            <AuthForm mode="sign-in" />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-faint">
          Accounts are provisioned by your administrator. Contact them for access.
        </p>
      </div>
    </AuthShell>
  );
}
