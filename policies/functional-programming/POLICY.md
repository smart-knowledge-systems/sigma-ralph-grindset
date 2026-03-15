# Functional Programming Policy

Language-agnostic functional programming patterns and best practices.
Use these rules to evaluate whether code follows FP principles for correctness, composability, and maintainability.

---

## 1. Write Pure Functions

- A function MUST return the same output for the same input and produce no side effects.
- Do NOT read or write global/shared mutable state, perform I/O, or throw exceptions inside pure functions.
- Pure functions are trivially testable, cacheable, and parallelizable.

**Incorrect: impure function**

```
count = 0
function increment(x):
    count = count + 1    // side effect: mutates external state
    return x + count     // output depends on external state
```

**Correct: pure function**

```
function add(x, y):
    return x + y
```

## 2. Treat Data as Immutable

- Never mutate data in place. Always return new values.
- Mutation introduces temporal coupling — the meaning of a variable depends on *when* you read it, not just *what* it is.
- If a data structure needs to change, produce a new copy with the changes applied.

**Incorrect: in-place mutation**

```
function addItem(list, item):
    list.push(item)      // mutates the original list
    return list
```

**Correct: return new value**

```
function addItem(list, item):
    return [...list, item]
```

## 3. Use First-Class and Higher-Order Functions

- Pass functions as arguments, return them from other functions, and assign them to variables.
- Prefer higher-order functions (`map`, `filter`, `reduce`) over imperative loops.
- Extract reusable behavior into small, composable functions rather than duplicating logic.

**Incorrect: imperative loop**

```
results = []
for item in items:
    if item.active:
        results.push(item.name)
```

**Correct: higher-order functions**

```
results = items
    .filter(item => item.active)
    .map(item => item.name)
```

## 4. Maintain Referential Transparency

- Any expression MUST be replaceable with its evaluated value without changing program behavior.
- If `f(3)` returns `7`, then every occurrence of `f(3)` can be swapped for `7`.
- Referential transparency follows naturally from pure functions and immutability. If code violates this property, it contains hidden state or side effects.

## 5. Compose Small Functions

- Build complex behavior by combining small, single-purpose functions.
- Prefer `compose(f, g)` or `pipe(f, g)` over nesting calls like `f(g(x))`.
- Each function in a composition should do one thing and do it well.

**Incorrect: monolithic function**

```
function processOrder(order):
    validated = validateFields(order)
    if not validated: throw Error
    normalized = lowercase(order.email)
    order.email = normalized
    tax = order.total * 0.08
    order.total = order.total + tax
    save(order)
    sendEmail(order)
    return order
```

**Correct: composable pipeline**

```
processOrder = pipe(
    validate,
    normalizeEmail,
    applyTax(0.08),
    persistAndNotify
)
```

## 6. Use Currying and Partial Application

- Transform multi-argument functions into chains of single-argument functions to enable reuse and composition.
- Partial application fixes some arguments upfront, producing a specialized function.
- Data-last argument order enables cleaner composition and piping.

```
// Curried
multiply = a => b => a * b
double = multiply(2)
double(5)  // 10

// Partial application
applyTax = rate => amount => amount * (1 + rate)
applyVAT = applyTax(0.20)
```

## 7. Model Data with Algebraic Data Types

- Use **sum types** (tagged unions / discriminated unions) to represent values that can be one of several shapes.
- Use **product types** (records / tuples) to represent values that combine several fields.
- Sum types make illegal states unrepresentable — the type system enforces which variants exist.

```
// Sum type: a value is exactly one of these
type Result = Ok(value) | Err(error)
type Option = Some(value) | None

// Product type: a value contains all of these
type User = { name: string, email: string, role: Role }
```

## 8. Handle Errors as Values, Not Exceptions

- Do NOT use exceptions for expected failure paths (validation errors, missing data, API failures).
- Return `Result` / `Either` types that encode success or failure in the type system.
- The caller is forced to handle both cases — errors cannot be silently ignored.

**Incorrect: exception-based control flow**

```
function parseAge(input):
    n = parseInt(input)
    if isNaN(n): throw Error("not a number")
    if n < 0: throw Error("negative age")
    return n
```

**Correct: error as value**

```
function parseAge(input):
    n = parseInt(input)
    if isNaN(n): return Err("not a number")
    if n < 0: return Err("negative age")
    return Ok(n)
```

## 9. Push Side Effects to the Edges

- Structure programs as a pure core surrounded by an impure shell.
- The core computes decisions; the shell executes them (I/O, network, database, logging).
- This maximizes the testable, composable portion of the codebase.

```
// Pure core: decides what to do
function decideAction(state, event):
    return { action: "sendEmail", to: state.user.email, body: "..." }

// Impure shell: does it
function execute(decision):
    if decision.action == "sendEmail":
        emailService.send(decision.to, decision.body)
```

## 10. Make Data Transformations Explicit via Pipelines

- Express data transformations as a sequence of named steps, not nested calls or temporary variables.
- Pipelines read top-to-bottom (or left-to-right) and each step is independently testable.

**Incorrect: nested calls**

```
result = sort(unique(filter(data, isActive)))
```

**Correct: pipeline**

```
result = pipe(data,
    filter(isActive),
    unique,
    sort
)
```

## 11. Prefer Recursion Over Imperative Loops

- Express iterative logic as recursive functions where the language supports it.
- Use tail-recursive style when possible to avoid stack overflow.
- For languages without tail-call optimization, prefer higher-order functions (`map`, `fold`, `reduce`) over manual recursion.

**Note:** Not all languages optimize tail calls. Know your runtime's capabilities and fall back to `reduce`/`fold` when recursion depth is unbounded.

## 12. Use Pattern Matching for Exhaustive Case Analysis

- When branching on a sum type, use pattern matching to handle every variant.
- The compiler or linter should error if a variant is unhandled.
- Prefer pattern matching over chains of `if/else` or `switch` without exhaustiveness checks.

```
function describe(result):
    match result:
        Ok(value) => "Success: " + value
        Err(error) => "Failed: " + error
// Adding a new variant forces updating every match site
```

## 13. Understand Functors, Applicatives, and Monads

- A **Functor** lets you apply a function to a wrapped value (`map`).
- An **Applicative** lets you apply a wrapped function to a wrapped value.
- A **Monad** lets you chain operations that return wrapped values (`flatMap` / `bind`).
- These abstractions compose naturally — use them to handle nullability, errors, async, and collections uniformly.

**Practical minimum:** understand `map` and `flatMap` on `Option`, `Result`, and collections. Advanced usage (monad transformers, free monads) is optional and should be adopted only when the team has sufficient familiarity.

---

## Decision Framework

Before writing a function, ask:

| Question | If Yes |
|----------|--------|
| Does this function read or write external state? | Push the side effect to the boundary; keep the core pure |
| Does this mutate its input? | Return a new value instead |
| Does this throw for expected failures? | Return a `Result`/`Either` |
| Does this do more than one thing? | Split into composable pieces |
| Is this a chain of `if/else` on a type tag? | Use pattern matching |
| Is this a loop with an accumulator? | Use `reduce`/`fold` or recursion |

---

## References

1. [Structure and Interpretation of Computer Programs](https://mitpress.mit.edu/sites/default/files/sicp/full-text/book/book.html)
2. [Mostly Adequate Guide to Functional Programming](https://mostly-adequate.gitbook.io/mostly-adequate-guide)
3. [Functional Core, Imperative Shell (Gary Bernhardt)](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)
