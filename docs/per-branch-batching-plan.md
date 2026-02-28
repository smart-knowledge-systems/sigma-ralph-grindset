# Plan: Per-Branch Batching + Parallel Submission + Audit Issue Fixes

## Context

Three problems addressed simultaneously:

1. **Cost UI ambiguity + sequential batching**: Per-policy mode showed a cost estimate per call with no indication it was only for one policy. Batches ran sequentially, wasting time.
2. **Obsolete flags**: Per-branch batching (one request per policy, one batch per branch) makes `--combined` and `--per-policy` obsolete.
3. **Pending audit issues**: 70+ issues found across 5 policies needed to be fixed.

**Outcome**: Single aggregated cost approval with per-policy breakdown, all branch batches submitted in parallel, dead flags removed, and all pending audit issues resolved.

---

## Team Structure

A team of 4 specialized agents coordinated by a team lead:

### batch-architect
**Scope**: Prompt restructuring, batch backend, cost estimation, event types
**Files**: `src/audit/prompts.ts`, `src/audit/api-backend.ts`, `src/pricing.ts`, `src/events.ts`, `src/audit/schema.ts`

### orchestrator
**Scope**: run-audit, CLI entry, pipeline, flag removal, config cleanup
**Files**: `src/audit/run-audit.ts`, `src/index.ts`, `src/pipeline/run-all.ts`, `src/types.ts`, `src/config.ts`, `src/config/editor.ts`, `audit.conf.default`, `README.md`

### security-quality
**Scope**: SQL injection, path traversal, runtime validation, logging, pipes, code quality
**Files**: `src/fixes/run-fixes.ts`, `src/fixes/batching.ts`, `src/fixes/executor.ts`, `src/fixes/prompts.ts`, `src/config/server.ts`, `src/server.ts`, `src/db.ts`, `src/logging.ts`, `src/audit/cli-backend.ts`, `src/audit/process-branch.ts`, `src/branches/scanner.ts`, `src/branches/loader.ts`

### ui-designer
**Scope**: CostConfirmation, SummaryPanel, App, React fixes, types/state/hydration
**Files**: `src/ui/src/components/CostConfirmation.tsx`, `src/ui/src/components/SummaryPanel.tsx`, `src/ui/src/components/LogStream.tsx`, `src/ui/src/components/PipelinePhases.tsx`, `src/ui/src/components/FixProgress.tsx`, `src/ui/src/components/AuditProgress.tsx`, `src/ui/src/App.tsx`, `src/ui/src/ConfigApp.tsx`, `src/ui/src/hooks/useSSE.ts`, `src/ui/src/state.ts`, `src/ui/src/types.ts`, `src/ui/src/main.tsx`, `src/ui/src/config-main.tsx`

### Dependencies
- `orchestrator` depended on `batch-architect` (needed new functions to wire up)
- `ui-designer` depended on `batch-architect` (needed new event/type definitions)
- `security-quality` was independent
- `batch-architect` had no blockers

---

## Tasks

### batch-architect

**T1: Restructure prompts for per-branch batching**
File: `src/audit/prompts.ts`
- Add `buildSystemPromptBlocksForBranch(config, branchPath, files)` — system blocks with instructions (block 1) + branch source code with `cache_control: { type: "ephemeral" }` (block 2)
- Add `buildUserPromptForPolicy(policyName, config)` — loads policy POLICY.md, appends review instructions specifying the policy name for the output `policy` field
- Keep existing `buildSystemPrompt` and `buildSystemPromptBlocks` for backward compat with CLI mode
- Fix issue #97 (duplicated instruction text) by extracting shared instruction text into a const

**T2: Per-branch batch backend** (blocked by T1)
File: `src/audit/api-backend.ts`
- Add `buildBatchRequestForBranch(branchPath, files, policyName, config)` using the new prompt builders
- `custom_id` format: `a-{branchSlug}-{policySlug}` (max 64 chars)
- Add `auditViaBatchPerBranch(branches, policyNames, config)` async generator:
  - For each branch: build requests (one per policy), submit as one batch
  - Submit all branch batches with `Promise.all`
  - Poll all active batches in a unified 10s loop, removing completed ones
  - Yield `{ type: "result", branchPath, policyName, result, usage }` per request
  - Yield `{ type: "complete", totalUsage }` at end
- Keep existing `auditViaBatch` for single-policy and CLI fallback
- Fix issues #91, #92 (add runtime validation on parsed JSON from batch results)

**T3: Per-branch cost estimation**
File: `src/pricing.ts`
- Add `PerBranchCostEstimate` interface: `{ model, branchCount, policyCount, totalRequests, totalBatchApiCost, totalNoCacheCost, perPolicy: Array<{ policyName, policyTokens, batchApiCost }> }`
- Add `estimatePerBranchCost()`: per branch 1 cache_write + (numPolicies-1) cache_reads, per-policy attribution
- Add `formatPerBranchEstimate()` — CLI output with per-policy rows + total

