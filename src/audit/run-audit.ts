// ============================================================================
// Audit orchestrator — coordinates branch processing
// ============================================================================

import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import type {
  AuditConfig,
  AuditMode,
  AuditResult,
  Branch,
  CostEstimate,
  PerBranchCostEstimate,
  TokenUsage,
} from "../types";
import { log } from "../logging";
import { events } from "../events";
import {
  initDatabase,
  getCheckpointCommit,
  supersedePendingIssues,
} from "../db";
import { loadBranches, fileToBranch, getDiffFiles } from "../branches/loader";
import {
  findSourceFiles,
  countLoc,
  matchesExtensions,
  isExcludedPath,
} from "../branches/scanner";
import { processBranch } from "./process-branch";
import {
  insertScan,
  updateScanStatus,
  updateScanUsage,
  insertIssue,
  ensureFile,
  linkIssueFile,
} from "../db";
import { parseFileRef } from "../branches/scanner";
import {
  estimateCost,
  formatEstimate,
  formatActualCost,
  computeActualCost,
  estimateTokens,
  estimatePerBranchCost,
  formatPerBranchEstimate,
  resolveModelId,
} from "../pricing";
import { buildSystemPrompt, cachedReadFile } from "./prompts";
import { buildAddendumContext, loadMatchingAddendums } from "./addendum";
import { ensureApiKey, clearEphemeralApiKey } from "./ensure-api-key";
import { randomUUID } from "crypto";

// ============================================================================
// Public types
// ============================================================================

export interface AuditOptions {
  policies: string[];
  forceAll: boolean;
  diffMode: boolean;
  diffRef?: string;
  mode: AuditMode;
  dryRun: boolean;
  maxLoc?: number;
  costApproved?: boolean;
}

interface AuditCounters {
  processed: number;
  succeeded: number;
  failed: number;
}

// ============================================================================
// Shared helpers
// ============================================================================

