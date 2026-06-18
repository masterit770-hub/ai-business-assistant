import { Check, Plug, CreditCard } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { SimpleTabs } from "@/components/simple-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sources, currentUser } from "@/lib/mock";

function ProfileTab() {
  return (
    <div className="rounded-2xl border border-line bg-surface p-7 shadow-soft">
      <div className="flex items-center gap-4 border-b border-line pb-6">
        <span className="flex size-16 items-center justify-center rounded-full bg-accent text-xl font-semibold text-accent-fg">
          {currentUser.initials}
        </span>
        <div>
          <p className="font-display text-lg font-semibold text-ink">
            {currentUser.name}
          </p>
          <p className="text-sm text-faint">{currentUser.role}</p>
        </div>
        <Button
          variant="outline"
          size="lg"
          className="ml-auto h-9 border-line text-ink hover:bg-muted"
        >
          Change photo
        </Button>
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-ink">Full name</Label>
          <Input defaultValue={currentUser.name} className="h-11" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-ink">Email</Label>
          <Input defaultValue={currentUser.email} className="h-11" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-ink">Role</Label>
          <Input defaultValue={currentUser.role} className="h-11" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-ink">Company</Label>
          <Input defaultValue={currentUser.company} className="h-11" />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" size="lg" className="h-10">
          Cancel
        </Button>
        <Button size="lg" className="h-10 bg-accent text-accent-fg hover:bg-accent/90">
          Save changes
        </Button>
      </div>
    </div>
  );
}

function SourcesTab() {
  return (
    <div className="rounded-2xl border border-line bg-surface shadow-soft">
      <div className="flex items-center gap-2 border-b border-line px-6 py-4">
        <Plug className="size-4 text-accent" />
        <h2 className="font-display text-base font-semibold text-ink">
          Connected sources
        </h2>
      </div>
      <ul className="divide-y divide-line">
        {sources.map((src) => (
          <li key={src.id} className="flex items-center gap-4 px-6 py-4">
            <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-canvas text-sm font-bold text-subtle">
              {src.name.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{src.name}</p>
              <p className="truncate text-sm text-faint">
                {src.connected
                  ? `${src.itemCount?.toLocaleString()} items · synced ${src.lastSync}`
                  : src.description}
              </p>
            </div>
            {src.connected ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
                <Check className="size-3.5" strokeWidth={2.5} />
                Connected
              </span>
            ) : (
              <Button
                size="lg"
                className="h-9 bg-accent text-accent-fg hover:bg-accent/90"
              >
                Connect
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BillingTab() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-2xl border border-accent-ring bg-accent-soft p-6">
        <div>
          <div className="flex items-center gap-2">
            <CreditCard className="size-4 text-accent" />
            <p className="font-semibold text-ink">Business plan</p>
          </div>
          <p className="mt-1 text-sm text-subtle">12 seats · renews Jul 1, 2026</p>
        </div>
        <div className="text-right">
          <p className="tabular text-2xl font-semibold text-ink">$1,548</p>
          <p className="text-xs text-faint">per month</p>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-6 shadow-soft">
        <h3 className="font-display text-base font-semibold text-ink">
          Payment method
        </h3>
        <div className="mt-4 flex items-center justify-between rounded-xl border border-line bg-canvas px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-12 items-center justify-center rounded-md bg-ink text-xs font-bold text-white">
              VISA
            </span>
            <span className="tabular text-sm text-ink">•••• •••• •••• 4242</span>
          </div>
          <Button
            variant="outline"
            size="lg"
            className="h-9 border-line text-ink hover:bg-muted"
          >
            Update
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-6 shadow-soft">
        <h3 className="font-display text-base font-semibold text-ink">
          Recent invoices
        </h3>
        <ul className="mt-3 divide-y divide-line">
          {[
            { date: "Jun 1, 2026", amount: "$1,548.00" },
            { date: "May 1, 2026", amount: "$1,548.00" },
            { date: "Apr 1, 2026", amount: "$1,419.00" },
          ].map((inv) => (
            <li
              key={inv.date}
              className="flex items-center justify-between py-3 text-sm"
            >
              <span className="text-ink">{inv.date}</span>
              <span className="tabular text-subtle">{inv.amount}</span>
              <a href="#" className="font-medium text-accent hover:underline">
                Download
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <AppSidebar active="settings" />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-line bg-surface px-7 py-4">
          <h1 className="font-display text-xl font-bold tracking-tight text-ink">
            Settings
          </h1>
          <p className="text-sm text-faint">
            Manage your profile, connected sources, and billing.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-3xl">
            <SimpleTabs
              defaultValue="sources"
              tabs={[
                { value: "profile", label: "Profile", content: <ProfileTab /> },
                { value: "sources", label: "Sources", content: <SourcesTab /> },
                { value: "billing", label: "Billing", content: <BillingTab /> },
              ]}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
