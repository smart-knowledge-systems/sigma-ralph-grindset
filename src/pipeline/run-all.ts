// ============================================================================
// Full pipeline orchestrator — generates branches, audits, fixes, checkpoints
// ============================================================================

import { existsSync } from "fs";
import type { AuditConfig, AuditMode } from "../types";
import { log, initFileLogging, cleanupLogs } from "../logging";
import { events } from "../events";
import { initDatabase, recordCheckpoint } from "../db";
import { generateBranches } from "../branches/generate";
import {
  runAudit,
  discoverPolicies,
  computePerBranchCostEstimate,
  waitForConfirmation,
} from "../audit/run-audit";
import { formatPerBranchEstimate } from "../pricing";
import { randomUUID } from "crypto";
import { runFixes } from "../fixes/run-fixes";

interface PipelineOptions {
  forceAll: boolean;
  diffMode: boolean;
  diffRef?: string;
  mode: AuditMode;
}

/**
 * Run the full audit pipeline: generate branches, audit, fix, checkpoint.
 */
export async function runPipeline(
  config: AuditConfig,
  opts: PipelineOptions,
): Promise<void> {
  // Validate mutual exclusivity
  if (opts.diffMode && opts.forceAll) {
    throw new Error("--diff and --all are mutually exclusive");
  }

  // Initialize logging
  initFileLogging(config.auditDir);
  let pipelineSuccess = false;

  try {
    events.emit({
      type: "infra.pipeline.start",
      phase: "pipeline",
      totalPolicies: 0,
    });
    log.info("=== Full Audit Pipeline ===");
    if (opts.diffMode) {
      log.info("Mode: diff (changed files only)");
    } else if (opts.forceAll) {
      log.info("Mode: full audit (--all)");
    }
    log.info("");

    // Discover policies
    const policies = discoverPolicies(config);
    if (policies.length === 0) {
      throw new Error(
        "No policies found. Create policies in policies/<name>/POLICY.md",
      );
    }

    // Update totalPolicies now that we know
    events.emit({
      type: "infra.pipeline.start",
      phase: "pipeline",
      totalPolicies: policies.length,
    });
    log.info(`Discovered ${policies.length} policies: ${policies.join(", ")}`, {
      event: "infra.pipeline.policies",
      policyCount: policies.length,
      policies,
    });

    // Step 1: Generate branches (skip in diff mode)
    if (!opts.diffMode) {
      events.emit({
        type: "infra.pipeline.phase",
        phase: "branches",
        status: "started",
      });
      log.info("--- Step 1: Generate branches ---");
      generateBranches(config);
      events.emit({
        type: "infra.pipeline.phase",
        phase: "branches",
        status: "completed",
      });
      log.info("");
    }

    // Capture HEAD commit for checkpoint recording
    const checkpointCommit =
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: config.projectRoot })
        .stdout.toString()
        .trim() || null;

    // Step 2: Run audit (API key checked inside mode runners, after cost approval)
    events.emit({
      type: "infra.pipeline.phase",
      phase: "audit",
      status: "started",
    });
    if (opts.mode === "cli" || policies.length === 1) {
      // CLI mode or single policy: sequential per-policy
      for (let i = 0; i < policies.length; i++) {
        const policyName = policies[i]!;
        log.info(
          `--- Step 2: Audit policy: ${policyName} (${i + 1}/${policies.length}) ---`,
        );
        await runAudit(config, {
          policies: [policyName],
          forceAll: opts.forceAll,
          diffMode: opts.diffMode,
          diffRef: opts.diffRef,
          mode: opts.mode,
          dryRun: false,
        });
        log.info("");
      }
    } else {
      // Multi-policy batch: compute upfront cost, single confirmation, parallel batches
      log.info(
        `--- Step 2: Audit (${policies.length} policies, per-branch batch) ---`,
      );

      const estimate = computePerBranchCostEstimate(config, policies);
      log.info(formatPerBranchEstimate(estimate));
      events.emit({
        type: "infra.cost.estimate.aggregated",
        estimate,
      });

      // Single confirmation for all policies
      const requestId = randomUUID();
      events.emit({
        type: "infra.cost.confirm.request",
        estimate: {
          model: estimate.model,
          branchCount: estimate.branchCount,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          noCacheCost: estimate.totalNoCacheCost,
          cachingEnabled: true,
          cachingSavings:
            estimate.totalNoCacheCost - estimate.totalBatchApiCost,
          standardApiCost: estimate.totalBatchApiCost,
          batchApiCost: estimate.totalBatchApiCost,
          batchNoCacheCost: estimate.totalNoCacheCost,
          batchWithCacheCost: estimate.totalBatchApiCost,
          batchCachingEnabled: true,
        },
        requestId,
      });

      const approved = await waitForConfirmation(requestId);
      if (!approved) {
        log.info("Audit cancelled by user.");
        events.emit({
          type: "infra.pipeline.complete",
          success: false,
        });
        return;
      }

      await runAudit(config, {
        policies,
        forceAll: opts.forceAll,
        diffMode: opts.diffMode,
        diffRef: opts.diffRef,
        mode: opts.mode,
        dryRun: false,
        costApproved: true,
      });
      log.info("");
    }

    events.emit({
      type: "infra.pipeline.phase",
      phase: "audit",
      status: "completed",
    });

    // Step 3: Run fixes
    events.emit({
      type: "infra.pipeline.phase",
      phase: "fix",
      status: "started",
    });
    log.info("--- Step 3: Run fixes ---");
    await runFixes(config);
    events.emit({
      type: "infra.pipeline.phase",
      phase: "fix",
      status: "completed",
    });
    log.info("");

    // Step 4: Record checkpoints (skip in diff mode)
    if (opts.diffMode) {
      log.info("--- Skipping checkpoint recording (diff mode) ---");
    } else {
      log.info("--- Step 4: Record audit checkpoints ---");
      if (!checkpointCommit) {
        log.info("  No git history - skipping checkpoint recording");
      } else if (existsSync(config.dbPath)) {
        initDatabase(config);
        for (const policyName of policies) {
          recordCheckpoint(config, policyName, checkpointCommit);
          log.info(
            `  Checkpoint: ${policyName} -> ${checkpointCommit.slice(0, 8)}`,
          );
        }
      } else {
        log.info("  No audit.db found - skipping checkpoint recording");
      }
      log.info("");
    }

    pipelineSuccess = true;
    events.emit({ type: "infra.pipeline.complete", success: true });
    log.info("=== Pipeline complete ===");
  } finally {
    if (!pipelineSuccess) {
      events.emit({ type: "infra.pipeline.complete", success: false });
    }
    const failedDir = cleanupLogs(pipelineSuccess, config.auditDir);
    if (failedDir) {
      log.error(`Logs saved to: ${failedDir}`, {
        event: "infra.pipeline.logs.saved",
        logDir: failedDir,
      });
    }
  }
}