/** Discover active policies from policies/ directory. */
export function discoverPolicies(config: AuditConfig): string[] {
  const policies: string[] = [];
  if (!existsSync(config.policiesDir)) return policies;

  for (const entry of readdirSync(config.policiesDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const policyFile = resolve(config.policiesDir, entry.name, "POLICY.md");
    if (existsSync(policyFile)) {
      policies.push(entry.name);
    }
  }
  return policies.sort();
}

/**
 * Store audit results from a batch event into the database.
 * Shared by both combined-batch and per-branch-batch modes.
 */
function storeAuditResults(
  config: AuditConfig,
  branchPath: string,
  policyLabel: string,
  result: AuditResult,
  usage?: TokenUsage,
  isBatch?: boolean,
  requestId?: string,
): { scanId: number; issueCount: number } {
  const scanId = insertScan(config, branchPath, policyLabel, 0, 0);
  let issueCount = 0;

  for (const issue of result.issues) {
    const issueId = insertIssue(
      config,
      scanId,
      issue.description,
      issue.rule,
      issue.severity,
      issue.suggestion,
      issue.policy,
    );
    for (const rawFile of issue.files) {
      const { path: cleanPath, lines } = parseFileRef(rawFile);
      const fileId = ensureFile(config, cleanPath);
      linkIssueFile(config, issueId, fileId, lines);
    }
    issueCount++;
  }

  updateScanStatus(config, scanId, "completed", { issueCount });

  if (usage) {
    const cost = computeActualCost(config.auditModel, usage, isBatch ?? false);
    updateScanUsage(config, scanId, usage, cost, requestId);
  }

  return { scanId, issueCount };
}

/** Module-level cache for countLoc results to avoid re-reading files. */
const locCache = new Map<string, number>();

function getCachedLoc(file: string): number {
  let loc = locCache.get(file);
  if (loc === undefined) {
    loc = countLoc([file]);
    locCache.set(file, loc);
  }
  return loc;
}

/** Split files into batches by LOC. */
function batchFilesForAudit(files: string[], maxLoc: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLoc = 0;

  for (const file of files) {
    const fileLoc = getCachedLoc(file);
    if (currentLoc + fileLoc > maxLoc && current.length > 0) {
      batches.push(current);
      current = [];
      currentLoc = 0;
    }
    current.push(file);
    currentLoc += fileLoc;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Filter branches based on checkpoints (incremental mode). */
function filterBranches(
  branches: Branch[],
  policyNames: string[],
  config: AuditConfig,
  forceAll: boolean,
): Branch[] {
  if (forceAll) {
    log.info("Mode: full audit (--all)");
    return branches;
  }

  const checkpoint = getCheckpointCommit(config, policyNames);
  if (!checkpoint) {
    log.info("Mode: full audit (no previous checkpoint)");
    return branches;
  }

  // Get changed files since checkpoint using spawnSync with args array
  // (avoids shell injection from projectRoot)
  let changedFiles: string;
  try {
    const result = spawnSync(
      "git",
      ["-C", config.projectRoot, "diff", "--name-only", `${checkpoint}...HEAD`],
      { encoding: "utf-8" },
    );
    if (result.status !== 0) {
      log.info("Mode: full audit (checkpoint commit not in history)");
      return branches;
    }
    changedFiles = result.stdout;
  } catch {
    log.info("Mode: full audit (checkpoint commit not in history)");
    return branches;
  }

  if (!changedFiles.trim()) {
    log.info("No files changed since last audit — nothing to do.");
    return [];
  }

  const changedBranchPaths = new Set<string>();
  for (const file of changedFiles.split("\n")) {
    if (!file.trim()) continue;
    if (!matchesExtensions(file, config.fileExtensions)) continue;
    if (isExcludedPath(file, config.excludeDirs)) continue;
    const branch = fileToBranch(file, branches);
    if (branch) changedBranchPaths.add(branch);
  }

  const result = branches.filter((b) => changedBranchPaths.has(b.path));
  const skipped = branches.length - result.length;
  log.info(`Mode: incremental (${result.length} changed, ${skipped} skipped)`);
  return result;
}

/** Wait for user confirmation via stdin or browser event bus. */
export async function waitForConfirmation(requestId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
    };

    // Browser path: listen for event bus
    const unsub = events.on("infra.cost.confirm.response", (e) => {
      if (e.requestId === requestId) {
        cleanup();
        unsub();
        try {
          process.stdin.removeAllListeners("data");
          process.stdin.pause();
        } catch {
          // ignore
        }
        resolve(e.approved);
      }
    });

    // CLI path: prompt stdin
    process.stdout.write("\nProceed with batch audit? [Y/n] ");
    const onData = (data: Buffer) => {
      if (resolved) return;
      const input = data.toString().trim().toLowerCase();
      cleanup();
      unsub();
      try {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
      } catch {
        // ignore
      }
      const approved = input !== "n" && input !== "no";
      events.emit({
        type: "infra.cost.confirm.response",
        approved,
        requestId,
      });
      resolve(approved);
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Supersede any pending issues from prior audits of this branch+policy
 *  before we re-scan. Called once per (branch, policy) regardless of how
 *  many batches the scan will be split into — otherwise each batch would
 *  clobber the pending issues produced by the previous batch.
 */
function supersedeBeforeScan(
  config: AuditConfig,
  branchPath: string,
  policyNames: string[],
  policyLabel: string,
): void {
  const allPolicies = [...policyNames, policyLabel];
  const superseded = supersedePendingIssues(config, branchPath, allPolicies);
  if (superseded > 0) {
    log.info(
      `  Superseded ${superseded} stale issues for ${branchPath} [${policyLabel}]`,
    );
  }
}

/** Load branches and their files, filtering out empty/missing ones.
 *  When maxLoc is provided, branches exceeding the limit are split into
 *  multiple entries with suffixed paths (e.g. "src/components [batch 1]").
 */
function loadBranchesWithFiles(
  config: AuditConfig,
  branches: Branch[],
  maxLoc?: number,
): Array<{ path: string; files: string[] }> {
  const result: Array<{ path: string; files: string[] }> = [];
  for (const branch of branches) {
    const fullPath = resolve(config.projectRoot, branch.path);
    if (!existsSync(fullPath)) continue;
    const files = findSourceFiles(fullPath, branch.isFlat, config);
    if (files.length === 0) continue;

    if (maxLoc && countLoc(files) > maxLoc) {
      const batches = batchFilesForAudit(files, maxLoc);
      for (let i = 0; i < batches.length; i++) {
        const suffix = batches.length > 1 ? ` [batch ${i + 1}]` : "";
        result.push({ path: `${branch.path}${suffix}`, files: batches[i]! });
      }
    } else {
      result.push({ path: branch.path, files });
    }
  }
  return result;
}

// ============================================================================
// Mode-specific audit runners
// ============================================================================

/** Process batch events for combined/per-branch batch modes, yielding results. */
async function processBatchEvents(
  eventIterator: AsyncGenerator<{
    type: "progress" | "result" | "complete";
    branchPath?: string;
    policyName?: string;
    result?: AuditResult;
    usage?: TokenUsage;
    totalUsage?: TokenUsage;
    requestId?: string;
    message?: string;
  }>,
  config: AuditConfig,
  policyLabel: string,
  estimatedCost: number,
  counters: AuditCounters,
): Promise<void> {
  const seenProgressMsgs = new Set<string>();

  for await (const event of eventIterator) {
    if (event.type === "complete") {
      log.info(event.message!);
      if (event.totalUsage) {
        const actualCost = computeActualCost(
          config.auditModel,
          event.totalUsage,
          true,
        );
        log.info(
          formatActualCost(
            config.auditModel,
            event.totalUsage,
            true,
            estimatedCost,
          ),
        );
        events.emit({
          type: "infra.cost.actual",
          model: resolveModelId(config.auditModel),
          actualCost,
          estimatedCost,
          usage: event.totalUsage,
        });
      }
    } else if (event.type === "progress") {
      if (seenProgressMsgs.has(event.message!)) {
        log.debug(event.message!);
      } else {
        log.info(event.message!);
        seenProgressMsgs.add(event.message!);
      }
    } else if (event.type === "result" && event.result && event.branchPath) {
      const scanPolicyLabel = event.policyName ?? policyLabel;
      const { issueCount } = storeAuditResults(
        config,
        event.branchPath,
        scanPolicyLabel,
        event.result,
        event.usage,
        true,
        event.requestId,
      );

      const label = event.policyName
        ? `${event.branchPath}/${scanPolicyLabel}`
        : event.branchPath;
      log.info(`  ${label}: ${issueCount} issues`);
      counters.processed++;
      counters.succeeded++;
    }
  }
}

/** Request cost confirmation from the user, return whether approved. */
async function requestCostApproval(estimate: CostEstimate): Promise<boolean> {
  const requestId = randomUUID();
  events.emit({
    type: "infra.cost.confirm.request",
    estimate,
    requestId,
  });
  return waitForConfirmation(requestId);
}

// ── Diff mode ──

async function runDiffMode(
  config: AuditConfig,
  opts: AuditOptions,
  policyNames: string[],
  policyLabel: string,
): Promise<AuditCounters> {
  const counters: AuditCounters = { processed: 0, succeeded: 0, failed: 0 };

  if (opts.mode !== "cli") {
    const hasKey = await ensureApiKey();
    if (!hasKey) {
      log.info("Audit aborted — no API key provided.");
      return counters;
    }
  }

  const effectiveMaxLoc = opts.maxLoc ?? config.maxLoc;

  log.info(
    opts.diffRef
      ? `Mode: diff (changes since ${opts.diffRef})`
      : "Mode: diff (uncommitted changes)",
  );

  const diffFiles = getDiffFiles(config, opts.diffRef);
  if (diffFiles.length === 0) {
    log.info("No matching changed files found — nothing to audit.");
    return counters;
  }

  log.info(`Changed files: ${diffFiles.length}`);
  log.info("");

  supersedeBeforeScan(config, "(diff)", policyNames, policyLabel);

  const batches = batchFilesForAudit(diffFiles, effectiveMaxLoc);
  for (let i = 0; i < batches.length; i++) {
    const suffix = batches.length > 1 ? ` [batch ${i + 1}]` : "";
    const result = await processBranch(
      "(diff)",
      suffix,
      batches[i]!,
      policyNames,
      policyLabel,
      config,
      opts.mode === "batch" ? "api" : opts.mode,
      policyNames.length >= 2,
    );
    counters.processed++;
    if (result.success) counters.succeeded++;
    else counters.failed++;
  }

  return counters;
}

// ── Batch API mode (per-branch or combined) ──

async function runBatchMode(
  config: AuditConfig,
  opts: AuditOptions,
  policyNames: string[],
  policyLabel: string,
): Promise<AuditCounters> {
  const counters: AuditCounters = { processed: 0, succeeded: 0, failed: 0 };

  const branches = loadBranches(config);
  const auditBranches = filterBranches(
    branches,
    policyNames,
    config,
    opts.forceAll,
  );

  if (auditBranches.length === 0) {
    log.info("No branches to audit.");
    return counters;
  }

  const effectiveMaxLoc = opts.maxLoc ?? config.maxLoc;
  const branchesWithFiles = loadBranchesWithFiles(
    config,
    auditBranches,
    effectiveMaxLoc,
  );

  if (policyNames.length > 1) {
    return runPerBranchBatch(
      config,
      opts,
      policyNames,
      policyLabel,
      branchesWithFiles,
      counters,
    );
  }
  return runCombinedBatch(
    config,
    opts,
    policyNames,
    policyLabel,
    branchesWithFiles,
    counters,
  );
}

/** Per-branch batching: one batch per branch, all policies in each. */
async function runPerBranchBatch(
  config: AuditConfig,
  opts: AuditOptions,
  policyNames: string[],
  policyLabel: string,
  branchesWithFiles: Array<{ path: string; files: string[] }>,
  counters: AuditCounters,
): Promise<AuditCounters> {
  const perBranchEstimate = computePerBranchCostEstimate(config, policyNames, {
    branchesWithFiles,
  });

  log.info(formatPerBranchEstimate(perBranchEstimate));
  events.emit({
    type: "infra.cost.estimate",
    estimate: {
      model: perBranchEstimate.model,
      branchCount: perBranchEstimate.branchCount,
      noCacheCost: perBranchEstimate.totalNoCacheCost,
      standardCost: perBranchEstimate.totalBatchApiCost,
      batchCost: perBranchEstimate.totalBatchApiCost,
    },
  });

  if (opts.dryRun) {
    log.info("\n--dry-run: exiting without executing.");
    return counters;
  }

  if (!opts.costApproved) {
    const confirmEstimate: CostEstimate = {
      model: perBranchEstimate.model,
      branchCount: perBranchEstimate.branchCount,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      noCacheCost: perBranchEstimate.totalNoCacheCost,
      cachingEnabled: true,
      cachingSavings:
        perBranchEstimate.totalNoCacheCost -
        perBranchEstimate.totalBatchApiCost,
      standardApiCost: perBranchEstimate.totalBatchApiCost,
      batchApiCost: perBranchEstimate.totalBatchApiCost,
      batchNoCacheCost: perBranchEstimate.totalNoCacheCost,
      batchWithCacheCost: perBranchEstimate.totalBatchApiCost,
      batchCachingEnabled: true,
    };
    const approved = await requestCostApproval(confirmEstimate);
    if (!approved) {
      log.info("Audit cancelled by user.");
      return counters;
    }
  }

  const hasKey = await ensureApiKey();
  if (!hasKey) {
    log.info("Audit aborted — no API key provided.");
    return counters;
  }

  const useCaching =
    perBranchEstimate.totalBatchApiCost < perBranchEstimate.totalNoCacheCost;
  const estimatedCost = useCaching
    ? perBranchEstimate.totalBatchApiCost
    : perBranchEstimate.totalNoCacheCost;

  const addendumCtx = buildAddendumContext(config);
  const { auditViaBatchPerBranch } = await import("./api-backend");
  await processBatchEvents(
    auditViaBatchPerBranch(
      branchesWithFiles,
      policyNames,
      config,
      useCaching,
      addendumCtx,
    ),
    config,
    policyLabel,
    estimatedCost,
    counters,
  );

  return counters;
}

/** Single-policy combined batch: all branches in one batch. */
async function runCombinedBatch(
  config: AuditConfig,
  opts: AuditOptions,
  policyNames: string[],
  policyLabel: string,
  branchesWithFiles: Array<{ path: string; files: string[] }>,
  counters: AuditCounters,
): Promise<AuditCounters> {
  const addendumCtx = buildAddendumContext(config);
  const systemPrompt = buildSystemPrompt(config, policyNames, addendumCtx);
  const systemTokens = estimateTokens(systemPrompt.length);

  // Calculate avg branch size in a single pass
  let totalBranchChars = 0;
  for (const b of branchesWithFiles) {
    for (const f of b.files) {
      totalBranchChars += Bun.file(f).size ?? 0;
    }
  }
  const avgBranchChars =
    totalBranchChars / Math.max(branchesWithFiles.length, 1);
  const avgBranchTokens = estimateTokens(avgBranchChars);

  const estimate = estimateCost(
    config.auditModel,
    branchesWithFiles.length,
    systemTokens,
    avgBranchTokens,
    1500,
  );

  log.info(formatEstimate(estimate));
  events.emit({
    type: "infra.cost.estimate",
    estimate: {
      model: estimate.model,
      branchCount: estimate.branchCount,
      noCacheCost: estimate.noCacheCost,
      standardCost: estimate.standardApiCost,
      batchCost: estimate.batchApiCost,
    },
  });

  if (opts.dryRun) {
    log.info("\n--dry-run: exiting without executing.");
    return counters;
  }

  if (!opts.costApproved) {
    const approved = await requestCostApproval(estimate);
    if (!approved) {
      log.info("Audit cancelled by user.");
      return counters;
    }
  }

  const hasKey = await ensureApiKey();
  if (!hasKey) {
    log.info("Audit aborted — no API key provided.");
    return counters;
  }

  const useCaching = estimate.batchCachingEnabled;
  const { auditViaBatch } = await import("./api-backend");
  await processBatchEvents(
    auditViaBatch(
      branchesWithFiles,
      policyNames,
      config,
      useCaching,
      addendumCtx,
    ),
    config,
    policyLabel,
    estimate.batchApiCost,
    counters,
  );

  return counters;
}

// ── Normal branch-based mode (CLI or single API) ──

async function runNormalMode(
  config: AuditConfig,
  opts: AuditOptions,
  policyNames: string[],
  policyLabel: string,
): Promise<AuditCounters> {
  const counters: AuditCounters = { processed: 0, succeeded: 0, failed: 0 };

  if (opts.mode !== "cli") {
    const hasKey = await ensureApiKey();
    if (!hasKey) {
      log.info("Audit aborted — no API key provided.");
      return counters;
    }
  }

  const effectiveMaxLoc = opts.maxLoc ?? config.maxLoc;

  const branches = loadBranches(config);
  const auditBranches = filterBranches(
    branches,
    policyNames,
    config,
    opts.forceAll,
  );

  if (auditBranches.length === 0) {
    log.info("No branches to audit.");
    return counters;
  }

  log.info("");

  let consecutiveErrors = 0;
  let lastErrorType = "";
  const useCaching = policyNames.length >= 2;

  for (const branch of auditBranches) {
    const fullPath = resolve(config.projectRoot, branch.path);

    if (!existsSync(fullPath)) {
      log.warn(`Skipping ${branch.raw}: directory not found`);
      const scanId = insertScan(config, branch.raw, policyLabel, 0, 0);
      updateScanStatus(config, scanId, "skipped");
      continue;
    }

    const files = findSourceFiles(fullPath, branch.isFlat, config);
    if (files.length === 0) {
      log.warn(`Skipping ${branch.raw}: no matching files`);
      continue;
    }

    const totalLoc = countLoc(files);

    supersedeBeforeScan(config, branch.path, policyNames, policyLabel);

    if (totalLoc <= effectiveMaxLoc) {
      const result = await processBranch(
        branch.path,
        "",
        files,
        policyNames,
        policyLabel,
        config,
        opts.mode,
        useCaching,
      );
      counters.processed++;

      if (result.success) {
        counters.succeeded++;
        consecutiveErrors = 0;
        lastErrorType = "";
      } else {
        counters.failed++;
        if (result.errorType === lastErrorType) {
          consecutiveErrors++;
        } else {
          consecutiveErrors = 1;
          lastErrorType = result.errorType ?? "unknown";
        }
        if (consecutiveErrors >= 2) {
          log.error(
            `Aborting: same error occurred ${consecutiveErrors} times in a row: ${lastErrorType}`,
          );
          break;
        }
      }
    } else {
      // Branch exceeds LOC limit — split into batches
      log.info(
        `Branch ${branch.path} exceeds LOC limit (${totalLoc} > ${effectiveMaxLoc}), splitting`,
      );
      const batches = batchFilesForAudit(files, effectiveMaxLoc);
      let batchFailed = false;

      for (let i = 0; i < batches.length; i++) {
        const result = await processBranch(
          branch.path,
          ` [batch ${i + 1}]`,
          batches[i]!,
          policyNames,
          policyLabel,
          config,
          opts.mode,
          useCaching,
        );
        if (!result.success) batchFailed = true;
      }

      counters.processed++;
      if (batchFailed) {
        counters.failed++;
        const errorType = "batch_failure";
        if (errorType === lastErrorType) {
          consecutiveErrors++;
        } else {
          consecutiveErrors = 1;
          lastErrorType = errorType;
        }
        if (consecutiveErrors >= 2) {
          log.error(
            `Aborting: same error occurred ${consecutiveErrors} times in a row: ${lastErrorType}`,
          );
          break;
        }
      } else {
        counters.succeeded++;
        consecutiveErrors = 0;
        lastErrorType = "";
      }
    }

    // Rate limiting for CLI mode
    if (opts.mode === "cli") {
      await Bun.sleep(2000);
    }
  }

  return counters;
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Run the audit pipeline. Delegates to mode-specific runners:
 * - diff mode: audits only changed files
 * - batch mode: submits all branches as API batches
 * - normal mode: processes branches sequentially (CLI or API)
 */
export async function runAudit(
  config: AuditConfig,
  opts: AuditOptions,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  // Validate policies
  const policyNames =
    opts.policies.length > 0 ? opts.policies : discoverPolicies(config);
  if (policyNames.length === 0) {
    log.error(
      "No policies found. Create policies in policies/<name>/POLICY.md",
    );
    process.exit(1);
  }

  for (const name of policyNames) {
    const policyFile = resolve(config.policiesDir, name, "POLICY.md");
    if (!existsSync(policyFile)) {
      log.error(`Policy not found: ${name}`);
      process.exit(1);
    }
  }

  const policyLabel = policyNames.join("|");

  log.info(
    policyNames.length === 1
      ? `Code Quality Audit — Policy: ${policyLabel}`
      : `Code Quality Audit — Combined (${policyNames.length} policies)`,
  );
  log.info("=============================================");
  log.info("");

  // Initialize database
  log.info(`Initializing database at: ${config.dbPath}`);
  initDatabase(config);
  log.info("");

  events.emit({
    type: "audit.start",
    policy: policyLabel,
    branchCount: 0, // updated below once known
    policyIndex: 0,
    totalPolicies: policyNames.length,
  });

  // Dispatch to mode-specific runner
  let counters: AuditCounters;
  if (opts.diffMode) {
    counters = await runDiffMode(config, opts, policyNames, policyLabel);
  } else if (opts.mode === "cli") {
    counters = await runNormalMode(config, opts, policyNames, policyLabel);
  } else {
    // Both "api" and "batch" use batch processing
    counters = await runBatchMode(config, opts, policyNames, policyLabel);
  }

  // Summary
  log.info("");
  log.info("==============================");
  log.info(`Audit Summary — ${policyLabel}`);
  log.info("==============================");
  log.info(
    `Branches processed: ${counters.processed} (${counters.succeeded} succeeded, ${counters.failed} failed)`,
  );

  events.emit({
    type: "audit.complete",
    policy: policyLabel,
    processed: counters.processed,
    succeeded: counters.succeeded,
    failed: counters.failed,
  });

  // Scrub ephemeral key so it doesn't leak into later stages or re-runs
  clearEphemeralApiKey();

  return counters;
}

// ============================================================================
// Cost estimation
// ============================================================================

/**
 * Compute a per-branch cost estimate without executing the audit.
 * Loads branches/files if not provided, reads policy text for token counts.
 */
export function computePerBranchCostEstimate(
  config: AuditConfig,
  policyNames: string[],
  preloaded?: { branchesWithFiles: Array<{ path: string; files: string[] }> },
): PerBranchCostEstimate {
  const branchesWithFiles =
    preloaded?.branchesWithFiles ??
    (() => {
      const branches = loadBranches(config);
      return loadBranchesWithFiles(config, branches);
    })();

  // Compute average branch tokens in a single pass
  let totalBranchChars = 0;
  for (const b of branchesWithFiles) {
    for (const f of b.files) {
      totalBranchChars += Bun.file(f).size ?? 0;
    }
  }
  const avgBranchChars =
    totalBranchChars / Math.max(branchesWithFiles.length, 1);
  const avgBranchTokens = estimateTokens(avgBranchChars);

  // Build addendum context for cost estimation (config-level only, no per-file imports)
  const addendumCtx = buildAddendumContext(config);

  // Instruction tokens (shared audit instructions without policy text)
  const instructionTokens = estimateTokens(
    buildSystemPrompt(config, [policyNames[0]!], addendumCtx).length,
  );

  // Per-policy token counts from policy files (including matched addendums)
  const policyTokensList = policyNames.map((name) => {
    const policyFile = resolve(config.policiesDir, name, "POLICY.md");
    let content = cachedReadFile(policyFile) ?? "";
    const addendumText = loadMatchingAddendums(
      resolve(config.policiesDir, name),
      addendumCtx,
    );
    if (addendumText) content += "\n\n" + addendumText;
    const tokens = estimateTokens(content.length);
    return { name, tokens };
  });

  return estimatePerBranchCost(
    config.auditModel,
    branchesWithFiles.length,
    avgBranchTokens,
    instructionTokens,
    policyTokensList,
    1500,
  );
}
