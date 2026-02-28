# Completion Summary: Per-Branch Batching + Parallel Submission + Audit Issue Fixes

**Date**: 2026-02-28
**Branch**: `fix/audit-improvements-cb02af5`
**Files Changed**: 37 (+1568, -759 lines)

---

## Results

- `bun check` — typecheck + lint pass clean
- `bun test` — 16/16 tests pass, 0 failures

---

## Team Execution

| Agent | Tasks | Duration | Status |
|---|---|---|---|
| batch-architect | T1, T2, T3, T4 | ~4 min | Completed, shut down |
| security-quality | T8, T9, T10, T11, T12, T13 | ~6 min | Completed, shut down |
| orchestrator | T5, T6, T7 | ~9 min | Completed, shut down |
| ui-designer | T14, T15, T16, T17, T18, T19, T20 | ~10 min | Completed, shut down |

All 20/20 tasks completed. All 4 agents shut down cleanly.

---

## Deliverables

### 1. Per-Branch Batching + Parallel Submission (T1-T5, T7)

**New prompt architecture** (`src/audit/prompts.ts`):
- `AUDIT_INSTRUCTIONS` const — extracted shared instruction text (fixes issue #97)
- `buildSystemPromptBlocksForBranch()` — instructions block + branch source with `cache_control: { type: "ephemeral" }`
- `buildUserPromptForPolicy()` — loads single policy POLICY.md, specifies policy name for output
- `loadPolicyText()` helper — shared policy loading logic
- Existing `buildSystemPrompt` and `buildSystemPromptBlocks` preserved for CLI backward compat

**Per-branch batch backend** (`src/audit/api-backend.ts`):
- `buildBatchRequestForBranch()` — uses new prompt builders, `custom_id` format: `a-{branchSlug}-{policySlug}` (max 64 chars)
- `auditViaBatchPerBranch()` async generator — submits one batch per branch (all policies), `Promise.all` for parallel submission, unified 10s poll loop
- `validateAuditResult()` — runtime validation on parsed JSON from batch results (fixes #91, #92)
- Validation also applied to existing `auditViaApi` and `auditViaBatch`

**Cost estimation** (`src/pricing.ts`, `src/types.ts`):
- `PerBranchCostEstimate` interface with per-policy breakdown
- `estimatePerBranchCost()` — models 1 cache_write + (N-1) cache_reads per branch, policy tokens at batch_input_rate
- `formatPerBranchEstimate()` — CLI output with per-policy rows and totals

**Event system** (`src/events.ts`):
- `cost:estimate:aggregated` event type with `PerBranchCostEstimate` payload
- Converted `typedHandlers` from `Map<string, Handler[]>` to `Map<string, Set<Handler>>` for O(1) operations (fixes #7)

**Run-audit integration** (`src/audit/run-audit.ts`):
- `costApproved?: boolean` option on `AuditOptions`
- Exported `waitForConfirmation` (was private)
- `computePerBranchCostEstimate()` — loads branches/files, calls `estimatePerBranchCost`
- Batch mode: multi-policy uses `auditViaBatchPerBranch`; `costApproved` skips confirmation gate
- Sanitized API key hint in error messages (fixes #26)
- Replaced `execSync` with `spawnSync` array args (fixes #27)

**Orchestration wiring** (`src/index.ts`, `src/pipeline/run-all.ts`):
- Three-way split: CLI sequential, multi-policy batch with upfront cost + single confirmation, single-policy standard
- `combinedMode` removed from pipeline options

### 2. Flag Removal (T6)

Fully removed `--per-policy` and `--combined` from:
- `src/index.ts` — help text, parsing, config defaults, variable usage
- `src/types.ts` — `defaultPerPolicy` from `AuditConfig`, `perPolicy` from `CliOptions`
- `src/config.ts` — `defaultPerPolicy` loading
- `src/config/editor.ts` — `DEFAULT_PER_POLICY` field
- `audit.conf.default` — `DEFAULT_PER_POLICY=false` line
- `src/pipeline/run-all.ts` — `combinedMode` from `PipelineOptions`, combined mode branch
- `README.md` — `--per-policy` from audit options table

Replaced `console.log`/`console.error` with `log.info`/`log.error` in `src/index.ts` (fixes #1, #2).

### 3. Security Fixes (T8-T11) — 13 HIGH severity issues

**SQL injection eliminated** (issues #34, #55, #56, #111, #112):
- `src/fixes/run-fixes.ts`: Removed string-interpolated `policySqlFilter`, passes raw policy name to parameterized functions
- `src/fixes/batching.ts`: `getFixFilesWithLoc` and `countPendingIssues` use `?` placeholders

**Path traversal eliminated** (issues #29, #109):
- `src/config/server.ts`: `realpathSync` validates resolved paths stay within `distDir`
- `src/server.ts`: Same `realpath` + `normalize()` checks for progress UI server

**Unconsumed pipe streams fixed** (issues #115, #116):
- `src/fixes/executor.ts`: All subprocess stdout/stderr streams consumed via `Promise.all`

**Runtime validation at boundaries** (issues #80, #84, #85, #90, #106):
- `src/config.ts`: `defaultMode` validated against `"cli" | "api" | "batch"` with fallback
- `src/db.ts`: `ensureFile` throws explicit error on null result
- `src/server.ts`: POST `/api/confirm` validates body shape
- `src/config/server.ts`: PUT `/api/config` validates body is JSON object
- `src/audit/cli-backend.ts`: `validateIssues()` filters/normalizes parsed issues

### 4. Logging & Code Quality (T12-T13) — 25 issues

**Logging improvements** (issues #3, #4, #11, #16, #18, #25, #28, #33, #40, #41, #42, #43):
- Duration timing around CLI spawn operations
- File read errors logged instead of silently swallowed
- Structured error fields in catch blocks
- `console.log` replaced with logger in `cli-editor.ts`
- Structured logging for config server operations
- `setLogLevel` validates level string with type guard

**Code quality** (issues #6, #8, #61, #62, #88, #98, #99, #103, #104, #105, #110, #117, #118):
- Hoisted regex in `parseAuditConf`
- Optimized log array operations in server
- `instanceof Error` type guard in process-branch exception handling
- Dead `flat && depth > 0` check removed from scanner
- `extToLang` returns early for empty arrays
- Number validation rejects zero values in config editor

### 5. UI Updates (T14-T20) — 7 tasks, 30+ issues

**Aggregated cost types & state** (T14, T15):
- `AggregatedCostEstimate` interface in `src/ui/src/types.ts`
- `cost:estimate:aggregated` in PipelineEvent union
- `costEstimateAggregated` in UIState + reducer
- Hydration from `/api/state` snapshot
- Server-side `AccumulatedState` + `applyEvent()` handling
- Runtime validation on SSE/fetch JSON parsing (fixes #136, #137)

**CostConfirmation redesign** (T16):
- Optional `aggregated` prop for per-policy breakdown display
- Policy rows with name + branches + cost, separator, total row
- Checked `response.ok` before proceeding (fixes #128)
- Reset waiting state on approve success (fixes #129)

**SummaryPanel + App** (T17):
- `costEstimateAggregated` threaded from state through App to CostConfirmation and SummaryPanel
- Per-policy cost breakdown in sidebar when aggregated estimate exists
- Memoized stat computations in SummaryPanel (fixes #70)
- Stable `dismissConfirm` via `useCallback` (fixes #67)

**React fixes** (T18 — issues #64, #76, #46, #69, #77, #66, #78, #68, #65):
- Abort/ignore flag on ConfigApp fetch effect
- AbortController on useSSE hydrate fetch
- Error handling on ConfigApp fetch/save
- Cleared reconnection timer on successful reconnect
- Stable keys (not array index) in LogStream
- Simplified Object.keys usage in App.tsx
- SSE errors logged instead of silently swallowed

**Component cleanup** (T19 — issues #44, #74, #49, #50, #71, #73, #75, #125, #126, #133, #134, #135):
- Removed unused `phase` prop from PipelinePhases
- Memoized `filteredLogs` in LogStream with `useMemo`
- Memoized `batchEntries` in FixProgress
- Extracted shared global CSS into `globalStyles.ts`
- Extracted shared brand styles into `components/styles.ts`
- Extracted shared `StatusBadge` component
- Fixed LogStream auto-scroll dependency

**UI data validation** (T20 — issues #120, #121, #122):
- `isConfigResponse` and `isSaveResponse` validators in ConfigApp
- `isValidEvent` validator with known event type set in useSSE

---

## Files Modified

```
README.md
audit.conf.default
src/audit/api-backend.ts
src/audit/cli-backend.ts
src/audit/process-branch.ts
src/audit/prompts.ts
src/audit/run-audit.ts
src/branches/scanner.ts
src/config.ts
src/config/cli-editor.ts
src/config/editor.ts
src/config/server.ts
src/db.ts
src/events.ts
src/fixes/batching.ts
src/fixes/executor.ts
src/fixes/prompts.ts
src/fixes/run-fixes.ts
src/index.ts
src/logging.ts
src/pipeline/run-all.ts
src/pricing.ts
src/server.ts
src/types.ts
src/ui/src/App.tsx
src/ui/src/ConfigApp.tsx
src/ui/src/components/AuditProgress.tsx
src/ui/src/components/CostConfirmation.tsx
src/ui/src/components/FixProgress.tsx
src/ui/src/components/LogStream.tsx
src/ui/src/components/PipelinePhases.tsx
src/ui/src/components/SummaryPanel.tsx
src/ui/src/config-main.tsx
src/ui/src/hooks/useSSE.ts
src/ui/src/main.tsx
src/ui/src/state.ts
src/ui/src/types.ts
```

---

## Issues Resolved

| Severity | Count | Issue IDs |
|---|---|---|
| HIGH | 26 | #29, #34, #46, #55, #56, #64, #76, #80, #84, #85, #90, #91, #92, #106, #109, #111, #112, #115, #116, #120, #121, #122, #128, #129, #136, #137 |
| MEDIUM | 6 | #1, #2, #65, #68, #69, #77 |
| LOW | 45 | #3, #4, #6, #7, #8, #11, #16, #18, #25, #26, #27, #28, #33, #40, #41, #42, #43, #44, #49, #50, #61, #62, #66, #67, #70, #71, #73, #74, #75, #78, #88, #97, #98, #99, #103, #104, #105, #110, #117, #118, #124, #125, #126, #133, #134, #135 |
| **Total** | **77** | |
