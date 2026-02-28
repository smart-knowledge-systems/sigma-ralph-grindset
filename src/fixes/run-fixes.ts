// ============================================================================
// Fix orchestrator — batches pending issues and dispatches to executor
// ============================================================================

import { existsSync } from "fs";
import { dirname } from "path";
import type { AuditConfig } from "../types";
import { log } from "../logging";
import { events } from "../events";
import { getDb, initDatabase, getPendingIssuesForFiles } from "../db";
import { getFixFilesWithLoc, batchFilesByLoc } from "./batching";
import { buildFixSystemPrompt, buildFixPrompt } from "./prompts";
import { fixBatch } from "./executor";

interface RunFixesOptions {
  interactive?: boolean;
  skipCommits?: boolean;
  policyFilter?: string;
}

/** Set up the fix branch in git. */
function setupGit(config: AuditConfig): void {
  const shortHash = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: config.projectRoot,
  })
    .stdout.toString()
    .trim();

  const fixBranch = `fix/audit-improvements-${shortHash}`;

  const currentBranch = Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd: config.projectRoot,
  })
    .stdout.toString()
    .trim();

  if (currentBranch === fixBranch) {
    log.info(`Already on ${fixBranch}`);
    return;
  }

  // Check for clean working tree
  const diffResult = Bun.spawnSync(["git", "diff", "--quiet"], {
    cwd: config.projectRoot,
  });
  const cachedResult = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
    cwd: config.projectRoot,
  });

  if (diffResult.exitCode !== 0 || cachedResult.exitCode !== 0) {
    log.error("Working tree is not clean. Commit or stash changes first.");
    process.exit(1);
  }

  // Delete stale fix branch if it exists
  const showRef = Bun.spawnSync(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${fixBranch}`],
    { cwd: config.projectRoot },
  );
  if (showRef.exitCode === 0) {
    Bun.spawnSync(["git", "branch", "-D", fixBranch], {
      cwd: config.projectRoot,
    });
  }

  Bun.spawnSync(["git", "checkout", "-b", fixBranch], {
    cwd: config.projectRoot,
  });
}

/** Get distinct policies for a set of issue IDs. */
function getPoliciesForIssues(
  config: AuditConfig,
  issueIds: number[],
): string[] {
  const d = getDb(config);
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = d
    .prepare(
      `SELECT DISTINCT i.policy FROM issues i WHERE i.id IN (${placeholders}) AND i.policy != ''`,
    )
    .all(...issueIds) as Array<{ policy: string }>;
  return rows.map((r) => r.policy);
}

/** Count total pending issues with optional policy filter. */
function countPendingIssues(
  config: AuditConfig,
  policySqlFilter: string,
): number {
  const d = getDb(config);
  const row = d
    .prepare(
      `SELECT COUNT(*) as cnt FROM issues i JOIN scans s ON i.scan_id = s.id WHERE i.fix_status = 'pending' ${policySqlFilter}`,
    )
    .get() as { cnt: number };
  return row.cnt;
}

/** Build a directory summary label from file paths. */
function dirSummary(files: string[]): string {
  const dirs = [...new Set(files.map((f) => dirname(f)))].sort().slice(0, 3);
  return dirs.join(", ");
}

/**
 * Run the fix pipeline: load pending issues, batch by LOC, fix each batch.
 */
export async function runFixes(
  config: AuditConfig,
  opts: RunFixesOptions = {},
): Promise<{ fixed: number; failed: number }> {
  log.info("=== Fix Audit Issues ===");
  log.info("");

  // Preflight checks
  if (!existsSync(config.dbPath)) {
    log.error("audit.db not found. Run audit first.");
    process.exit(1);
  }

  // Ensure schema is initialized
  initDatabase(config);

  // Validate policy filter
  if (opts.policyFilter) {
    const policyPath = `${config.policiesDir}/${opts.policyFilter}/POLICY.md`;
    if (!existsSync(policyPath)) {
      log.error(`Policy not found: ${opts.policyFilter}`);
      process.exit(1);
    }
    log.info(`Filtering fixes to policy: ${opts.policyFilter}`);
  }

  if (opts.skipCommits) {
    log.warn("--dangerously-skip-commits is set. Fixes will not be committed.");
  }

  // Git setup
  if (!opts.skipCommits) {
    setupGit(config);
  }

  // Build SQL filter clause
  const policySqlFilter = opts.policyFilter
    ? `AND s.policy = '${opts.policyFilter.replace(/'/g, "''")}'`
    : "";

  // Build LOC-based batches
  const filesWithLoc = getFixFilesWithLoc(config, policySqlFilter);
  if (filesWithLoc.length === 0) {
    log.info("No pending issues to fix.");
    return { fixed: 0, failed: 0 };
  }

  const batches = batchFilesByLoc(filesWithLoc, config.maxFixLoc);
  const totalBatches = batches.length;
  const totalPending = countPendingIssues(config, policySqlFilter);

  events.emit({
    type: "fix:start",
    totalBatches,
    totalIssues: totalPending,
  });
  log.info(
    `Batches to fix: ${totalBatches} (${totalPending} issues, MAX_FIX_LOC=${config.maxFixLoc})`,
  );
  log.info("");

  let fixed = 0;
  let failed = 0;

  for (const batch of batches) {
    const summary = dirSummary(batch.files);
    const batchLabel = `batch ${batch.batchNum}/${totalBatches} (${summary})`;

    log.info("--------------------------------------");
    log.info(`Fixing: ${batchLabel}`);
    log.info(`  Files: ${batch.files.length}`);

    // Get issues for the files in this batch
    const issues = getPendingIssuesForFiles(config, batch.files);
    if (issues.length === 0) {
      log.info("  No pending issues remain for this batch. Skipping.");
      log.info("");
      continue;
    }

    const issueIds = issues.map((i) => i.id);
    log.info(`  Issues: ${issues.length}`);

    // Get policies for these issues
    const policies = getPoliciesForIssues(config, issueIds);
    if (policies.length > 0) {
      log.info(`  Policies: ${policies.join(", ")}`);
    }

    // Build prompts
    const systemPrompt = buildFixSystemPrompt(
      config,
      policies.length > 0 ? policies : ["default"],
    );
    const prompt = buildFixPrompt(batch.files, issues);

    const success = await fixBatch(
      batchLabel,
      prompt,
      systemPrompt,
      issueIds,
      batch.files.length,
      issues.length,
      config,
      {
        interactive: opts.interactive,
        skipCommits: opts.skipCommits,
        batchNum: batch.batchNum,
        totalBatches,
      },
    );

    if (success) {
      fixed++;
    } else {
      failed++;
    }

    log.info("");
  }

  events.emit({ type: "fix:complete", fixed, failed });

  // Summary
  log.info("=== FIX SUMMARY ===");
  log.info(`Batches fixed: ${fixed}`);
  log.info(`Batches failed: ${failed}`);

  const d = getDb(config);
  const statusCounts = d
    .prepare(
      `SELECT fix_status, COUNT(*) as count FROM issues GROUP BY fix_status`,
    )
    .all() as Array<{ fix_status: string; count: number }>;
  for (const row of statusCounts) {
    log.info(`  ${row.fix_status}: ${row.count}`);
  }

  return { fixed, failed };
}
