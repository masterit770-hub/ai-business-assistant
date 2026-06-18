import Link from "next/link";
import { AuthShell, GoogleGlyph } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

        <Button
          variant="outline"
          size="lg"
          className="mt-7 h-11 w-full gap-2.5 border-line bg-surface text-ink hover:bg-muted"
        >
          <GoogleGlyph />
          Continue with Google
        </Button>

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-line" />
          <span className="text-xs font-medium uppercase tracking-wider text-faint">
            or
          </span>
          <div className="h-px flex-1 bg-line" />
        </div>

        <form className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-sm font-medium text-ink">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="you@company.com"
              defaultValue="dana@meridian.co"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-sm font-medium text-ink">
                Password
              </Label>
              <Link
                href="#"
                className="text-xs font-medium text-accent hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              placeholder="••••••••••"
              defaultValue="password"
              className="h-11"
            />
          </div>
          <Button
            asChild
            size="lg"
            className="h-11 w-full bg-accent text-accent-fg hover:bg-accent/90 shadow-soft"
          >
            <Link href="/dashboard">Sign in</Link>
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-faint">
          New to Nucleus?{" "}
          <Link href="/sign-up" className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