**T4: Aggregated cost event type**
File: `src/events.ts`
- Add `cost:estimate:aggregated` to `PipelineEvent` union with `PerBranchCostEstimate` shape
- Fix issue #7 (convert typedHandlers to `Map<string, Set<Handler>>` for O(1) operations)

### orchestrator

**T5: Add costApproved option + per-branch batch path in runAudit** (blocked by T1, T2, T3)
File: `src/audit/run-audit.ts`
- Add `costApproved?: boolean` to `AuditOptions`
- Export `waitForConfirmation` (previously private)
- Add `computePerBranchCostEstimate(config, policyNames, opts)` — loads branches/files, calls `estimatePerBranchCost`, returns estimate
- Batch mode: when `policyNames.length > 1`, use `auditViaBatchPerBranch`; when `costApproved`, skip confirmation gate
- Fix issue #26 (sanitize API key hint in log output)
- Fix issue #27 (use array form for git spawn)

**T6: Remove --per-policy and --combined flags**
Files: `src/index.ts`, `src/pipeline/run-all.ts`, `src/types.ts`, `src/config.ts`, `src/config/editor.ts`, `audit.conf.default`, `README.md`
- Remove all traces of `--per-policy` and `--combined` from CLI, types, config, editor, defaults, docs
- Fix issues #1, #2 (replace `console.log`/`console.error` with `log` in `index.ts`)

**T7: Wire up parallel batch orchestration** (blocked by T5, T6)
Files: `src/index.ts`, `src/pipeline/run-all.ts`
- Three-way split: CLI sequential, multi-policy batch with upfront cost + single confirmation, single-policy standard
- Remove `combinedMode` from pipeline options

### security-quality

