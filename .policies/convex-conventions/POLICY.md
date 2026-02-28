# Convex Conventions Policy

Auditable rules extracted from Convex best practices, TypeScript conventions, and project-specific patterns.
Use these rules to evaluate whether Convex functions follow performance, security, and maintainability standards.

---

## 1. Await All Promises — CRITICAL

- All promises in Convex functions MUST be awaited.
- Unawaited promises lead to failed operations, missed errors, and unexpected behavior.
- Common culprits: `ctx.scheduler.runAfter`, `ctx.db.patch`, `ctx.db.insert`, `ctx.db.delete`.

```typescript
// ❌ Bad - unawaited promises
export const sendMessage = mutation({
  handler: async (ctx, args) => {
    ctx.db.insert("messages", { body: args.body });
    ctx.scheduler.runAfter(0, internal.notifications.send, {});
  },
});

// ✅ Good - all promises awaited
export const sendMessage = mutation({
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", { body: args.body });
    await ctx.scheduler.runAfter(0, internal.notifications.send, {});
  },
});
```

**Enforcement**: Use the `no-floating-promises` ESLint rule from typescript-eslint.

---

## 2. Avoid `.filter` on Database Queries

- `.filter` on queries is inefficient — use `.withIndex` or filter in code instead.
- `.filter` does not use indexes and processes all results before filtering.
- Only use `.filter` for paginated queries where filtering in code would return incomplete pages.

```typescript
// ❌ Bad - using .filter
const tomsMessages = await ctx.db
  .query("messages")
  .filter((q) => q.eq(q.field("author"), "Tom"))
  .collect();

// ✅ Good - Option 1: Use an index
const tomsMessages = await ctx.db
  .query("messages")
  .withIndex("by_author", (q) => q.eq("author", "Tom"))
  .collect();

// ✅ Good - Option 2: Filter in code (for small datasets)
const allMessages = await ctx.db.query("messages").collect();
const tomsMessages = allMessages.filter((m) => m.author === "Tom");
```

**When to use each**:

- Use `.withIndex` for large (1000+) or unbounded datasets
- Filter in code for small, bounded datasets (better readability)

---

## 3. Only Use `.collect` with Small Result Sets

- `.collect` loads ALL results into memory and counts towards database bandwidth.
- Large result sets cause performance issues and trigger unnecessary reactivity.
- If > 1000 documents, use indexes, pagination, limits, or denormalization.

```typescript
// ❌ Bad - potentially unbounded
const allMovies = await ctx.db.query("movies").collect();
const moviesByDirector = allMovies.filter((m) => m.director === "Spielberg");

// ✅ Good - use an index to limit results
const moviesByDirector = await ctx.db
  .query("movies")
  .withIndex("by_director", (q) => q.eq("director", "Spielberg"))
  .collect();

// ✅ Good - use pagination
const watchedMovies = await ctx.db
  .query("watchedMovies")
  .withIndex("by_user", (q) => q.eq("user", userId))
  .order("desc")
  .paginate(paginationOptions);

// ✅ Good - use a limit or denormalize count
const watchedMovies = await ctx.db
  .query("watchedMovies")
  .withIndex("by_user", (q) => q.eq("user", userId))
  .take(100);
const count = watchedMovies.length === 100 ? "99+" : watchedMovies.length;
```

**Enforcement**: Use the `@convex-dev/no-query-collect` ESLint rule.

**Exception**: Migrations or batch jobs that need to process all documents.

---

## 4. Check for Redundant Indexes

- Indexes like `by_foo` and `by_foo_and_bar` are redundant — only need `by_foo_and_bar`.
- Reducing indexes saves storage and write overhead.

```typescript
// ❌ Bad - redundant indexes
// schema: .index("by_team", ["team"])
//         .index("by_team_and_user", ["team", "user"])

// ✅ Good - just use the compound index
// schema: .index("by_team_and_user", ["team", "user"])

// Query all team members (partial index usage):
const allTeamMembers = await ctx.db
  .query("teamMembers")
  .withIndex("by_team_and_user", (q) => q.eq("team", teamId))
  .collect();

// Query specific user (full index usage):
const member = await ctx.db
  .query("teamMembers")
  .withIndex("by_team_and_user", (q) => q.eq("team", teamId).eq("user", userId))
  .unique();
```

