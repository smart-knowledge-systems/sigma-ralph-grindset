# useSyncExternalStore Boundary Policy

**Version 1.0.0**
April 2026

> **Note:**
> This document is mainly for agents and LLMs to follow when maintaining,
> generating, or refactoring React codebases. Humans may also find it useful,
> but guidance here is optimized for automation and consistency by AI-assisted
> workflows.

> **Companion Policies:**
> This policy extends `react-useeffect-discipline/POLICY.md` Rule 3.3 with a
> codebase-specific audit framework, and coordinates with
> `legend-state-conventions/POLICY.md` on where Legend State's responsibility
> ends and `useSyncExternalStore`'s begins. It is **not** an instruction to
> remove Legend State or Dexie — both remain correct for their domains. It is
> an instruction to place state where its *source of truth* actually lives.

---

## Abstract

State in this codebase lives in several tiers: Legend State observables, Dexie/IndexedDB, Convex, React component state, or — most subtly — entirely outside our code in the browser, a DOM element, or a third-party SDK. When state whose source of truth is an external system is *mirrored* into Legend State or Dexie via `useEffect + setState / store$.set(...)`, the mirror is a liability. It tears under concurrent rendering, skips server snapshots, leaks listeners under Strict Mode, double-subscribes on remount, and silently drifts when the external source changes through a path our mirror doesn't observe (e.g. `<dialog>` closing on Escape).

`useSyncExternalStore` is React's purpose-built primitive for subscribing to externally-owned values. This policy defines which state must move off Legend State / Dexie onto `useSyncExternalStore`, which state must stay, how to write the hook correctly, and the audit signals that identify misplaced ownership.

---

## Table of Contents