**T8: Fix SQL injection** (issues #34, #55, #56, #111, #112)
Files: `src/fixes/run-fixes.ts`, `src/fixes/batching.ts`
- Replace string-interpolated `policySqlFilter` with parameterized queries using `?` placeholders

**T9: Fix path traversal** (issues #29, #109)
File: `src/config/server.ts`
- Validate resolved paths stay within `distDir` before serving
- Add `realpath` check or reject `..` segments

**T10: Fix unconsumed pipe streams** (issues #115, #116)
File: `src/fixes/executor.ts`
- Consume or destroy stderr/stdout streams that are piped but never read

**T11: Runtime validation at external boundaries** (issues #80, #84, #85, #90, #106)
Files: `src/config.ts`, `src/db.ts`, `src/server.ts`, `src/audit/cli-backend.ts`
- #80: Validate `defaultMode` against allowed values at parse time
- #84: Add null check on `ensureFile` query result
- #85: Validate POST body shape in `/api/confirm`
- #90: Validate CLI output parsing with schema check
- #106: Validate PUT body in config server

**T12: Logging improvements** (issues #3, #4, #11, #16, #18, #25, #28, #33, #40, #41, #42, #43)
Files: `src/logging.ts`, `src/db.ts`, `src/config/cli-editor.ts`, `src/config/server.ts`, `src/fixes/prompts.ts`, `src/fixes/run-fixes.ts`, `src/fixes/batching.ts`, `src/audit/process-branch.ts`
- Duration fields, timing, structured errors, console-to-logger migration, structured config server logging

**T13: Code quality fixes** (issues #6, #8, #61, #62, #88, #98, #99, #103, #104, #105, #110, #117, #118)
Files: `src/config.ts`, `src/server.ts`, `src/branches/scanner.ts`, `src/branches/loader.ts`, `src/config/editor.ts`, `src/audit/process-branch.ts`, `src/logging.ts`
- Hoisted regex, optimized array ops, validated LogLevel, type guards, dead code removal, bounds validation

### ui-designer

**T14: Update UI types, state, hydration for aggregated cost** (blocked by T4)
Files: `src/ui/src/types.ts`, `src/ui/src/state.ts`, `src/ui/src/hooks/useSSE.ts`
- Add `AggregatedCostEstimate` interface, `cost:estimate:aggregated` event, state field, reducer case, hydration
- Fix issues #136, #137 (runtime validation on SSE/fetch JSON parsing)

**T15: Update server-side accumulated state** (blocked by T4)
File: `src/server.ts`
- Add `costEstimateAggregated` to `AccumulatedState`, handle in `applyEvent()`
- Fix issue #109 (validate static file paths in progress UI server)

**T16: Redesign CostConfirmation with per-policy breakdown** (blocked by T14)
File: `src/ui/src/components/CostConfirmation.tsx`
- Optional `aggregated` prop for per-policy breakdown display
- Fix issue #128 (check response.ok), #129 (reset waiting state on success)

**T17: Update SummaryPanel + App for aggregated cost** (blocked by T14)
Files: `src/ui/src/components/SummaryPanel.tsx`, `src/ui/src/App.tsx`
- Thread `costEstimateAggregated` through components, per-policy sidebar display
- Fix issue #70 (memoize stats), #67 (stable dismissConfirm), #124 (remove no-op)

**T18: React fixes** (issues #64, #76, #46, #69, #77, #66, #78, #68, #65)
Files: `src/ui/src/ConfigApp.tsx`, `src/ui/src/hooks/useSSE.ts`, `src/ui/src/components/LogStream.tsx`
- Abort controllers, error handling, stable keys, effect cleanup

**T19: Component cleanup** (issues #44, #74, #49, #50, #71, #73, #75, #125, #126, #133, #134, #135)
Files: `src/ui/src/components/PipelinePhases.tsx`, `src/ui/src/components/LogStream.tsx`, `src/ui/src/components/FixProgress.tsx`, `src/ui/src/main.tsx`, `src/ui/src/config-main.tsx`, `src/ui/src/components/AuditProgress.tsx`
- Removed unused props, memoized derived values, extracted shared CSS/styles/StatusBadge

**T20: UI data validation** (issues #120, #121, #122)
Files: `src/ui/src/ConfigApp.tsx`, `src/ui/src/hooks/useSSE.ts`
- Validate API response shapes and SSE event data before dispatching

---

## Issue Index

### HIGH severity
| ID | Rule | Policy | Files |
|---|---|---|---|
| 29 | Never log raw request URLs | logging-strategy | config/server.ts |
| 34 | Avoid SQL injection | logging-strategy | run-fixes.ts, batching.ts |
| 46 | Incorrect key usage in lists | logging-strategy | LogStream.tsx |
| 55 | SQL injection / parameterized queries | react-useeffect-discipline | run-fixes.ts |
| 56 | SQL injection / parameterized queries | react-useeffect-discipline | run-fixes.ts, batching.ts |
| 64 | Handle Data Fetching Race Conditions | Effect Hygiene | ConfigApp.tsx |
| 76 | Handle Data Fetching Race Conditions | Effect Hygiene | useSSE.ts |
| 80 | Test External Data Boundaries | testing-philosophy | config.ts |
| 84 | Test Type System Boundaries | testing-philosophy | db.ts |
| 85 | Test External Data Boundaries | testing-philosophy | server.ts |
| 90 | Test Type System Boundaries | testing-philosophy | cli-backend.ts |
| 91 | Test Type System Boundaries | testing-philosophy | api-backend.ts |
| 92 | Test Type System Boundaries | testing-philosophy | api-backend.ts |
| 106 | Test External Data Boundaries | testing-philosophy | config/server.ts |
| 109 | Test External Data Boundaries | testing-philosophy | config/server.ts |
| 111 | Avoid SQL injection | testing-philosophy | run-fixes.ts |
| 112 | Avoid SQL injection | testing-philosophy | run-fixes.ts, batching.ts |
| 115 | Unconsumed pipe stream | testing-philosophy | executor.ts |
| 116 | Unconsumed pipe stream | testing-philosophy | executor.ts |
| 120 | Test External Data Boundaries | testing-philosophy | ConfigApp.tsx |
| 121 | Test External Data Boundaries | testing-philosophy | ConfigApp.tsx |
| 122 | Test Type System Boundaries | testing-philosophy | useSSE.ts, state.ts, types.ts |
| 128 | Test External Data Boundaries | testing-philosophy | CostConfirmation.tsx |
| 129 | State never reset on success | testing-philosophy | CostConfirmation.tsx |
| 136 | Test External Data Boundaries | testing-philosophy | useSSE.ts |
| 137 | Test Type System Boundaries | testing-philosophy | useSSE.ts |

### MEDIUM severity
| ID | Rule | Policy | Files |
|---|---|---|---|
| 1 | Use the Logging Library | logging-strategy | index.ts |
| 2 | Error Logging Structure | logging-strategy | index.ts |
| 65 | Do Not Send POST Requests from Effects | Unnecessary Effects | ConfigApp.tsx |
| 68 | Do Not Derive State in Effects | Unnecessary Effects | ConfigApp.tsx |
| 69 | Always Clean Up Side Effects | Effect Hygiene | ConfigApp.tsx |
| 77 | Always Clean Up Side Effects | Effect Hygiene | useSSE.ts |

### LOW severity
| ID | Rule | Policy | Files |
|---|---|---|---|
| 3 | Wide Events Pattern | logging-strategy | logging.ts |
| 4 | Correlation IDs | logging-strategy | logging.ts, db.ts |
| 6 | Hoist RegExp Creation | vercel-react-best-practices | config.ts |
| 7 | Use Set/Map for O(1) Lookups | vercel-react-best-practices | events.ts |
| 8 | Combine Multiple Array Iterations | vercel-react-best-practices | server.ts |
| 11 | Event Naming Format | logging-strategy | logging.ts, events.ts, server.ts |
| 16 | Watch for Accidental PII Leaks | logging-strategy | server.ts |
| 18 | Wide Events Pattern | logging-strategy | db.ts |
| 25 | Duration Fields | logging-strategy | process-branch.ts, cli-backend.ts, api-backend.ts |
| 26 | Never Log PII | logging-strategy | run-audit.ts |
| 27 | Avoid High-Volume, Low-Value Events | logging-strategy | run-audit.ts |
| 28 | Use the Logging Library | logging-strategy | cli-editor.ts |
| 33 | Wide Events Pattern | logging-strategy | config/server.ts |
| 40 | Error Logging Structure | logging-strategy | fixes/prompts.ts |
| 41 | Wide Events Pattern | logging-strategy | run-fixes.ts |
| 42 | Error Logging Structure | logging-strategy | batching.ts |
| 43 | Error Logging Structure | logging-strategy | fixes/prompts.ts |
| 44 | Unused props/variables | logging-strategy | PipelinePhases.tsx |
| 49 | Missing memoization | logging-strategy | LogStream.tsx |
| 50 | Missing memoization | logging-strategy | FixProgress.tsx |
| 61 | Synchronous I/O in async context | react-useeffect-discipline | batching.ts |
| 62 | Synchronous I/O in async context | react-useeffect-discipline | fixes/prompts.ts |
| 66 | Avoid Object and Function Dependencies | Unnecessary Effects | App.tsx |
| 67 | Avoid Object and Function Dependencies | Dependency Array Correctness | App.tsx |
| 70 | Use useMemo for Expensive Computations | Unnecessary Effects | SummaryPanel.tsx |
| 71 | Do Not Derive State in Effects | Unnecessary Effects | LogStream.tsx |
| 73 | Use useMemo for Expensive Computations | Unnecessary Effects | LogStream.tsx |
| 74 | Unused props | Unnecessary Effects | PipelinePhases.tsx |
| 75 | Use useMemo for Expensive Computations | Unnecessary Effects | FixProgress.tsx |
| 78 | Always Clean Up Side Effects | Effect Hygiene | useSSE.ts |
| 88 | Test Type System Boundaries | testing-philosophy | logging.ts |
| 97 | Prefer Simplification Over Testing | testing-philosophy | prompts.ts |
| 98 | Test Type System Boundaries | testing-philosophy | process-branch.ts |
| 99 | Prefer Simplification Over Testing | testing-philosophy | scanner.ts |
| 103 | Test String Parsing and Regex | testing-philosophy | scanner.ts |
| 104 | Test String Parsing and Regex | testing-philosophy | loader.ts |
| 105 | Test Type System Boundaries | testing-philosophy | scanner.ts |
| 110 | Test String Parsing and Regex | testing-philosophy | config/editor.ts |
| 117 | Prefer Simplification Over Testing | testing-philosophy | fixes/prompts.ts |
| 118 | Prefer Simplification Over Testing | testing-philosophy | batching.ts |
| 124 | Prefer Simplification Over Testing | testing-philosophy | App.tsx |
| 125 | Prefer Simplification Over Testing | testing-philosophy | main.tsx, config-main.tsx |
| 126 | Prefer Simplification Over Testing | testing-philosophy | ConfigApp.tsx, App.tsx |
| 133 | Prefer Simplification Over Testing | testing-philosophy | FixProgress.tsx, AuditProgress.tsx |
| 134 | Prefer Simplification Over Testing | testing-philosophy | multiple UI components |
| 135 | Correctness - insufficient effect dependency | testing-philosophy | LogStream.tsx |

---

## Verification Criteria

1. `bun check` — typecheck + lint passes
2. `bun test` — all tests pass
3. `bun audit --dry-run` with multiple policies — shows per-policy cost breakdown with total
4. `bun audit` with multiple policies — single approval, all branch batches submitted in parallel, results stored with correct policy attribution
5. `bun audit` with single policy — existing behavior unchanged
6. `bun audit --cli` — sequential behavior unchanged
7. `bun audit --per-policy` — errors with "unknown flag" (removed)
8. Browser UI shows per-policy cost breakdown in confirmation card and sidebar
9. SQL injection vectors eliminated (parameterized queries)
10. Path traversal vectors eliminated (validated paths)