**Exception**: If you need to sort by `_creationTime` after the first field, you may need separate indexes.

---

## 5. Use Argument Validators for All Public Functions — CRITICAL

- Public functions can be called by anyone — always validate inputs.
- Validators ensure runtime type safety and prevent malicious input.

```typescript
// ❌ Bad - no validation
export const updateMovie = mutation({
  handler: async (ctx, { id, update }: { id: Id<"movies">; update: any }) => {
    await ctx.db.patch("movies", id, update);
  },
});

// ✅ Good - validated arguments
export const updateMovie = mutation({
  args: {
    id: v.id("movies"),
    update: v.object({
      title: v.string(),
      director: v.string(),
    }),
  },
  handler: async (ctx, { id, update }) => {
    await ctx.db.patch("movies", id, update);
  },
});
```

**Enforcement**: Use the `@convex-dev/require-argument-validators` ESLint rule.

---

## 6. Use Access Control for All Public Functions — CRITICAL

- Always verify authorization using `ctx.auth.getUserIdentity()`.
- Never use spoofable values (email, username) for access control.
- Use `ctx.auth` or unguessable IDs (Convex IDs, UUIDs) for authorization checks.

```typescript
// ❌ Bad - no access control
export const updateTeam = mutation({
  args: { id: v.id("teams"), update: v.object({ name: v.string() }) },
  handler: async (ctx, { id, update }) => {
    await ctx.db.patch("teams", id, update);
  },
});

// ❌ Bad - uses spoofable email
export const updateTeam = mutation({
  args: { id: v.id("teams"), email: v.string() },
  handler: async (ctx, { id, email }) => {
    // email can be spoofed!
    const teamMembers = await ctx.db.query("teamMembers").collect();
    if (!teamMembers.some((m) => m.email === email)) {
      throw new Error("Unauthorized");
    }
    await ctx.db.patch("teams", id, { name: "foo" });
  },
});

// ✅ Good - uses ctx.auth (cannot be spoofed)
export const updateTeam = mutation({
  args: { id: v.id("teams"), update: v.object({ name: v.string() }) },
  handler: async (ctx, { id, update }) => {
    const user = await ctx.auth.getUserIdentity();
    if (user === null) {
      throw new Error("Unauthorized");
    }
    const isTeamMember = /* check membership using userId */
    if (!isTeamMember) {
      throw new Error("Unauthorized");
    }
    await ctx.db.patch("teams", id, update);
  },
});
```

**Pattern**: Consider Row Level Security (RLS) or helper functions for common access checks.

---

## 7. Only Schedule and `ctx.run*` Internal Functions

- Public functions are exposed to attacks — schedule only internal functions.
- Internal functions can only be called from within Convex.

```typescript
// ❌ Bad - scheduling a public function
import { api } from "./_generated/api";
crons.daily(
  "send daily reminder",
  { hourUTC: 17, minuteUTC: 30 },
  api.messages.sendMessage, // public!
  { author: "System", body: "Reminder!" }
);

// ✅ Good - scheduling an internal function
import { internal } from "./_generated/internal";
crons.daily(
  "send daily reminder",
  { hourUTC: 17, minuteUTC: 30 },
  internal.messages.sendInternalMessage,
  { author: "System", body: "Reminder!" }
);
```

**Rule**: Never use `api` in Convex function calls within the `convex/` directory. Only use `internal`.

---

## 8. Use Helper Functions for Shared Logic

- Most logic should be plain TypeScript functions in `convex/model/`.
- Keep `query`, `mutation`, `action` wrappers thin — just validation and helper calls.
- Organize code: `convex/model/` for helpers, `convex/` for public API.

```typescript
// ✅ Good - helper function in convex/model/users.ts
import { QueryCtx } from "../_generated/server";

export async function getCurrentUser(ctx: QueryCtx) {
  const userIdentity = await ctx.auth.getUserIdentity();
  if (userIdentity === null) {
    throw new Error("Unauthorized");
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_token", (q) =>
      q.eq("tokenIdentifier", userIdentity.tokenIdentifier)
    )
    .unique();
  return user;
}

// ✅ Good - thin wrapper in convex/users.ts
import * as Users from "./model/users";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return Users.getCurrentUser(ctx);
  },
});
```

