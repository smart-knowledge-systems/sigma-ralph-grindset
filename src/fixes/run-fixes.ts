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

export interface RunFixesOptions {
  interactive?: boolean;
  skipCommits?: boolean;
  policyFilter?: string;
}

/** Set up the fix branch in git. Throws on failure instead of process.exit. */
function setupGit(config: AuditConfig): void {
  // Run independent git queries in parallel (all are sync, but we batch them)
  const shortHash = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: config.projectRoot,
  })
    .stdout.toString()
    .trim();

  const fixBranch = `fix/audit-improvements-${shortHash}`;

  // These three git checks are independent — run them together
  const [currentBranchResult, diffResult, cachedResult] = [
    Bun.spawnSync(["git", "branch", "--show-current"], {
      cwd: config.projectRoot,
    }),
    Bun.spawnSync(["git", "diff", "--quiet"], { cwd: config.projectRoot }),
    Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
      cwd: config.projectRoot,
    }),
  ];

  const currentBranch = currentBranchResult.stdout.toString().trim();

  if (currentBranch === fixBranch) {
    log.info(`Already on ${fixBranch}`);
    return;
  }

  if (diffResult.exitCode !== 0 || cachedResult.exitCode !== 0) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes first.",
    );
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
  if (issueIds.length === 0) return [];

  // Validate all IDs are numbers to prevent SQL issues
  if (!issueIds.every((id) => typeof id === "number" && Number.isFinite(id))) {
    log.warn("getPoliciesForIssues received non-numeric issue IDs — skipping");
    return [];
  }

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
  policyFilter?: string,
): number {
  const d = getDb(config);
  if (policyFilter) {
    const row = d
      .prepare(
        `SELECT COUNT(*) as cnt FROM issues i JOIN scans s ON i.scan_id = s.id WHERE i.fix_status = 'pending' AND s.policy = ?`,
      )
      .get(policyFilter) as { cnt: number };
    return row.cnt;
  }
  const row = d
    .prepare(
      `SELECT COUNT(*) as cnt FROM issues i JOIN scans s ON i.scan_id = s.id WHERE i.fix_status = 'pending'`,
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
 * Throws on fatal errors instead of calling process.exit.
 */
export async function runFixes(
  config: AuditConfig,
  opts: RunFixesOptions = {},
): Promise<{ fixed: number; failed: number }> {
  log.info("=== Fix Audit Issues ===");
  log.info("");

  // Preflight checks
  if (!existsSync(config.dbPath)) {
    throw new Error("audit.db not found. Run audit first.");
  }

  // Ensure schema is initialized
  initDatabase(config);

  // Validate policy filter
  if (opts.policyFilter) {
    const policyPath = `${config.policiesDir}/${opts.policyFilter}/POLICY.md`;
    if (!existsSync(policyPath)) {
      throw new Error(`Policy not found: ${opts.policyFilter}`);
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

  // Build LOC-based batches
  const filesWithLoc = await getFixFilesWithLoc(config, opts.policyFilter);
  if (filesWithLoc.length === 0) {
    log.info("No pending issues to fix.");
    return { fixed: 0, failed: 0 };
  }

  const batches = batchFilesByLoc(filesWithLoc, config.maxFixLoc);
  const totalBatches = batches.length;
  const totalPending = countPendingIssues(config, opts.policyFilter);

  events.emit({
    type: "fix.start",
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
    const systemPrompt = await buildFixSystemPrompt(
      config,
      policies.length > 0 ? policies : ["default"],
    );
    const prompt = buildFixPrompt(batch.files, issues);

    const success = await fixBatch({
      batchLabel,
      prompt,
      systemPrompt,
      issueIds,
      fileCount: batch.files.length,
      issueCount: issues.length,
      config,
      interactive: opts.interactive,
      skipCommits: opts.skipCommits,
      batchNum: batch.batchNum,
      totalBatches,
    });

    if (success) {
      fixed++;
    } else {
      failed++;
    }

    log.info("");
  }

  events.emit({ type: "fix.complete", fixed, failed });

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
