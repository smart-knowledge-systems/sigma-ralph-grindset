// ============================================================================
// Audit orchestrator — coordinates branch processing
// ============================================================================

import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type {
  AuditConfig,
  AuditMode,
  Branch,
  CostEstimate,
  PerBranchCostEstimate,
} from "../types";
import { log } from "../logging";
import { events } from "../events";
import { initDatabase, getCheckpointCommit } from "../db";
import { loadBranches, fileToBranch, getDiffFiles } from "../branches/loader";
import {
  findSourceFiles,
  countLoc,
  matchesExtensions,
  isExcludedPath,
} from "../branches/scanner";
import { processBranch } from "./process-branch";
import { auditViaBatch, auditViaBatchPerBranch } from "./api-backend";
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
} from "../pricing";
import { buildSystemPrompt } from "./prompts";
import { randomUUID } from "crypto";

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
 * Run the audit pipeline.
 */
export async function runAudit(
  config: AuditConfig,
  opts: AuditOptions,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const effectiveMaxLoc = opts.maxLoc ?? config.maxLoc;

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

  // Cost estimation for API mode
  if ((opts.mode === "api" || opts.mode === "batch") && !opts.dryRun) {
    // We'll show estimation before proceeding — compute after loading branches
  }

  events.emit({
    type: "audit:start",
    policy: policyLabel,
    branchCount: 0, // updated below once known
    policyIndex: 0,
    totalPolicies: policyNames.length,
  });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  if (opts.diffMode) {
    // ── Diff mode ──
    log.info(
      opts.diffRef
        ? `Mode: diff (changes since ${opts.diffRef})`
        : "Mode: diff (uncommitted changes)",
    );

    const diffFiles = getDiffFiles(config, opts.diffRef);
    if (diffFiles.length === 0) {
      log.info("No matching changed files found — nothing to audit.");
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    log.info(`Changed files: ${diffFiles.length}`);
    log.info("");

    // Batch files by MAX_LOC
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
      processed++;
      if (result.success) succeeded++;
      else failed++;
    }
  } else if (opts.mode === "batch") {
    // ── Batch API mode ──
    const branches = loadBranches(config);
    const auditBranches = filterBranches(
      branches,
      policyNames,
      config,
      opts.forceAll,
    );

    if (auditBranches.length === 0) {
      log.info("No branches to audit.");
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    // Prepare all branches with their files
    const branchesWithFiles: Array<{ path: string; files: string[] }> = [];
    for (const branch of auditBranches) {
      const fullPath = resolve(config.projectRoot, branch.path);
      if (!existsSync(fullPath)) continue;
      const files = findSourceFiles(fullPath, branch.isFlat, config);
      if (files.length === 0) continue;
      branchesWithFiles.push({ path: branch.path, files });
    }

    // Validate API key before submitting
    if (!process.env.ANTHROPIC_API_KEY) {
      log.error("ANTHROPIC_API_KEY not set.");
      log.error("");
      log.error("  Option 1: Set your API key:");
      log.error("    export ANTHROPIC_API_KEY=<your-api-key>");
      log.error("");
      log.error("  Option 2: Use the Claude CLI instead:");
      log.error("    bun audit --cli");
      log.error("    (requires `claude` CLI installed)");
      process.exit(1);
    }

    if (policyNames.length > 1) {
      // ── Per-branch batching: one batch per branch, all policies in each ──
      const perBranchEstimate = computePerBranchCostEstimate(
        config,
        policyNames,
        { branchesWithFiles },
      );

      log.info(formatPerBranchEstimate(perBranchEstimate));
      events.emit({
        type: "cost:estimate",
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
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      // Cost confirmation gate (skip if pre-approved)
      if (!opts.costApproved) {
        const requestId = randomUUID();
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
        events.emit({
          type: "cost:confirm-request",
          estimate: confirmEstimate,
          requestId,
        });

        const approved = await waitForConfirmation(requestId);
        if (!approved) {
          log.info("Audit cancelled by user.");
          return { processed: 0, succeeded: 0, failed: 0 };
        }
      }

      // Submit per-branch batches
      let lastProgressMsg = "";
      for await (const event of auditViaBatchPerBranch(
        branchesWithFiles,
        policyNames,
        config,
      )) {
        if (event.type === "complete") {
          log.info(event.message!);
          if (event.totalUsage) {
            log.info(
              formatActualCost(
                config.auditModel,
                event.totalUsage,
                true,
                perBranchEstimate.totalBatchApiCost,
              ),
            );
          }
        } else if (event.type === "progress") {
          if (event.message === lastProgressMsg) {
            log.debug(event.message!);
          } else {
            log.info(event.message!);
            lastProgressMsg = event.message!;
          }
        } else if (
          event.type === "result" &&
          event.result &&
          event.branchPath
        ) {
          const scanPolicyLabel = event.policyName ?? policyLabel;
          const scanId = insertScan(
            config,
            event.branchPath,
            scanPolicyLabel,
            0,
            0,
          );
          let issueCount = 0;
          for (const issue of event.result.issues) {
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
          if (event.usage) {
            const cost = computeActualCost(
              config.auditModel,
              event.usage,
              true,
            );
            updateScanUsage(config, scanId, event.usage, cost);
          }
          log.info(
            `  ${event.branchPath}/${scanPolicyLabel}: ${issueCount} issues`,
          );
          processed++;
          succeeded++;
        }
      }
    } else {
      // ── Single policy batch: existing combined batch ──
      const systemPrompt = buildSystemPrompt(config, policyNames);
      const systemTokens = estimateTokens(systemPrompt.length);
      const avgBranchChars =
        branchesWithFiles.reduce((sum, b) => {
          return sum + b.files.reduce((s, f) => s + (Bun.file(f).size ?? 0), 0);
        }, 0) / Math.max(branchesWithFiles.length, 1);
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
        type: "cost:estimate",
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
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      // Cost confirmation gate (skip if pre-approved)
      if (!opts.costApproved) {
        const requestId = randomUUID();
        events.emit({
          type: "cost:confirm-request",
          estimate,
          requestId,
        });

        const approved = await waitForConfirmation(requestId);
        if (!approved) {
          log.info("Audit cancelled by user.");
          return { processed: 0, succeeded: 0, failed: 0 };
        }
      }

      // Submit batch
      const useCaching = estimate.batchCachingEnabled;
      let lastProgressMsg = "";
      for await (const event of auditViaBatch(
        branchesWithFiles,
        policyNames,
        config,
        useCaching,
      )) {
        if (event.type === "complete") {
          log.info(event.message!);
          if (event.totalUsage) {
            log.info(
              formatActualCost(
                config.auditModel,
                event.totalUsage,
                true,
                estimate.batchApiCost,
              ),
            );
          }
        } else if (event.type === "progress") {
          if (event.message === lastProgressMsg) {
            log.debug(event.message!);
          } else {
            log.info(event.message!);
            lastProgressMsg = event.message!;
          }
        } else if (
          event.type === "result" &&
          event.result &&
          event.branchPath
        ) {
          // Store results
          const scanId = insertScan(
            config,
            event.branchPath,
            policyLabel,
            0,
            0,
          );
          let issueCount = 0;
          for (const issue of event.result.issues) {
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
          if (event.usage) {
            const cost = computeActualCost(
              config.auditModel,
              event.usage,
              true,
            );
            updateScanUsage(config, scanId, event.usage, cost, event.requestId);
          }
          log.info(`  ${event.branchPath}: ${issueCount} issues`);
          processed++;
          succeeded++;
        }
      }
    }
  } else {
    // ── Normal branch-based mode (CLI or single API) ──
    const branches = loadBranches(config);
    const auditBranches = filterBranches(
      branches,
      policyNames,
      config,
      opts.forceAll,
    );

    if (auditBranches.length === 0) {
      log.info("No branches to audit.");
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    log.info("");

    // Consecutive error tracking
    let consecutiveErrors = 0;
    let lastErrorType = "";

    const useCaching = policyNames.length >= 2;

    for (const branch of auditBranches) {
      const fullPath = resolve(config.projectRoot, branch.path);

      if (!existsSync(fullPath)) {
        log.warn(`Skipping ${branch.raw}: directory not found`);
        insertScan(config, branch.raw, policyLabel, 0, 0);
        updateScanStatus(
          config,
          insertScan(config, branch.raw, policyLabel, 0, 0),
          "skipped",
        );
        continue;
      }

      const files = findSourceFiles(fullPath, branch.isFlat, config);
      if (files.length === 0) {
        log.warn(`Skipping ${branch.raw}: no matching files`);
        continue;
      }

      const totalLoc = countLoc(files);

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
        processed++;
        if (result.success) {
          succeeded++;
          consecutiveErrors = 0;
          lastErrorType = "";
        } else {
          failed++;
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
        // Split into batches
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

        processed++;
        if (batchFailed) {
          failed++;
          // Track error for consecutive abort
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
          succeeded++;
          consecutiveErrors = 0;
          lastErrorType = "";
        }
      }

      // Rate limiting for CLI mode
      if (opts.mode === "cli") {
        await Bun.sleep(2000);
      }
    }
  }

  // Summary
  log.info("");
  log.info("==============================");
  log.info(`Audit Summary — ${policyLabel}`);
  log.info("==============================");
  log.info(
    `Branches processed: ${processed} (${succeeded} succeeded, ${failed} failed)`,
  );

  events.emit({
    type: "audit:complete",
    policy: policyLabel,
    processed,
    succeeded,
    failed,
  });

  return { processed, succeeded, failed };
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

  // Get changed files since checkpoint
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
    const unsub = events.on("cost:confirm-response", (e) => {
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
      resolve(input !== "n" && input !== "no");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Split files into batches by LOC. */
function batchFilesForAudit(files: string[], maxLoc: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLoc = 0;

  for (const file of files) {
    const fileLoc = countLoc([file]);
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

/**
 * Compute a per-branch cost estimate without executing the audit.
 * Loads branches/files if not provided, reads policy text for token counts.
 */
export function computePerBranchCostEstimate(
  config: AuditConfig,
  policyNames: string[],
  preloaded?: { branchesWithFiles: Array<{ path: string; files: string[] }> },
): PerBranchCostEstimate {
  // Load branches/files if not pre-provided
  const branchesWithFiles =
    preloaded?.branchesWithFiles ??
    (() => {
      const branches = loadBranches(config);
      const result: Array<{ path: string; files: string[] }> = [];
      for (const branch of branches) {
        const fullPath = resolve(config.projectRoot, branch.path);
        if (!existsSync(fullPath)) continue;
        const files = findSourceFiles(fullPath, branch.isFlat, config);
        if (files.length === 0) continue;
        result.push({ path: branch.path, files });
      }
      return result;
    })();

  // Compute average branch tokens
  const avgBranchChars =
    branchesWithFiles.reduce((sum, b) => {
      return sum + b.files.reduce((s, f) => s + (Bun.file(f).size ?? 0), 0);
    }, 0) / Math.max(branchesWithFiles.length, 1);
  const avgBranchTokens = estimateTokens(avgBranchChars);

  // Instruction tokens (shared audit instructions without policy text)
  const instructionTokens = estimateTokens(
    buildSystemPrompt(config, [policyNames[0]!]).length,
  );

  // Per-policy token counts from policy files
  const policyTokensList = policyNames.map((name) => {
    const policyFile = resolve(config.policiesDir, name, "POLICY.md");
    let tokens = 0;
    if (existsSync(policyFile)) {
      const content = readFileSync(policyFile, "utf-8");
      tokens = estimateTokens(content.length);
    }
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
