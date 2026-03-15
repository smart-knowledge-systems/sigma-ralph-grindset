---
applies_when:
  file_extensions: [ts, tsx, js, jsx]
---

# TypeScript FP Addendum

TypeScript-specific functional programming guidance and library recommendations.
This addendum extends `POLICY.md` with concrete TypeScript patterns, language features, and known limitations.

---

## 1. Enforce Immutability at Compile Time

- Use `readonly` on all properties that should not change after construction.
- Use `ReadonlyArray<T>` (or `readonly T[]`) instead of `T[]` for arrays that must not be mutated.
- Use `as const` assertions to narrow literals and freeze object shapes.
- `Readonly<T>` is shallow — for nested immutability, use `DeepReadonly` from a utility library or define your own.

**Incorrect: mutable by default**

```ts
interface Config {
  port: number;
  hosts: string[];
}
```

**Correct: immutable by default**

```ts
interface Config {
  readonly port: number;
  readonly hosts: readonly string[];
}

const defaults = {
  port: 3000,
  hosts: ["localhost"],
} as const;
```

**Limitation:** `readonly` is compile-time only. Runtime code can still mutate via `as any` or unchecked casts. Do not rely on `readonly` as a security boundary — it is a correctness aid for authors, not a runtime guarantee.

## 2. Model Sum Types with Discriminated Unions

- Use a literal `tag` (or `kind`, `type`) field as the discriminant.
- Every variant MUST include the discriminant field.
- Use exhaustive `switch` or pattern matching to handle all variants.

```ts
type Result<T, E> =
  | { readonly tag: "ok"; readonly value: T }
  | { readonly tag: "err"; readonly error: E };

function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  switch (result.tag) {
    case "ok":
      return result.value;
    case "err":
      return fallback;
  }
}
```

**Exhaustiveness check with `never`:**

```ts
function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

function handle(result: Result<string, Error>): string {
  switch (result.tag) {
    case "ok":
      return result.value;
    case "err":
      return result.error.message;
    default:
      return assertNever(result);
  }
}
```

Adding a new variant to `Result` will cause a compile error at every `assertNever` call site that does not handle it.

## 3. Build Pipelines with `pipe`

- Use a `pipe` utility to chain transformations left-to-right.
- Each step should be a pure function with a clear, single responsibility.
- Data-last argument order enables point-free style in pipelines.

```ts
// Minimal pipe implementation
function pipe<A>(a: A): A;
function pipe<A, B>(a: A, ab: (a: A) => B): B;
function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
function pipe(a: unknown, ...fns: Array<(x: unknown) => unknown>): unknown {
  return fns.reduce((v, f) => f(v), a);
}

// Usage
const result = pipe(
  rawInput,
  parseInput,
  validate,
  transform,
  serialize,
);
```

**Note:** TC39 pipeline operator (`|>`) is not yet standardized. Use a library `pipe` until it lands.

## 4. Use Currying for Reusable Transforms

```ts
const filter =
  <T>(predicate: (item: T) => boolean) =>
  (items: readonly T[]): readonly T[] =>
    items.filter(predicate);

const map =
  <A, B>(fn: (a: A) => B) =>
  (items: readonly A[]): readonly B[] =>
    items.map(fn);

// Compose into a pipeline
const activeNames = pipe(
  users,
  filter((u: User) => u.active),
  map((u: User) => u.name),
);
```

## 5. Handle Errors with Result Types

- Do NOT throw for expected failures (validation, parsing, API errors).
- Define a `Result<T, E>` type and use it as the return type for fallible operations.
- Chain results with `map` and `flatMap` helpers.

```ts
type Result<T, E> =
  | { readonly tag: "ok"; readonly value: T }
  | { readonly tag: "err"; readonly error: E };

const ok = <T>(value: T): Result<T, never> => ({ tag: "ok", value });
const err = <E>(error: E): Result<never, E> => ({ tag: "err", error });

const mapResult = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> =>
  result.tag === "ok" ? ok(fn(result.value)) : result;

const flatMap = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> =>
  result.tag === "ok" ? fn(result.value) : result;
```

**Usage:**

```ts
function parsePort(input: string): Result<number, string> {
  const n = Number(input);
  if (Number.isNaN(n)) return err(`"${input}" is not a number`);
  if (n < 1 || n > 65535) return err(`port ${n} out of range`);
  return ok(n);
}

const port = pipe(
  parsePort(rawPort),
  (r) => mapResult(r, (p) => p.toString()),
);
```

## 6. Use `Option` for Nullable Values

- Instead of `T | null | undefined`, use an explicit `Option<T>` when the absence of a value is semantically meaningful.
- This forces callers to handle `None` explicitly rather than forgetting a null check.

```ts
type Option<T> =
  | { readonly tag: "some"; readonly value: T }
  | { readonly tag: "none" };

const some = <T>(value: T): Option<T> => ({ tag: "some", value });
const none: Option<never> = { tag: "none" };

function find<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): Option<T> {
  const found = items.find(predicate);
  return found !== undefined ? some(found) : none;
}
```

**When to use `Option` vs `T | undefined`:** Use `Option` when the value flows through multiple transformation steps or when `undefined` is a valid domain value. Use `T | undefined` for simple, local cases where the null check is immediately adjacent.

## 7. Use Pattern Matching with `ts-pattern`

- Use `ts-pattern` for exhaustive, readable pattern matching on discriminated unions.
- Prefer `match` over chains of `if/else` or `switch` when branching on tagged types.

