// ============================================================================
// Full pipeline orchestrator — generates branches, audits, fixes, checkpoints
// ============================================================================

import { existsSync } from "fs";
import type { AuditConfig, AuditMode } from "../types";
import { log, initFileLogging, cleanupLogs } from "../logging";
import { events } from "../events";
import { initDatabase, recordCheckpoint } from "../db";
import { generateBranches } from "../branches/generate";
import { runAudit, discoverPolicies } from "../audit/run-audit";
import { runFixes } from "../fixes/run-fixes";

interface PipelineOptions {
  forceAll: boolean;
  diffMode: boolean;
  diffRef?: string;
  combinedMode: boolean;
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
    log.error("--diff and --all are mutually exclusive");
    process.exit(2);
  }

  // Initialize logging
  initFileLogging(config.auditDir);
  let pipelineSuccess = false;

  try {
    events.emit({
      type: "pipeline:start",
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
      log.error(
        "No policies found. Create policies in policies/<name>/POLICY.md",
      );
      process.exit(1);
    }

    // Update totalPolicies now that we know
    events.emit({
      type: "pipeline:start",
      phase: "pipeline",
      totalPolicies: policies.length,
    });

    // Step 1: Generate branches (skip in diff mode)
    if (!opts.diffMode) {
      events.emit({
        type: "pipeline:phase",
        phase: "branches",
        status: "started",
      });
      log.info("--- Step 1: Generate branches ---");
      generateBranches(config);
      events.emit({
        type: "pipeline:phase",
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

    // Step 2: Run audit
    events.emit({ type: "pipeline:phase", phase: "audit", status: "started" });
    if (opts.combinedMode) {
      log.info(`--- Step 2: Audit combined (${policies.length} policies) ---`);
      await runAudit(config, {
        policies,
        forceAll: opts.forceAll,
        diffMode: opts.diffMode,
        diffRef: opts.diffRef,
        mode: opts.mode,
        dryRun: false,
        maxLoc: 2000,
      });
      log.info("");
    } else {
      // Per-policy loop
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
    }

    events.emit({
      type: "pipeline:phase",
      phase: "audit",
      status: "completed",
    });

    // Step 3: Run fixes
    events.emit({ type: "pipeline:phase", phase: "fix", status: "started" });
    log.info("--- Step 3: Run fixes ---");
    await runFixes(config);
    events.emit({ type: "pipeline:phase", phase: "fix", status: "completed" });
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
    events.emit({ type: "pipeline:complete", success: true });
    log.info("=== Pipeline complete ===");
  } finally {
    if (!pipelineSuccess) {
      events.emit({ type: "pipeline:complete", success: false });
    }
    const failedDir = cleanupLogs(pipelineSuccess, config.auditDir);
    if (failedDir) {
      log.error(`Logs saved to: ${failedDir}`);
    }
  }
}
