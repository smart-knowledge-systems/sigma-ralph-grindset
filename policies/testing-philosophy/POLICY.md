# Testing Philosophy Policy

Auditable rules extracted from the project's testing philosophy (`docs/testing-philosophy.md`).
Use these rules to evaluate whether tests follow pragmatic, value-driven testing practices.

---

## 1. Don't Test What TypeScript Guarantees

- Do NOT write tests that verify passing wrong argument types, missing required fields, or unexpected types.
- With `strict: true` and `noUncheckedIndexedAccess: true`, TypeScript catches these at compile time.
- Tests duplicating type-system guarantees add no value and slow down development.

## 2. Test Type System Boundaries

- DO test code that uses `as` casts, `any`, or `unknown` — TypeScript stops protecting at these points.
- DO test `JSON.parse` results, JWT payload decoding, and `.map(Number)` conversions.
- These boundaries need tests because the types are lying.

## 3. Test String Parsing and Regex

- `parseInt()` can return `NaN`. Regex match groups can be `undefined`.
- Pure functions with string inputs are prime test candidates.

## 4. Test External Data Boundaries

- Data from CDN, APIs, or user input needs runtime validation (Zod).
- Tests should verify schemas handle edge cases: malformed JSON, missing optional fields, unexpected values.

## 5. Don't Test React Component Rendering

- TypeScript + JSX already validates props.
- Avoid snapshot tests or render-output assertions for components.

## 6. Don't Test Convex Validators

- Convex validators handle runtime type checking.
- Only use `convex-test` for mutations touching multiple tables, complex authorization, or scheduled actions with side effects.
- Don't test simple CRUD operations where validators suffice.

## 7. Don't Test Observable Store Access

- Legend State is type-safe by design.
- Don't write tests for store reads/writes.

## 8. Don't Test Simple Enum Lookups or Environment Variables

- Exhaustive switch/case checks catch enum issues at compile time.
- T3-env validates environment variables at startup.

## 9. Prefer Simplification Over Testing

- If code is complex enough to need tests, first ask: can the code be simplified?
- Tests that document complexity often prevent fixing that complexity.
- Prefer spending time rewriting code to be simpler over writing tests for complex code.

## 10. Don't Chase Coverage Targets

- Code coverage targets lead to meaningless tests that lock in bad code.
- Tests should solve problems that only tests can solve.
- Different risk profiles warrant different testing levels.

## 11. Prioritize Research-Critical Tests

- Assessment scoring — bugs invalidate research data.
- Word interaction logging — data integrity for study analysis.
- Orientation flow completion — protocol compliance.
- Fluency state transitions — simplify first, test only if bugs appear.

## 12. Test File Conventions

- Unit tests: co-located as `*.test.ts` next to source files.
- E2E tests: in `e2e/` directory.
- E2E tests warrant coverage when flows affect study enrollment, are error-prone to test manually, or span multiple pages with complex state.