```ts
import { match } from "ts-pattern";

type Shape =
  | { readonly tag: "circle"; readonly radius: number }
  | { readonly tag: "rect"; readonly width: number; readonly height: number };

const area = (shape: Shape): number =>
  match(shape)
    .with({ tag: "circle" }, ({ radius }) => Math.PI * radius ** 2)
    .with({ tag: "rect" }, ({ width, height }) => width * height)
    .exhaustive();
```

## 8. Avoid Mutation in Array and Object Operations

- Use spread syntax, `Object.freeze`, or immutable update utilities.
- Never use mutating array methods (`push`, `pop`, `splice`, `sort` in-place, `reverse` in-place) on shared data.
- For sorting: `[...arr].sort(compareFn)` or `arr.toSorted(compareFn)` (ES2023+).

```ts
// Incorrect
function addUser(users: User[], user: User): User[] {
  users.push(user); // mutates input
  return users;
}

// Correct
function addUser(users: readonly User[], user: User): readonly User[] {
  return [...users, user];
}
```

## 9. Use `const` Assertions for Literal Types

```ts
// Without as const — type is { status: string; code: number }
const response = { status: "ok", code: 200 };

// With as const — type is { readonly status: "ok"; readonly code: 200 }
const response = { status: "ok", code: 200 } as const;
```

Use `as const` for:
- Configuration objects that should not change
- Lookup tables and enum-like maps
- Discriminant values in tagged unions

## 10. Leverage Template Literal Types for Refined Strings

```ts
type EventName = `${Domain}.${Action}`;
type Domain = "user" | "order" | "payment";
type Action = "created" | "updated" | "deleted";

// Only "user.created" | "user.updated" | ... | "payment.deleted" accepted
function emit(event: EventName, payload: unknown): void { /* ... */ }
```

Use template literal types to eliminate stringly-typed APIs where the set of valid strings is known at compile time.

---

## Library Recommendations

| Library | Purpose | When to Use |
|---------|---------|-------------|
| **Effect** | Unified FP runtime: typed errors, async, DI, concurrency, retries, scheduling | **Default choice.** Use Effect for any new code or module unless the codebase already uses another FP library (see guidance below). |
| **fp-ts** | Haskell-style FP primitives: `Option`, `Either`, `IO`, `Task`, `Reader` | Only if the codebase already depends on fp-ts. Do not introduce fp-ts into a codebase that does not already use it — use Effect instead. |
| **Ramda** | Auto-curried, data-last utility functions | Lightweight pipelines without adopting a full effect system. Good for pure data transformations. |
| **ts-pattern** | Exhaustive pattern matching | Any codebase using discriminated unions. Low overhead, high ergonomic value. Recommended regardless of other library choices. |

**Guidance:**

- **If the codebase does not already use an FP effect library, adopt Effect.** Effect provides typed errors, dependency injection, concurrency, retries, and resource management in a single, cohesive package with strong TypeScript inference — it supersedes fp-ts for new work.
- **If the codebase already uses fp-ts (or another FP library), continue using it.** Do not introduce Effect alongside an existing effect system. Mixing two effect runtimes creates interop friction and cognitive overhead.
- Do not adopt multiple overlapping libraries (e.g., fp-ts + Effect). Pick one effect system and use it consistently.
- `ts-pattern` and Ramda are complementary to any effect system choice and can be adopted independently.

---

## Known TypeScript Limitations

1. **No tail-call optimization.** V8/Bun do not optimize tail calls. Deep recursion will overflow the stack. Use `reduce`/`fold` or trampolines for unbounded recursion.

2. **No higher-kinded types (HKT).** TypeScript cannot natively abstract over type constructors like `Array<_>` or `Option<_>`. Libraries like fp-ts use encoding tricks (type-level maps) that work but degrade IDE support.

3. **`readonly` is compile-time only.** It prevents accidental mutation in authored code but offers no runtime protection. Code using `as any` or receiving data from untyped boundaries can still mutate.

4. **No native pattern matching.** TC39 pattern matching is Stage 1. Use `ts-pattern` or manual `switch` with `never` exhaustiveness checks.

5. **Type inference degrades in deep generic chains.** Long `pipe` chains or heavily nested generics may lose inference or produce `unknown`. Break into named intermediate types or add explicit annotations when inference fails.

6. **`Object.freeze` is shallow.** `Object.freeze(obj)` only freezes top-level properties. Nested objects remain mutable. Use recursive freeze utilities for deep immutability at runtime.

---

## Adoption Tiers

### Tier 1 — Minimum (start here)

- Pure functions with explicit inputs and outputs
- `readonly` properties and `ReadonlyArray` by default
- `Result<T, E>` for fallible operations instead of throwing
- `as const` for configuration and lookup objects
- No in-place mutation of shared data

### Tier 2 — Standard

- `pipe` for data transformation chains
- `Option<T>` for semantically meaningful absence
- Discriminated unions for domain modeling
- `ts-pattern` for exhaustive matching
- Curried utility functions for reusable transforms

### Tier 3 — Advanced

- Adopt Effect (or fp-ts) for managed side effects, dependency injection, and typed concurrency
- Model all effects explicitly (IO, Task, Stream)
- Use layers / services for dependency management
- Encode domain invariants in the type system (branded types, phantom types)

**Recommendation:** All new code should meet Tier 1. Adopt Tier 2 incrementally as the team builds familiarity. Tier 3 is optional and should only be adopted with team consensus.