**Benefits**: Easier testing, composition, reuse between public/internal functions.

---

## 9. Use `runAction` Only for Different Runtimes

- `runAction` has overhead (separate memory/CPU while parent waits).
- Replace with plain TypeScript functions unless calling Node.js code from Convex runtime.

```typescript
// ❌ Bad - unnecessary runAction
export const scrapeWebsite = action({
  handler: async (ctx, { siteMapUrl }) => {
    const pages = await fetch(siteMapUrl);
    await Promise.all(
      pages.map((page) =>
        ctx.runAction(internal.scrape.scrapePage, { url: page })
      )
    );
  },
});

// ✅ Good - plain TypeScript function
import * as Scrape from "./model/scrape";

export const scrapeWebsite = action({
  handler: async (ctx, { siteMapUrl }) => {
    const pages = await fetch(siteMapUrl);
    await Promise.all(
      pages.map((page) => Scrape.scrapePage(ctx, { url: page }))
    );
  },
});
```

**Exception**: Use `runAction` to call Node.js libraries from Convex runtime.

---

## 10. Avoid Sequential `ctx.runMutation`/`ctx.runQuery` from Actions

- Each call runs in its own transaction — sequential calls may see inconsistent data.
- Combine into a single mutation/query for consistency.

```typescript
// ❌ Bad - could see inconsistent data
const team = await ctx.runQuery(internal.teams.getTeam, { teamId });
const owner = await ctx.runQuery(internal.teams.getOwner, { teamId });
assert(team.owner === owner._id); // Could fail!

// ✅ Good - single query, consistent data
const { team, owner } = await ctx.runQuery(internal.teams.getTeamAndOwner, {
  teamId,
});
assert(team.owner === owner._id); // Always passes
```

**Exception**: Migrations, aggregations, or side effects between calls.

---

## 11. Use `ctx.runQuery`/`ctx.runMutation` Sparingly in Queries/Mutations

- Prefer plain TypeScript helper functions over `ctx.run*` for code reuse.
- `ctx.run*` has overhead; only use when necessary.

**Exceptions**:

- Using Convex components (require `ctx.run*`)
- Needing partial rollback on error (use `ctx.runMutation`)

---

## 12. Always Include Table Name in `ctx.db` Calls — CRITICAL

- Required for future custom ID generation; adds safety now.
- All `ctx.db.get`, `ctx.db.patch`, `ctx.db.replace`, `ctx.db.delete` must specify table name.

```typescript
// ❌ Bad - no table name
await ctx.db.get(movieId);
await ctx.db.patch(movieId, { title: "Whiplash" });
await ctx.db.delete(movieId);

// ✅ Good - includes table name
await ctx.db.get("movies", movieId);
await ctx.db.patch("movies", movieId, { title: "Whiplash" });
await ctx.db.delete("movies", movieId);
```

**Enforcement**: Use the `@convex-dev/explicit-table-ids` ESLint rule.

---

## 13. Don't Use `Date.now()` in Queries

- Queries don't re-run when time changes — leads to stale results.
- Using `Date.now()` invalidates query cache unnecessarily.

```typescript
// ❌ Bad - uses Date.now()
const releasedPosts = await ctx.db
  .query("posts")
  .withIndex("by_released_at", (q) => q.lte("releasedAt", Date.now()))
  .take(100);

// ✅ Good - use a boolean field updated by scheduled function
const releasedPosts = await ctx.db
  .query("posts")
  .withIndex("by_is_released", (q) => q.eq("isReleased", true))
  .take(100);

// ✅ Good - pass time as argument (client rounds to minute for caching)
export const getReleasedPosts = query({
  args: { asOfTime: v.number() },
  handler: async (ctx, { asOfTime }) => {
    return await ctx.db
      .query("posts")
      .withIndex("by_released_at", (q) => q.lte("releasedAt", asOfTime))
      .take(100);
  },
});
```

---

