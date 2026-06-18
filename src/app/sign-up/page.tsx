import Link from "next/link";
import { Check } from "lucide-react";
import { AuthShell, GoogleGlyph } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const perks = [
  "Connect your first source in minutes",
  "100 free questions every month",
  "No credit card required",
];

export default function SignUpPage() {
  return (
    <AuthShell>
      <div className="rounded-2xl border border-line bg-surface p-8 shadow-card">
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Create your workspace
          </h1>
          <p className="mt-1.5 text-sm text-faint">
            Give your business one brain — free to start
          </p>
        </div>

        <ul className="mt-6 space-y-2">
          {perks.map((p) => (
            <li key={p} className="flex items-center gap-2.5 text-sm text-subtle">
              <span className="flex size-4 items-center justify-center rounded-full bg-accent-soft">
                <Check className="size-3 text-accent" strokeWidth={2.5} />
              </span>
              {p}
            </li>
          ))}
        </ul>

        <Button
          variant="outline"
          size="lg"
          className="mt-6 h-11 w-full gap-2.5 border-line bg-surface text-ink hover:bg-muted"
        >
          <GoogleGlyph />
          Sign up with Google
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
            <Label htmlFor="name" className="text-sm font-medium text-ink">
              Full name
            </Label>
            <Input
              id="name"
              type="text"
              placeholder="Dana Whitfield"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-sm font-medium text-ink">
              Work email
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="you@company.com"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-sm font-medium text-ink">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              placeholder="At least 8 characters"
              className="h-11"
            />
          </div>
          <Button
            asChild
            size="lg"
            className="h-11 w-full bg-accent text-accent-fg hover:bg-accent/90 shadow-soft"
          >
            <Link href="/dashboard">Create account</Link>
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-faint">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
