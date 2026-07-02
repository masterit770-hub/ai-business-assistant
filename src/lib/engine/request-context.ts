// PER-REQUEST OWNER CONTEXT — the user whose settings apply to this request.
//
// Settings (system prompt, model mode, cloud/Azure/local config + keys) are PER-USER:
// each user has their own. But those settings are read DEEP in the engine — the model
// config inside llm.ts, the system prompt in answer.ts, the urgency prompt at ingest —
// far from where we know who the caller is. Threading an ownerId through every chat()
// call site would be invasive and easy to get wrong.
//
// Instead we stash the owner in an AsyncLocalStorage at the HTTP boundary (the API route
// wraps its engine work in `runWithOwner(user.id, …)`), and the settings getters read it
// via `currentOwner()`. AsyncLocalStorage is concurrency-safe — each async request chain
// gets its own store — so under Fluid Compute (one instance, many concurrent users) one
// caller's owner never bleeds into another's. A request that forgets to set the owner
// degrades to `undefined` → the shared NULL-owner default (never another user's data), so
// a missed wrap is safe, not a leak.
import { AsyncLocalStorage } from "node:async_hooks";

type Store = { ownerId?: string };

const als = new AsyncLocalStorage<Store>();

/** Run `fn` with `ownerId` as the current request's settings owner. */
export function runWithOwner<T>(ownerId: string | undefined, fn: () => T): T {
  return als.run({ ownerId }, fn);
}

/** The current request's settings owner, or undefined (→ shared workspace default). */
export function currentOwner(): string | undefined {
  return als.getStore()?.ownerId;
}