## 14. Type Annotations for Helper Functions

- Use generated types for context and data model.

```typescript
import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";

export function loadChannel(ctx: QueryCtx, id: Id<"channels">) {}
export function processMessage(ctx: ActionCtx, doc: Doc<"messages">) {}
```

---

## 15. Infer Types from Validators

- Reuse validators between arguments and schema.
- Use `Infer<typeof validator>` for TypeScript types.

```typescript
import { Infer, v } from "convex/values";

export const courseValidator = v.union(
  v.literal("appetizer"),
  v.literal("main"),
  v.literal("dessert")
);

export type Course = Infer<typeof courseValidator>;
// Type is: 'appetizer' | 'main' | 'dessert'
```

---

## 16. Use `WithoutSystemFields` for Inserts

- Documents include `_id` and `_creationTime` system fields.
- Use `WithoutSystemFields<Doc<"table">>` for insert/update helper types.

```typescript
import { WithoutSystemFields } from "convex/server";
import { Doc } from "./_generated/dataModel";

export async function insertMessage(
  ctx: MutationCtx,
  values: WithoutSystemFields<Doc<"messages">>
) {
  await ctx.db.insert("messages", values);
}
```

---

## 17. Don't Invoke Actions Directly from Browser

- Trigger actions via mutations that write state and schedule the action.
- Allows queries to track progress and enables resumability.

```typescript
// ❌ Bad - action called from client
// Client: await useMutation(api.actions.processData, { ... });

// ✅ Good - mutation schedules action
export const startProcessing = mutation({
  handler: async (ctx, args) => {
    const jobId = await ctx.db.insert("jobs", { status: "pending", ...args });
    await ctx.scheduler.runAfter(0, internal.actions.processData, { jobId });
    return jobId;
  },
});
```

---

## 18. Think "Workflow" Not "Background Jobs"

- Chain actions and mutations: `action → mutation → action → mutation`.
- Record progress incrementally for debugging, resume, and UI updates.

```typescript
// ✅ Good - incremental progress recording
export const processBatches = action({
  handler: async (ctx, { batches }) => {
    for (const batch of batches) {
      const results = await processBatch(batch);
      await ctx.runMutation(internal.jobs.recordProgress, { results });
    }
  },
});
```

---

## 19. Keep Functions Fast

- Mutations and queries should process < few hundred records and finish in < 100ms.
- Large operations should use actions with batching and progress recording.

---

## 20. Trust the Sync Engine

- Use queries for nearly every read — they're reactive, cacheable, and consistent.
- Let Convex handle caching and consistency — don't build custom layers.
- Avoid using mutation return values to update UI — let queries handle it.

---

## Project-Specific Conventions

### 21. Int64 Handling

- Schema uses `v.int64()` for integer fields.
- Convert with `BigInt()` when writing to database in mutations.
- Convert with `Number()` when returning to client from queries.

```typescript
export const updateScore = mutation({
  args: { score: v.number() },
  handler: async (ctx, { score }) => {
    await ctx.db.insert("scores", { value: BigInt(score) });
  },
});

export const getScore = query({
  handler: async (ctx) => {
    const record = await ctx.db.query("scores").first();
    return record ? Number(record.value) : 0;
  },
});
```

### 22. Shared Enums

- Enums used by both client and server live in `convex/shared/`.
- Examples: `convex/shared/fluency.ts`, `convex/shared/learning.ts`, `convex/shared/study.ts`.

### 23. Always Use `bunx` Not `npx`

- This project uses Bun as the package manager.

```bash
# ✅ Good
bunx convex dev
bunx convex deploy

# ❌ Bad
npx convex dev
npx convex deploy
```

### 24. Keep Dashboard Open

- The Convex dashboard is essential for logs, testing, data inspection, and performance monitoring.
- Command: `bunx convex dashboard`

---

## ESLint Rules to Enable

- `no-floating-promises` (typescript-eslint) - Catch unawaited promises
- `@convex-dev/no-query-collect` - Catch unbounded `.collect()` calls
- `@convex-dev/require-argument-validators` - Require validators on public functions
- `@convex-dev/explicit-table-ids` - Require table name in `ctx.db` operations
