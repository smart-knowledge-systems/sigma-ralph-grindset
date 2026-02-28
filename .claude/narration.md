# Voiceover Narration — Agent Teams in Action

---

So here's the situation. We have a TypeScript codebase — a policy-based code auditing tool built on Bun, the Anthropic API, and React. It's got two audit backends, a branch-splitting pipeline, a fix executor, a browser UI — real software with real complexity.

And we've got a problem. Actually, three problems. The cost confirmation UI is misleading — it shows a per-call estimate with no context that it's only for one policy. Batches run sequentially when they could run in parallel. There are two CLI flags that are now obsolete. And the audit system itself has flagged 77 issues across the codebase — SQL injection, path traversal, unconsumed streams, React anti-patterns, missing validation. The kind of stuff you find when you actually run your own tools against your own code.

The plan to fix all of this touches 37 files. It's not a weekend refactor. It's architectural work, security hardening, and UI redesign, all at once. So instead of doing it sequentially — task by task, file by file — we're going to use agent teams.

---

## What You're About to See

Claude Code has a team system. You define a team, create a task list, spawn specialized agents, and they work concurrently in the same repository. Each agent gets a name, a scope, and a set of tasks. They read files, write code, query databases, and communicate through a message system. The team lead — the root Claude session — coordinates everything: task assignment, dependency management, conflict avoidance, and verification.

This isn't a demo with toy code. This is the real session. Let's walk through it.

---

## Setting Up

First, the team lead reads the plan and creates the team — `audit-improvements`. Then it creates all 20 tasks with detailed descriptions. Each task references specific files, specific issue IDs from the audit database, and specific acceptance criteria.

Then — and this is the part that matters — it sets up the dependency graph.

Task 2, the batch backend, depends on Task 1, the prompt restructuring. You can't build the batch requests until the prompt builders exist. Task 5, wiring up `runAudit`, depends on Tasks 1, 2, and 3. Task 7, the final orchestration, depends on Tasks 5 and 6. The UI tasks for aggregated cost display depend on Task 4, the event type definition.

These aren't arbitrary constraints. They reflect real data flow. The orchestrator can't import `auditViaBatchPerBranch` until it's been written. The UI can't render `AggregatedCostEstimate` until the type exists. Getting these dependencies right is what makes parallel execution safe.

---

## Four Agents, Four Domains

The team lead spawns four agents simultaneously:

**batch-architect** gets the core infrastructure — prompt builders, the batch backend, cost estimation, and the event system. These are the foundation that other agents depend on. No blockers. Starts immediately.

**security-quality** gets every security and code quality issue — SQL injection, path traversal, unconsumed pipe streams, runtime validation, logging improvements, and a pile of code quality fixes. Six tasks, all independent. Also starts immediately.

**ui-designer** gets all the React work — abort controllers, memoization, component cleanup, data validation. And then, once `batch-architect` finishes the event types, it picks up the aggregated cost UI: new types, state management, the CostConfirmation redesign, and SummaryPanel updates. Starts with the unblocked tasks, waits for the rest.

**orchestrator** gets the CLI and pipeline — removing the dead flags first (no blockers), then wiring up `runAudit` and the parallel orchestration once `batch-architect` delivers the new functions.

Notice the shape of this. Two agents start with full workloads and no dependencies. Two agents start with partial workloads and pick up more as dependencies resolve. The team lead doesn't need to micromanage the scheduling — the task graph does it.

---

## The Execution

Watch what happens next. `batch-architect` and `security-quality` are working simultaneously in different parts of the codebase. No file conflicts because their scopes don't overlap. `batch-architect` is building `buildSystemPromptBlocksForBranch()` in `prompts.ts` while `security-quality` is replacing string-interpolated SQL with parameterized queries in `run-fixes.ts`. Different files, different concerns, running at the same time.

`batch-architect` finishes all four tasks first. The team lead immediately marks them complete, which updates the dependency graph. Tasks 5, 14, and 15 are now unblocked. The team lead sends messages to `orchestrator` and `ui-designer` with exactly what was added — function names, file locations, interface shapes — so they can integrate without guessing.

Then `batch-architect` gets shut down. It's done. No point keeping it around burning context.

`security-quality` finishes next — SQL injection eliminated, path traversal blocked, streams consumed, validation added across five files, logging improved across eight files, code quality fixes across seven more. All independent work, all done while the other agents were handling their own tasks.

`orchestrator` finishes third. It removed the dead flags cleanly — touching `index.ts`, `types.ts`, `config.ts`, `editor.ts`, `run-all.ts`, the default config, and the README. Then it wired up the three-way split in the audit command: CLI mode stays sequential, multi-policy batch mode gets the new parallel path with aggregated cost approval, single-policy batch mode stays as-is.

`ui-designer` finishes last — it had the most tasks and the deepest dependency chain. But it wasn't idle while waiting. It knocked out all the React fixes, component cleanup, and data validation first. When the aggregated cost types landed, it picked up the state management, the CostConfirmation redesign, and the SummaryPanel integration without missing a beat.

---

## The Result

Twenty tasks. Four agents. Thirty-seven files changed. Seventy-seven audit issues resolved — including five SQL injection vectors and two path traversal vulnerabilities. The `--per-policy` and `--combined` flags are gone. Multi-policy audits now show a single aggregated cost estimate with per-policy breakdown, get one approval, and submit all branch batches in parallel.

`bun check` passes. `bun test` passes. Sixteen tests, zero failures.

---

## What to Take Away

If you're working in this codebase, a few things to notice:

**The task graph is the architecture.** The dependency setup at the beginning wasn't bookkeeping — it was the design. It determined what could run in parallel, what had to wait, and where the integration points were.

**Scope isolation prevents conflicts.** Each agent had an explicit list of files. `security-quality` never touched `prompts.ts`. `batch-architect` never touched `ConfigApp.tsx`. No merge conflicts, no stepping on each other's changes.

**Communication is explicit.** When `batch-architect` finished, the team lead didn't just unblock tasks — it sent messages describing exactly what was added and where. The downstream agents didn't have to reverse-engineer the new APIs.

**Agents shut down when they're done.** There's no idle overhead. Once `batch-architect` delivered its four tasks, it was terminated. The team shrank from four agents to three to two to one as work completed.

**The team lead's job is coordination, not implementation.** It created tasks, set dependencies, routed messages, ran verification. It didn't write a single line of application code. That's the point — the lead maintains the big picture while the agents handle the details.

This pattern scales. Five tasks or fifty. Two agents or ten. The mechanics are the same: define the work, map the dependencies, assign the scopes, and let the agents run.
