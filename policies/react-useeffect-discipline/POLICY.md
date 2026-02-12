# React useEffect Discipline

**Version 1.0.0**
February 2026

> **Note:**
> This document is mainly for agents and LLMs to follow when maintaining,
> generating, or refactoring React codebases. Humans may also find it useful,
> but guidance here is optimized for automation and consistency by AI-assisted
> workflows.

> **Companion Policy:**
> This policy complements `vercel-react-best-practices/POLICY.md`. Rules
> already covered there (derived state during render, narrow effect
> dependencies, interaction logic in event handlers, app init once, and
> useEffectEvent) are cross-referenced but not duplicated here. This policy
> extends coverage to the full set of useEffect anti-patterns documented at
> [react.dev/learn/you-might-not-need-an-effect](https://react.dev/learn/you-might-not-need-an-effect).

---

## Abstract

Effects are an escape hatch from the React paradigm for synchronizing with external systems (browser APIs, third-party widgets, network). When used for anything else — derived state, event responses, computation chains, parent notification — they introduce unnecessary render cycles, race conditions, and code that is harder to reason about. This policy provides 15 rules across 4 categories to eliminate misuse and ensure every `useEffect` in the codebase has a legitimate external-system justification.

---

## Table of Contents

1. [Unnecessary Effects](#1-unnecessary-effects) — **CRITICAL**
   - 1.1 [Do Not Derive State in Effects](#11-do-not-derive-state-in-effects)
   - 1.2 [Use useMemo for Expensive Computations, Not Effects](#12-use-usememo-for-expensive-computations-not-effects)
   - 1.3 [Reset Component State with key, Not Effects](#13-reset-component-state-with-key-not-effects)
   - 1.4 [Adjust State During Rendering, Not in Effects](#14-adjust-state-during-rendering-not-in-effects)
   - 1.5 [Handle User Events in Event Handlers, Not Effects](#15-handle-user-events-in-event-handlers-not-effects)
   - 1.6 [Do Not Send POST Requests from Effects](#16-do-not-send-post-requests-from-effects)
2. [Effect Chains and Data Flow](#2-effect-chains-and-data-flow) — **HIGH**
   - 2.1 [Eliminate Effect Chains](#21-eliminate-effect-chains)
   - 2.2 [Do Not Notify Parents via Effects](#22-do-not-notify-parents-via-effects)
   - 2.3 [Prefer Controlled Components Over Effect Sync](#23-prefer-controlled-components-over-effect-sync)
3. [Effect Hygiene](#3-effect-hygiene) — **HIGH**
   - 3.1 [Always Clean Up Side Effects](#31-always-clean-up-side-effects)
   - 3.2 [Handle Data Fetching Race Conditions](#32-handle-data-fetching-race-conditions)
   - 3.3 [Use useSyncExternalStore for Store Subscriptions](#33-use-usesyncexternalstore-for-store-subscriptions)
4. [Dependency Array Correctness](#4-dependency-array-correctness) — **MEDIUM**
   - 4.1 [Never Lie About Dependencies](#41-never-lie-about-dependencies)
   - 4.2 [Narrow Dependencies to Primitives](#42-narrow-dependencies-to-primitives)
   - 4.3 [Avoid Object and Function Dependencies](#43-avoid-object-and-function-dependencies)

---

## Decision Framework

Before writing `useEffect`, answer this question:

**"Why does this code need to run?"**

| Answer | Correct Location |
|--------|-----------------|
| Component was **displayed** to user | Effect (synchronize with external system) |
| User **clicked a button** or interacted | Event handler |
| Value can be **calculated** from props/state | Render body (derived value) |
| Calculation is **expensive** | `useMemo` |
| State must **reset** for a semantically different entity | `key` prop |
| Subscribing to an **external store** | `useSyncExternalStore` |

If none of the Effect criteria apply, you do not need an Effect.

---

## 1. Unnecessary Effects

**Impact: CRITICAL**

The most common useEffect mistakes are using Effects for work that belongs in the render phase or in event handlers. Each unnecessary Effect adds at least one extra render cycle.

### 1.1 Do Not Derive State in Effects

**Impact: HIGH (eliminates redundant render cycles)**

If a value can be computed from existing props or state, calculate it during rendering. Do not store it in state or update it in an Effect.

**Why it matters:** An Effect that calls `setState` triggers a second render pass. React renders with the stale value, commits to DOM, then runs the Effect which updates state, causing another render. The user briefly sees the stale value.

**Incorrect: redundant state and Effect**

```tsx
function TodoList({ todos, filter }: Props) {
  const [filteredTodos, setFilteredTodos] = useState<Todo[]>([]);

  useEffect(() => {
    setFilteredTodos(todos.filter((t) => t.status === filter));
  }, [todos, filter]);

  return <ul>{filteredTodos.map((t) => <TodoItem key={t.id} todo={t} />)}</ul>;
}
```

**Correct: derive during render**

```tsx
function TodoList({ todos, filter }: Props) {
  const filteredTodos = todos.filter((t) => t.status === filter);

  return <ul>{filteredTodos.map((t) => <TodoItem key={t.id} todo={t} />)}</ul>;
}
```

Cross-reference: Vercel React Best Practices, Rule 5.1 — Calculate Derived State During Rendering.

Reference: [react.dev/learn/you-might-not-need-an-effect#updating-state-based-on-props-or-state](https://react.dev/learn/you-might-not-need-an-effect#updating-state-based-on-props-or-state)

### 1.2 Use useMemo for Expensive Computations, Not Effects

**Impact: HIGH (eliminates redundant render cycle for expensive work)**

If a computation is expensive (>1ms), memoize it with `useMemo`. Do not store the result in state and compute it inside an Effect.

**How to decide:** If the total logged time is under 1ms, a plain derived value (Rule 1.1) is fine. If over 1ms, wrap in `useMemo`.

```tsx
// Measure first
console.time("filter");
const visibleTodos = getFilteredTodos(todos, filter);
console.timeEnd("filter");
```

**Incorrect: Effect + state for caching**

```tsx
function TodoList({ todos, filter }: Props) {
  const [visibleTodos, setVisibleTodos] = useState<Todo[]>([]);

  useEffect(() => {
    setVisibleTodos(getFilteredTodos(todos, filter));
  }, [todos, filter]);

  return <TodoTable items={visibleTodos} />;
}
```

**Correct: useMemo**

```tsx
function TodoList({ todos, filter }: Props) {
  const visibleTodos = useMemo(
    () => getFilteredTodos(todos, filter),
    [todos, filter],
  );

  return <TodoTable items={visibleTodos} />;
}
```

> **Note:** If React Compiler is enabled, the compiler handles memoization automatically. Manual `useMemo` is still acceptable but may be redundant.

Reference: [react.dev/learn/you-might-not-need-an-effect#caching-expensive-calculations](https://react.dev/learn/you-might-not-need-an-effect#caching-expensive-calculations)

### 1.3 Reset Component State with key, Not Effects

**Impact: HIGH (eliminates render with stale state)**

When a prop change means the component represents a semantically different entity (different user, different conversation, different document), use a `key` to reset state. Do not reset state in an Effect.

**Why it matters:** With an Effect, the component first renders with stale state (e.g., the previous user's comment draft), commits that to the DOM, then the Effect fires and clears state, causing a second render. The user may see a flash of incorrect content.

**Incorrect: Effect to reset state on prop change**

```tsx
function ProfilePage({ userId }: { userId: string }) {
  const [comment, setComment] = useState("");

  useEffect(() => {
    setComment("");
  }, [userId]);

  return <Comment value={comment} onChange={setComment} />;
}
```

**Correct: key forces remount with fresh state**

```tsx
function ProfilePage({ userId }: { userId: string }) {
  return <ProfileContent userId={userId} key={userId} />;
}

function ProfileContent({ userId }: { userId: string }) {
  const [comment, setComment] = useState("");
  return <Comment value={comment} onChange={setComment} />;
}
```

React destroys and recreates `ProfileContent` (and all children) when `key` changes, so all state resets naturally. This is the React-recommended pattern.

Reference: [react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes](https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes)

### 1.4 Adjust State During Rendering, Not in Effects

**Impact: MEDIUM (avoids extra render pass for partial state adjustments)**

When only part of the state needs to update in response to a prop change (not a full reset), derive the new value or adjust state during rendering. As a last resort, use the "previous value" pattern. Do not use an Effect.

**Incorrect: Effect to adjust selection on list change**

```tsx
function List({ items }: { items: Item[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [items]);

  // ...
}
```

**Correct (best): derive selection from current data**

```tsx
function List({ items }: { items: Item[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Selection is derived: if the selected item no longer exists, it's null
  const selection = items.find((item) => item.id === selectedId) ?? null;

  // ...
}
```

**Correct (acceptable): adjust during rendering with previous-value pattern**

```tsx
function List({ items }: { items: Item[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prevItems, setPrevItems] = useState(items);

  if (items !== prevItems) {
    setPrevItems(items);
    setSelectedId(null);
  }

  // ...
}
```

> **Note:** The previous-value pattern is harder to understand and should only be used when derivation (the preferred approach above) is not possible. React will immediately re-render the component with updated state, so children never see the intermediate value.

Reference: [react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)

### 1.5 Handle User Events in Event Handlers, Not Effects

**Impact: HIGH (prevents duplicate side effects and stale triggers)**

If code runs because a user did something (clicked, submitted, typed), it belongs in the event handler for that action. Do not model user actions as state changes that trigger Effects.

**The test:** Ask "Why does this code run?" If the answer is "because the user clicked a button," it does not belong in an Effect. Effects run because a component was displayed, not because a user interacted.

**Incorrect: user action modeled as state + Effect**

```tsx
function ProductPage({ product, addToCart }: Props) {
  useEffect(() => {
    if (product.isInCart) {
      showNotification(`Added ${product.name} to cart!`);
    }
  }, [product]);

  function handleBuy() {
    addToCart(product);
  }

  // ...
}
```

**Why this is wrong:** The notification fires on page reload if the product was already in cart. The Effect runs because the component was displayed, not because the user acted.

**Correct: side effect in event handler**

```tsx
function ProductPage({ product, addToCart }: Props) {
  function handleBuy() {
    addToCart(product);
    showNotification(`Added ${product.name} to cart!`);
  }

  // ...
}
```

**Shared logic between handlers:** Extract into a plain function, not an Effect.

```tsx
function ProductPage({ product, addToCart }: Props) {
  function buyProduct() {
    addToCart(product);
    showNotification(`Added ${product.name} to cart!`);
  }

  function handleBuyClick() {
    buyProduct();
  }

  function handleCheckoutClick() {
    buyProduct();
    navigateTo("/checkout");
  }
}
```

Cross-reference: Vercel React Best Practices, Rule 5.7 — Put Interaction Logic in Event Handlers.

Reference: [react.dev/learn/you-might-not-need-an-effect#sharing-logic-between-event-handlers](https://react.dev/learn/you-might-not-need-an-effect#sharing-logic-between-event-handlers)

### 1.6 Do Not Send POST Requests from Effects

**Impact: HIGH (prevents duplicate submissions)**

Form submissions and mutations are user-initiated actions. Do not route them through state + Effect. Only analytics and logging (which run because the component was displayed) belong in Effects.

**Incorrect: form submission in Effect**

```tsx
function Form() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [jsonToSubmit, setJsonToSubmit] = useState<object | null>(null);

  useEffect(() => {
    if (jsonToSubmit !== null) {
      post("/api/register", jsonToSubmit);
    }
  }, [jsonToSubmit]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setJsonToSubmit({ firstName, lastName });
  }
}
```

**Correct: separate concerns**

```tsx
function Form() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Analytics: runs because component was displayed — Effect is correct
  useEffect(() => {
    post("/analytics/event", { eventName: "visit_form" });
  }, []);

  // Submission: runs because user clicked submit — event handler is correct
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    post("/api/register", { firstName, lastName });
  }
}
```

Reference: [react.dev/learn/you-might-not-need-an-effect#sending-a-post-request](https://react.dev/learn/you-might-not-need-an-effect#sending-a-post-request)

---

## 2. Effect Chains and Data Flow

**Impact: HIGH**

Cascading Effects and upward data flow via Effects create fragile, hard-to-debug code with unpredictable render sequences.

### 2.1 Eliminate Effect Chains

**Impact: HIGH (prevents cascading render cycles)**

If one Effect sets state that triggers another Effect, which sets state that triggers yet another, you have an Effect chain. Each link adds a full render cycle.

**Incorrect: chain of Effects**

```tsx
function Game() {
  const [card, setCard] = useState<Card | null>(null);
  const [goldCardCount, setGoldCardCount] = useState(0);
  const [round, setRound] = useState(1);
  const [isGameOver, setIsGameOver] = useState(false);

  // Chain link 1
  useEffect(() => {
    if (card !== null && card.gold) {
      setGoldCardCount((c) => c + 1);
    }
  }, [card]);

  // Chain link 2
  useEffect(() => {
    if (goldCardCount > 3) {
      setRound((r) => r + 1);
      setGoldCardCount(0);
    }
  }, [goldCardCount]);

  // Chain link 3
  useEffect(() => {
    if (round > 5) {
      setIsGameOver(true);
    }
  }, [round]);

  // ...
}
```

**Why this is wrong:** Playing one card triggers 3 sequential render passes. The logic is scattered across Effects, making it hard to trace what happens when a card is played.

**Correct: compute next state in the event handler**

```tsx
function Game() {
  const [card, setCard] = useState<Card | null>(null);
  const [goldCardCount, setGoldCardCount] = useState(0);
  const [round, setRound] = useState(1);

  // Derived — no state needed
  const isGameOver = round > 5;

  function handlePlaceCard(nextCard: Card) {
    if (isGameOver) {
      throw new Error("Game already ended.");
    }

    setCard(nextCard);

    if (nextCard.gold) {
      if (goldCardCount < 3) {
        setGoldCardCount(goldCardCount + 1);
      } else {
        setGoldCardCount(0);
        setRound(round + 1);
        if (round === 5) {
          alert("Good game!");
        }
      }
    }
  }
}
```

All state updates happen in one event handler, resulting in a single render pass. `isGameOver` is derived, not stored.

Reference: [react.dev/learn/you-might-not-need-an-effect#chains-of-computations](https://react.dev/learn/you-might-not-need-an-effect#chains-of-computations)

### 2.2 Do Not Notify Parents via Effects

**Impact: MEDIUM (prevents render cascades across component boundaries)**

Do not use an Effect to "push" data or events up to a parent component. Update both local state and parent callback in the same event handler.

**Incorrect: Effect notifies parent after state change**

```tsx
function Toggle({ onChange }: { onChange: (isOn: boolean) => void }) {
  const [isOn, setIsOn] = useState(false);

  useEffect(() => {
    onChange(isOn);
  }, [isOn, onChange]);

  function handleClick() {
    setIsOn(!isOn);
  }

  return <button onClick={handleClick}>{isOn ? "On" : "Off"}</button>;
}
```

**Why this is wrong:** The parent's `onChange` fires too late (after Toggle re-renders and the Effect runs). If the parent updates its own state in `onChange`, that triggers yet another render pass, creating a cascade.

**Correct: update both in the event handler**

```tsx
function Toggle({ onChange }: { onChange: (isOn: boolean) => void }) {
  const [isOn, setIsOn] = useState(false);

  function handleClick() {
    const nextIsOn = !isOn;
    setIsOn(nextIsOn);
    onChange(nextIsOn);
  }

  return <button onClick={handleClick}>{isOn ? "On" : "Off"}</button>;
}
```

React batches all state updates from event handlers into a single render pass, so both the Toggle and parent update together.

Reference: [react.dev/learn/you-might-not-need-an-effect#notifying-parent-components-about-state-changes](https://react.dev/learn/you-might-not-need-an-effect#notifying-parent-components-about-state-changes)

### 2.3 Prefer Controlled Components Over Effect Sync

**Impact: MEDIUM (simplifies data flow, eliminates synchronization bugs)**

When a parent needs to control a child's state, lift the state up rather than syncing two sources of truth with Effects.

**Incorrect: two sources of truth synced by Effects**

```tsx
// Parent stores `isOpen`, child stores `isOn`, Effects keep them in sync
function Parent() {
  const [isOpen, setIsOpen] = useState(false);

  return <Toggle isOn={isOpen} onChange={setIsOpen} />;
}

function Toggle({ isOn, onChange }: Props) {
  const [internalIsOn, setInternalIsOn] = useState(isOn);

  useEffect(() => {
    setInternalIsOn(isOn);
  }, [isOn]);

  useEffect(() => {
    onChange(internalIsOn);
  }, [internalIsOn, onChange]);

  // ...
}
```

**Correct: fully controlled component**

```tsx
function Parent() {
  const [isOpen, setIsOpen] = useState(false);

  return <Toggle isOn={isOpen} onChange={setIsOpen} />;
}

function Toggle({ isOn, onChange }: { isOn: boolean; onChange: (v: boolean) => void }) {
  function handleClick() {
    onChange(!isOn);
  }

  return <button onClick={handleClick}>{isOn ? "On" : "Off"}</button>;
}
```

Single source of truth, no synchronization needed.

Reference: [react.dev/learn/you-might-not-need-an-effect#passing-data-to-the-parent](https://react.dev/learn/you-might-not-need-an-effect#passing-data-to-the-parent)

---

## 3. Effect Hygiene

**Impact: HIGH**

When Effects are legitimate (synchronizing with external systems), they must be written correctly to avoid resource leaks and race conditions.

### 3.1 Always Clean Up Side Effects

**Impact: HIGH (prevents memory leaks and stale listeners)**

Every Effect that creates a subscription, listener, timer, or connection must return a cleanup function that tears it down.

**Why it matters:** React may unmount and remount components (navigation, conditional rendering, Strict Mode in development). Without cleanup, each mount adds another listener/timer without removing the previous one.

**Incorrect: no cleanup**

```tsx
useEffect(() => {
  const id = setInterval(() => {
    setCount((c) => c + 1);
  }, 1000);
  // Missing cleanup — interval survives unmount
}, []);
```

**Correct: cleanup returned**

```tsx
useEffect(() => {
  const id = setInterval(() => {
    setCount((c) => c + 1);
  }, 1000);

  return () => clearInterval(id);
}, []);
```

**Cleanup checklist:**

| Side effect | Cleanup |
|-------------|---------|
| `addEventListener` | `removeEventListener` |
| `setInterval` / `setTimeout` | `clearInterval` / `clearTimeout` |
| `new WebSocket()` | `socket.close()` |
| `new IntersectionObserver()` | `observer.disconnect()` |
| `fetch` (via AbortController) | `controller.abort()` |
| Third-party widget init | Widget destroy/dispose method |

Reference: [react.dev/learn/synchronizing-with-effects#how-to-handle-the-effect-firing-twice-in-development](https://react.dev/learn/synchronizing-with-effects#how-to-handle-the-effect-firing-twice-in-development)

### 3.2 Handle Data Fetching Race Conditions

**Impact: HIGH (prevents displaying stale data)**

When fetching data in an Effect, always guard against stale responses using a cleanup flag or AbortController. Without this, a slow response for a previous query can overwrite the results of a newer query.

**Scenario:** User types "hello" quickly. Fetches fire for "h", "he", "hel", "hell", "hello". If "hell" returns after "hello", stale results are displayed.

**Incorrect: no race condition handling**

```tsx
useEffect(() => {
  fetchResults(query).then((json) => {
    setResults(json);
  });
}, [query]);
```

**Correct: ignore flag pattern**

```tsx
useEffect(() => {
  let ignore = false;

  fetchResults(query).then((json) => {
    if (!ignore) {
      setResults(json);
    }
  });

  return () => {
    ignore = true;
  };
}, [query]);
```

**Correct: AbortController pattern**

```tsx
useEffect(() => {
  const controller = new AbortController();

  fetch(`/api/search?q=${query}`, { signal: controller.signal })
    .then((res) => res.json())
    .then((json) => setResults(json))
    .catch((err) => {
      if (err.name !== "AbortError") {
        setError(err);
      }
    });

  return () => controller.abort();
}, [query]);
```

**Best practice:** Extract data fetching into a custom hook or use a framework-provided mechanism (e.g., Convex `useQuery`, SWR, React Query) that handles race conditions automatically.

Reference: [react.dev/learn/you-might-not-need-an-effect#fetching-data](https://react.dev/learn/you-might-not-need-an-effect#fetching-data)

### 3.3 Use useSyncExternalStore for Store Subscriptions

**Impact: MEDIUM (prevents tearing and simplifies subscription code)**

When subscribing to an external data source (browser APIs, third-party state libraries, custom event emitters), use `useSyncExternalStore` instead of manually wiring `addEventListener` + `setState` inside an Effect.

**Incorrect: manual subscription in Effect**

```tsx
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
}
```

**Correct: useSyncExternalStore**

```tsx
function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function useOnlineStatus() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine, // client snapshot
    () => true,             // server snapshot
  );
}
```

**Why `useSyncExternalStore` is better:**
- Prevents tearing (inconsistent UI during concurrent rendering)
- Handles server-side rendering via the server snapshot
- Cleaner API — subscribe once, React manages the rest

Reference: [react.dev/learn/you-might-not-need-an-effect#subscribing-to-an-external-store](https://react.dev/learn/you-might-not-need-an-effect#subscribing-to-an-external-store)

---

## 4. Dependency Array Correctness

**Impact: MEDIUM**

A correct dependency array is the contract between your Effect and React's scheduler. Incorrect dependencies cause stale closures, infinite loops, or skipped updates.

### 4.1 Never Lie About Dependencies

**Impact: HIGH (prevents stale closures and skipped updates)**

The dependency array must include every reactive value (props, state, values derived from them) read inside the Effect. Do not suppress the `react-hooks/exhaustive-deps` lint rule. Disabling this rule is the single most common source of useEffect bugs.

**What is a stale closure?** When an Effect runs, React captures ("closes over") the values of all variables referenced inside it. If a dependency is omitted from the array, the Effect never re-runs when that value changes, so the captured value is frozen at its initial value forever. This is called a stale closure.

**Incorrect: missing dependency creates stale closure**

```tsx
useEffect(() => {
  const id = setInterval(() => {
    setCount(count + 1); // Reads `count` but doesn't list it
  }, 1000);

  return () => clearInterval(id);
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```

**Why this is wrong:** `count` is captured as `0` when the Effect first runs. The interval always computes `0 + 1 = 1`. The counter displays 1 and stays there forever, even though `setCount` is called every second.

**Correct: use functional updater to remove the dependency**

```tsx
useEffect(() => {
  const id = setInterval(() => {
    setCount((c) => c + 1); // Functional updater reads latest value
  }, 1000);

  return () => clearInterval(id);
}, []);
```

The functional form `(c) => c + 1` does not read `count` from the closure, so the dependency is genuinely not needed.

**Rules:**
- If removing a dependency causes the Effect to behave incorrectly, the fix is to change the Effect code so the dependency is genuinely not needed — not to remove it from the array.
- Never use `// eslint-disable-next-line react-hooks/exhaustive-deps` to silence dependency warnings. If the lint rule complains, the Effect logic needs restructuring.
- If you need a callback to see the latest values but want the Effect to run only on mount, use `useEffectEvent` (see Rule 4.3 and Vercel React Best Practices Rule 8.3).

Cross-reference: Vercel React Best Practices, Rule 5.9 — Use Functional setState Updates.

Reference: [react.dev/learn/removing-effect-dependencies](https://react.dev/learn/removing-effect-dependencies)

### 4.2 Narrow Dependencies to Primitives

**Impact: LOW-MEDIUM (minimizes Effect re-runs)**

Specify primitive values in the dependency array instead of objects. Objects create new references on every render, causing the Effect to re-run even when the relevant data hasn't changed.

**Incorrect: re-runs on any user field change**

```tsx
useEffect(() => {
  logVisit(user.id);
}, [user]); // Re-runs when user.name, user.email, etc. change
```

**Correct: depends only on what's used**

```tsx
useEffect(() => {
  logVisit(user.id);
}, [user.id]);
```

Cross-reference: Vercel React Best Practices, Rule 5.6 — Narrow Effect Dependencies.

### 4.3 Avoid Object and Function Dependencies

**Impact: MEDIUM (prevents infinite re-run loops)**

Objects and functions created during rendering get new references every render. Including them in a dependency array can cause the Effect to re-run every render, potentially creating an infinite loop.

**Incorrect: object created during render as dependency**

```tsx
function ChatRoom({ roomId }: { roomId: string }) {
  const options = { serverUrl: "https://chat.example.com", roomId };

  useEffect(() => {
    const connection = createConnection(options);
    connection.connect();
    return () => connection.disconnect();
  }, [options]); // New object every render — Effect re-runs every render
}
```

**Correct: move object creation inside Effect**

```tsx
function ChatRoom({ roomId }: { roomId: string }) {
  useEffect(() => {
    const options = { serverUrl: "https://chat.example.com", roomId };
    const connection = createConnection(options);
    connection.connect();
    return () => connection.disconnect();
  }, [roomId]); // Primitive dependency — stable
}
```

**For function dependencies, prefer these approaches in order:**

1. **Move the function inside the Effect** — If the function is only used by this Effect, define it inside. This eliminates the dependency entirely and makes the Effect self-contained.

```tsx
// Incorrect: function defined outside, unstable reference
function ChatRoom({ roomId }: { roomId: string }) {
  function createOptions() {
    return { serverUrl: "https://chat.example.com", roomId };
  }

  useEffect(() => {
    const options = createOptions();
    const connection = createConnection(options);
    connection.connect();
    return () => connection.disconnect();
  }, [createOptions]); // New function every render
}

// Correct: function moved inside Effect
function ChatRoom({ roomId }: { roomId: string }) {
  useEffect(() => {
    function createOptions() {
      return { serverUrl: "https://chat.example.com", roomId };
    }

    const options = createOptions();
    const connection = createConnection(options);
    connection.connect();
    return () => connection.disconnect();
  }, [roomId]); // Only depends on the primitive roomId
}
```

2. **Use `useEffectEvent`** (React 19+) — When a callback prop must be called from inside the Effect but should not trigger re-subscription. This creates a stable reference that always reads the latest value.

```tsx
import { useEffectEvent } from "react";

function ChatRoom({ roomId, onMessage }: Props) {
  const onMsg = useEffectEvent(onMessage);

  useEffect(() => {
    const connection = createConnection(roomId);
    connection.on("message", onMsg);
    connection.connect();
    return () => connection.disconnect();
  }, [roomId]); // onMsg is stable, not a dependency
}
```

Cross-reference: Vercel React Best Practices, Rule 8.3 — useEffectEvent for Stable Callback Refs.

Reference: [react.dev/learn/removing-effect-dependencies#does-some-reactive-value-change-unintentionally](https://react.dev/learn/removing-effect-dependencies#does-some-reactive-value-change-unintentionally)

---

## Quick Reference: Do You Need useEffect?

| Scenario | useEffect? | Instead |
|----------|-----------|---------|
| Combine two pieces of state | No | Derive during render |
| Filter or transform a list | No | Derive during render (or `useMemo`) |
| Reset state when a prop changes | No | `key` prop |
| Adjust partial state on prop change | No | Derive, or adjust during render |
| Respond to a user click | No | Event handler |
| Submit a form | No | Event handler |
| Chain multiple state updates | No | Single event handler |
| Notify parent of state change | No | Call parent callback in event handler |
| Fetch data from an API | Yes | Effect with cleanup (or framework hook) |
| Subscribe to browser events | Yes | `useSyncExternalStore` preferred |
| Set up a timer or interval | Yes | Effect with cleanup |
| Sync with a third-party widget | Yes | Effect with cleanup |
| Track page view analytics | Yes | Effect with `[]` deps |

---

## References

1. [react.dev — You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
2. [react.dev — Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
3. [react.dev — Removing Effect Dependencies](https://react.dev/learn/removing-effect-dependencies)
4. [react.dev — Lifecycle of Reactive Effects](https://react.dev/learn/lifecycle-of-reactive-effects)
5. Vercel React Best Practices (companion policy: `vercel-react-best-practices/POLICY.md`)