1. [Ownership Decision Framework](#1-ownership-decision-framework) — **CRITICAL**
2. [State That Belongs on useSyncExternalStore](#2-state-that-belongs-on-usesyncexternalstore) — **HIGH**
   - 2.1 [Browser Global APIs](#21-browser-global-apis)
   - 2.2 [Media Query Subscriptions](#22-media-query-subscriptions)
   - 2.3 [Live DOM Element Properties](#23-live-dom-element-properties)
   - 2.4 [Third-Party SDK Internal State](#24-third-party-sdk-internal-state)
   - 2.5 [IndexedDB Live Queries](#25-indexeddb-live-queries)
3. [State That Must Stay on Legend State or Dexie](#3-state-that-must-stay-on-legend-state-or-dexie) — **HIGH**
   - 3.1 [App-Owned Reading and Session State](#31-app-owned-reading-and-session-state)
   - 3.2 [Legend-State-Persisted Cross-Session State](#32-legend-state-persisted-cross-session-state)
   - 3.3 [Convex-Backed Server State](#33-convex-backed-server-state)
   - 3.4 [Derived Values](#34-derived-values)
4. [Correct useSyncExternalStore Patterns](#4-correct-usesyncexternalstore-patterns) — **MEDIUM**
   - 4.1 [Hoist subscribe Outside the Component](#41-hoist-subscribe-outside-the-component)
   - 4.2 [Return Stable References from getSnapshot](#42-return-stable-references-from-getsnapshot)
   - 4.3 [Provide getServerSnapshot for SSR-Reachable Routes](#43-provide-getserversnapshot-for-ssr-reachable-routes)
   - 4.4 [Encapsulate Each External Source as a Custom Hook](#44-encapsulate-each-external-source-as-a-custom-hook)
5. [Audit Signals](#5-audit-signals) — **MEDIUM**
   - 5.1 [The useEffect + addEventListener + setState Trio](#51-the-useeffect--addeventlistener--setstate-trio)
   - 5.2 [Observables Written Only from One useEffect](#52-observables-written-only-from-one-useeffect)
   - 5.3 [Naming That Admits a Mirror](#53-naming-that-admits-a-mirror)
   - 5.4 [Mixed-Ownership Observable Slices](#54-mixed-ownership-observable-slices)
6. [Migration Workflow](#6-migration-workflow) — **LOW**
7. [Quick Reference](#7-quick-reference)

---

## Decision Framework

Before storing a value, answer: **"If the tab reloads, who knows the right answer?"**

| Source of truth | Correct storage |
|---|---|
| App logic / user actions / event handlers | Legend State observable or React state |
| Server database (authoritative, cross-device) | Convex `useQuery` |
| Offline queue of pending server writes | Dexie |
| Browser API (`navigator`, `matchMedia`, `document.visibilityState`, `window.history`) | `useSyncExternalStore` |
| Specific DOM element property (`<dialog>.open`, `<video>.currentTime`) | `useSyncExternalStore` |
| Third-party SDK internal state (Zoom client, Stripe element) | `useSyncExternalStore` |
| IndexedDB row that may change from another tab/context | `useLiveQuery` from `dexie-react-hooks` |
| A value derivable from any of the above | Derive during render — do not store |

If a `useEffect` subscribes to an external system and calls `setState`/`store$.set(...)` to mirror that system's state, that is the signature of a misplaced `useSyncExternalStore` case.

---

## 1. Ownership Decision Framework

**Impact: CRITICAL**

### 1.1 Every Observable Value Has a Documented Source of Truth

Before adding state to any tier (Legend State, Dexie, React state, Convex), name the source of truth in a comment or commit message. If the source is a browser API, DOM element, or third-party SDK, the correct primitive is `useSyncExternalStore` — not Legend State, not Dexie, not `useState` + `useEffect`.

### 1.2 Do Not Mirror Externally-Owned Values Into App-Owned Stores

A value that is **read from** an external source (`navigator.*`, `document.*`, `window.matchMedia(...)`, a `ref`'d DOM element, an SDK client handle) and is **only written from** a `useEffect` that subscribes to that same source is a **mirror**. Mirrors are the anti-pattern this policy targets.

**Why mirrors fail:**

- **Tearing.** During a concurrent-mode render pass, the external source can change between two reads of the mirror, producing visibly inconsistent UI within a single frame.
- **Strict-Mode double-mount.** Two consecutive `useEffect` subscriptions register two native listeners; cleanup runs once per mount, leaving a leak.
- **SSR divergence.** The server renders with the mirror's initial value; the client hydrates with a later value; React logs a hydration mismatch.
- **Back-channel drift.** The external source updates through a code path the mirror's listener doesn't cover (e.g. `<dialog>` closing on the user pressing Escape, which doesn't fire `click` on a close button). The mirror silently goes stale.

`useSyncExternalStore` prevents all four by definition.

---

## 2. State That Belongs on useSyncExternalStore

**Impact: HIGH**

### 2.1 Browser Global APIs

Values exposed by `navigator`, `window`, `document`, and `screen` that emit change events must be subscribed via `useSyncExternalStore`, not mirrored into state.

**Incorrect:**

```tsx
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return isOnline;
}
```

**Correct:**

```tsx
function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}
const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

### 2.2 Media Query Subscriptions

`window.matchMedia(query)` returns a `MediaQueryList` whose `.matches` field is owned by the browser. Any hook that mirrors `.matches` into `useState` + `useEffect("change")` is a `useSyncExternalStore` candidate.

**Codebase audit targets:**

- `src/components/orientation/celebration/use-reduced-motion.ts` — `(prefers-reduced-motion: reduce)`
- `src/lib/hooks/use-input-type.ts` — `(hover: hover)` (the initial-value path)
- `src/lib/hooks/use-pwa-install.ts` — `(display-mode: standalone)`

**Incorrect (current shape of `use-reduced-motion.ts`):**

```tsx
export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) =>
      setPrefersReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return prefersReducedMotion;
}
```

**Correct:**

```tsx
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}
const getSnapshot = () => window.matchMedia(QUERY).matches;
const getServerSnapshot = () => false;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

### 2.3 Live DOM Element Properties

When the source of truth is a property on a specific DOM element — `<dialog>.open`, `<video>.currentTime`, `<details>.open`, a custom element's attribute — subscribe to the element's own event (`toggle`, `timeupdate`, etc.) via `useSyncExternalStore`. Do not maintain a parallel React state that must be kept in sync by every code path that mutates the element.

**Incorrect (the classic `<dialog>` bug):**

```tsx
const [isOpen, setIsOpen] = useState(false);
function open() {
  dialogRef.current?.showModal();
  setIsOpen(true);
}
function close() {
  dialogRef.current?.close();
  setIsOpen(false);
}
// Bug: pressing Escape closes the <dialog> but `isOpen` stays true forever.
```

**Correct:**

```tsx
function useDialogOpen(dialogRef: RefObject<HTMLDialogElement>): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const el = dialogRef.current;
      if (!el) return () => {};
      el.addEventListener("toggle", callback);
      return () => el.removeEventListener("toggle", callback);
    },
    [dialogRef],
  );
  const getSnapshot = useCallback(
    () => dialogRef.current?.open ?? false,
    [dialogRef],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
```

The ref-closure requires `useCallback`, which is one of the two legitimate reasons to inline `subscribe`. See [Rule 4.1](#41-hoist-subscribe-outside-the-component).

### 2.4 Third-Party SDK Internal State

SDKs such as the Zoom Video SDK maintain internal state — client connection status, participant list, current audio/video stream. Mirroring that state into a Legend State observable via `useEffect` is fragile for every reason in [Rule 1.2](#12-do-not-mirror-externally-owned-values-into-app-owned-stores).

**Codebase audit target:** `orientationConnectionStore$` in `src/frontend/observable/stores.ts`, populated by `use-zoom-session`, `use-zoom-events`, and `use-zoom-media`. Each SDK-owned slice is a candidate for a dedicated `useSyncExternalStore` hook backed by the Zoom client's event emitter.

Prefer incremental, per-slice migration over a big-bang rewrite:

| Slice                             | Source of truth              | Recommendation                                           |
| --------------------------------- | ---------------------------- | -------------------------------------------------------- |
| `connection.status`               | Zoom client state            | `useZoomConnectionStatus()` via `useSyncExternalStore`   |
| `connection.participantCount`     | Zoom client participants     | Derive from `useZoomParticipants()` during render        |
| `media.videoOn` / `media.audioOn` | Zoom stream object           | `useZoomMediaState()` via `useSyncExternalStore`         |
| `participants[]`                  | Zoom client participants     | `useZoomParticipants()` via `useSyncExternalStore`       |
| `localUserId`                     | Zoom client self             | `useZoomLocalUserId()` via `useSyncExternalStore`        |
| `aideVideoManualOverride`         | User toggle (app-owned)      | STAY in `orientationAideStore$`                          |
| `phase`, `highlightedWordIndex`   | Convex `orientationState`    | STAY in `orientationStore$` (Convex-synced)              |

Mixed-ownership observables must be split into single-owner slices before migration; see [Rule 5.4](#54-mixed-ownership-observable-slices).

### 2.5 IndexedDB Live Queries

`dexie-react-hooks` provides `useLiveQuery`, which is built on the same concurrency-safe primitives as `useSyncExternalStore`. If a component currently reads Dexie data via `useEffect(() => { db.records.toArray().then(setState) }, [])`, replace it with `useLiveQuery(() => db.records.toArray())`.

Do not mirror Dexie rows into a Legend State observable as a UI cache. Dexie is already the offline source of truth for learning records and cached assets; `useLiveQuery` is the React-safe read path. Reserve Legend State observables for app-owned ephemeral state that has no external source of truth.

---

## 3. State That Must Stay on Legend State or Dexie

**Impact: HIGH**

### 3.1 App-Owned Reading and Session State

The following observables have no external source of truth and must stay on Legend State:

- `readingSessionStore$.currentPage`, `.focusIndex`, `.wordsReadThisSession` — mutated only by our event handlers and page-turn logic.
- `uiStateStore$.isDrawerOpen`, `.showConfetti`, `.tutorialDismissed` — mutated only by our engagement handlers. (Exception: if the drawer is ever implemented as a native `<dialog>`, its `open` property becomes the source of truth and moves to [Rule 2.3](#23-live-dom-element-properties).)
- `exerciseStore$.choices`, `.choiceIndex`, `.incorrectMatches` — computed when the reader engages a word.
- `appStore$.fluencyCache`, `.learningRecords` — in-memory caches and queues owned by our sync logic.

### 3.2 Legend-State-Persisted Cross-Session State

`session$` and `library$` are persisted via `syncObservable(…, { persist: { plugin: ObservablePersistLocalStorage } })` and, in `library$`'s case, synced to Convex. Legend State already provides atomic hydration, cross-tab awareness, debounced writes, and SSR-safe initial values. Do **not** replace this with a hand-rolled `useSyncExternalStore(localStorage…)` — the existing plugin is strictly better for persisted key-value state with app-owned writers.

### 3.3 Convex-Backed Server State

Convex's `useQuery` is itself implemented on `useSyncExternalStore` semantics and handles subscription, concurrent rendering, and reconciliation. Do not re-implement it on top of a raw `useSyncExternalStore`. Do not mirror Convex query results into Legend State observables — consume `useQuery` directly.

### 3.4 Derived Values

A value computed from other observables, props, or React state must be *derived during render*, not stored in any tier. Governed by `react-useeffect-discipline/POLICY.md` Rule 1.1 and `vercel-react-best-practices/POLICY.md` Rule 5.1.

---

## 4. Correct useSyncExternalStore Patterns

**Impact: MEDIUM**

### 4.1 Hoist subscribe Outside the Component

**Impact: HIGH (prevents resubscription on every render)**

If `subscribe` is defined inside a component or hook body, every render produces a new function reference. React compares references and resubscribes — tearing down and rebuilding the native listener on every render. Hoist `subscribe` to module scope.

Only two situations justify an in-body `subscribe`:

1. The subscription depends on a ref to a DOM element (see [Rule 2.3](#23-live-dom-element-properties)) — wrap in `useCallback` with the ref as a dependency.
2. The subscription depends on a prop or other reactive value — wrap in `useCallback` with those dependencies. If this is happening often, consider whether the prop belongs in the key or if the hook should be split.

**Incorrect:**

```tsx
function useOnlineStatus() {
  return useSyncExternalStore(
    (cb) => {
      // New function every render — React resubscribes.
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
  );
}
```

**Correct:** `subscribe` at module scope; see [Rule 2.1](#21-browser-global-apis).

### 4.2 Return Stable References from getSnapshot

**Impact: HIGH (prevents infinite re-render loops)**

`getSnapshot` is called on every render. React compares successive results with `Object.is`. If you return a fresh object literal each call, every render appears as a store change — React re-renders, which calls `getSnapshot` again, which returns another new object, forever. React 18+ will throw `"The result of getSnapshot should be cached"`; React 17 will silently loop.

**Incorrect:**

```tsx
const getSnapshot = () => ({ online: navigator.onLine }); // new object every call
```

**Correct — return a primitive:**

```tsx
const getSnapshot = () => navigator.onLine; // Object.is-stable
```

**Correct — cache an aggregate snapshot:**

```tsx
type Snapshot = { online: boolean; standalone: boolean };
let cached: Snapshot | null = null;

function getSnapshot(): Snapshot {
  const next = {
    online: navigator.onLine,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
  };
  if (
    cached &&
    cached.online === next.online &&
    cached.standalone === next.standalone
  ) {
    return cached;
  }
  cached = next;
  return next;
}
```

Prefer multiple single-value hooks over one aggregate hook — it eliminates the caching problem entirely, matches the "one external source per hook" convention in [Rule 4.4](#44-encapsulate-each-external-source-as-a-custom-hook), and lets consumers subscribe only to the slices they need.

### 4.3 Provide getServerSnapshot for SSR-Reachable Routes

**Impact: MEDIUM (prevents hydration errors)**

Any hook that may be invoked during server rendering — which in a Next.js App Router project includes any hook reachable from a `"use client"` component rendered by a server route — must pass a third `getServerSnapshot` argument. Omitting it throws at SSR.

Pick a conservative default:

| Hook                       | Server default                    |
| -------------------------- | --------------------------------- |
| `useOnlineStatus`          | `() => true`                      |
| `useReducedMotion`         | `() => false`                     |
| `usePWAInstallAvailable`   | `() => false`                     |
| `useStandaloneDisplayMode` | `() => false`                     |
| `useDialogOpen`            | `() => false`                     |
| `useZoomConnectionStatus`  | `() => "disconnected"`            |
| `useZoomParticipants`      | `() => EMPTY_PARTICIPANTS` (stable constant) |

For aggregate server snapshots, export a frozen constant so every SSR call returns the same reference.

### 4.4 Encapsulate Each External Source as a Custom Hook

**Impact: MEDIUM**

Expose a single `useX` hook per external source in `src/lib/hooks/use-*.ts`; do not inline `useSyncExternalStore` in feature components. Concentrating the correctness contract (stable `subscribe`, cached snapshot, SSR default) in one reviewable location matches the existing hook style and makes every external source a single grep target during audit.

---

## 5. Audit Signals

**Impact: MEDIUM**

These are the patterns an auditor should flag for review against Sections 2 and 3.

### 5.1 The useEffect + addEventListener + setState Trio

A `useEffect` whose body contains `addEventListener` (or an SDK `on(...)` / `subscribe(...)` call) and whose callback contains `setState`, `store$.set(...)`, or `db.records.put(...)` is almost always a misplaced `useSyncExternalStore` case. Flag every occurrence.

Known occurrences in this repo at policy creation time (non-exhaustive):

- `src/components/orientation/celebration/use-reduced-motion.ts`
- `src/lib/hooks/use-input-type.ts` (touch/hover media portion)
- `src/lib/hooks/use-pwa-install.ts` (`beforeinstallprompt` / `appinstalled` portion)
- `src/lib/hooks/use-zoom-events.ts` and siblings (writing to `orientationConnectionStore$`)

### 5.2 Observables Written Only from One useEffect

A Legend State observable property that is `.set()` only inside a single `useEffect` subscription — never from an event handler, server action, or sync mutation — is a mirror. The observable adds no cross-component benefit over `useSyncExternalStore` and loses React's concurrent-safety guarantees.

Audit procedure: for each field on every `*Store$`, grep for `.set(` on that field. If all writers are subscription callbacks in `useEffect`s, the field is a migration candidate.

### 5.3 Naming That Admits a Mirror

Variable or property names like `connectionMirror`, `mediaStateCache`, `localOnlineStatus`, `sdkSnapshot` tracking state that has another source of truth suggest the author recognized the pattern. These are high-yield audit targets — the naming already admits the problem.

### 5.4 Mixed-Ownership Observable Slices

An observable whose fields have different sources of truth (some SDK-owned, some user-owned, some Convex-synced) cannot be migrated as a unit and should be split before migration. `orientationConnectionStore$` is currently clean (all SDK-owned), but the larger `orientationStore$` mixes Convex-synced state with reader-owned UI state — that split was the right call (see PR #9).

When a single observable accumulates mixed ownership, split it first, then apply this policy to the SDK-owned slice.

---

## 6. Migration Workflow

**Impact: LOW** — procedural guidance for contributors executing a migration.

When moving a field off Legend State / Dexie onto `useSyncExternalStore`:

1. **Identify the true source of truth.** If it is a browser API, DOM property, SDK handle, or `useLiveQuery`-eligible Dexie table, proceed. If it is app-owned or Convex-owned, stop — it stays where it is.
2. **Write the custom hook** in `src/lib/hooks/use-*.ts` with module-level `subscribe`, `getSnapshot`, and `getServerSnapshot`. Follow Section 4.
3. **Replace consumers** of the mirrored observable with the new hook, one consumer per commit so regressions are bisectable.
4. **Delete the observable field** and its initial-state factory entry in `src/frontend/observable/initial-state.ts` once no consumers remain.
5. **Delete the `useEffect` that wrote the mirror.** If it was embedded in a larger hook, verify no other logic relied on the write as a side channel.
6. **Run `bun check`** and grep for remaining references — a dangling `.set()` on the retired property is a regression waiting to happen.

Do not combine migration with unrelated refactors. A per-slice migration is the unit of review.

---

## 7. Quick Reference

| You have…                                                               | Move to                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| `useState(navigator.onLine) + useEffect(addEventListener("online"))`    | `useSyncExternalStore`                           |
| `useState(matchMedia(…).matches) + useEffect(…"change"…)`               | `useSyncExternalStore`                           |
| `<dialog>.open` mirrored into React state                               | `useSyncExternalStore` on `"toggle"`             |
| Zoom SDK connection/media/participants mirrored into Legend State       | `useSyncExternalStore` per slice                 |
| Dexie rows read via `useEffect(db.records.toArray().then(setState))`    | `useLiveQuery` (`dexie-react-hooks`)             |
| Reader's current page, drawer open from user tap, choice index          | STAY on Legend State                             |
| `session$` / `library$` with `syncObservable(…localStorage)`            | STAY on Legend State                             |
| Convex-synced orientation phase, highlighted word                       | `useQuery` directly — do not mirror into Legend State |
| Convex query result                                                     | `useQuery` — do not mirror                       |
| Value derivable from props/state                                        | Derive during render                             |

---

## References

1. [react.dev — useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
2. [react.dev — You Might Not Need an Effect · Subscribing to an external store](https://react.dev/learn/you-might-not-need-an-effect#subscribing-to-an-external-store)
3. `audit/policies/react-useeffect-discipline/POLICY.md` — Rule 3.3 (this policy extends it)
4. `audit/.policies/legend-state-conventions/POLICY.md` — Legend State usage conventions
5. `docs/architecture/03-persistence-and-sync.md` — Three-tier persistence overview
6. `docs/architecture/04-orientation-and-zoom.md` — Orientation store split (PR #9)
7. Web Dev Simplified, "Why Does No One Use The Right React Hook" (2026-04-07)
