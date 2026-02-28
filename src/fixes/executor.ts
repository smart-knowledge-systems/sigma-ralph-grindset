// ============================================================================
// Fix executor — spawns Claude CLI for agentic fixing
// ============================================================================

import type { AuditConfig } from "../types";
import { log } from "../logging";
import { events } from "../events";
import {
  insertFixAttempt,
  updateFixAttempt,
  updateIssueFixStatus,
} from "../db";

const MAX_RETRIES = 3;

/** Options for a single fix batch run. */
export interface FixBatchOptions {
  batchLabel: string;
  prompt: string;
  systemPrompt: string;
  issueIds: number[];
  fileCount: number;
  issueCount: number;
  config: AuditConfig;
  interactive?: boolean;
  skipCommits?: boolean;
  batchNum?: number;
  totalBatches?: number;
}

/**
 * Fix a batch of issues by spawning Claude CLI in agentic mode.
 */
export async function fixBatch(opts: FixBatchOptions): Promise<boolean> {
  const {
    batchLabel,
    prompt,
    systemPrompt,
    issueIds,
    fileCount,
    issueCount,
    config,
    interactive = false,
    skipCommits = false,
    batchNum = 0,
    totalBatches = 0,
  } = opts;

  events.emit({
    type: "fix.batch.start",
    batchNum,
    totalBatches,
    fileCount,
    issueCount,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    events.emit({
      type: "fix.batch.attempt",
      batchNum,
      attempt,
      maxAttempts: MAX_RETRIES,
    });
    log.info(`  Attempt ${attempt}/${MAX_RETRIES}...`);

    const attemptId = insertFixAttempt(config, batchLabel, attempt);
    updateIssueFixStatus(config, issueIds, "in_progress");

    // Run Claude fix agent
    const claudeArgs = [
      "claude",
      "--model",
      config.fixModel,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      systemPrompt,
    ];

    if (!interactive) {
      claudeArgs.push("--print", "--no-session-persistence");
    }

    const proc = Bun.spawn(claudeArgs, {
      stdin: new Response(prompt + "\n"),
      stdout: interactive ? "inherit" : "pipe",
      stderr: interactive ? "inherit" : "pipe",
      cwd: config.projectRoot,
    });

    let claudeOutput = "";
    let stderrText = "";
    if (!interactive) {
      // Consume both streams to prevent buffer backpressure
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      claudeOutput = stdout;
      stderrText = stderr;
    }
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.error(`Claude CLI failed for ${batchLabel}: exit code ${exitCode}`, {
        event: "fix.cli.failed",
        error: {
          type: "ProcessError",
          message: "Claude CLI exited non-zero",
          code: exitCode,
        },
        batchLabel,
        attempt,
      });
      if (stderrText.trim()) {
        log.debug(`  stderr: ${stderrText.trim().slice(0, 500)}`);
      }
      updateFixAttempt(config, attemptId, "failed", {
        claudeOutput: claudeOutput.slice(0, 4000),
        errorMessage: stderrText.slice(0, 4000),
      });
      updateIssueFixStatus(config, issueIds, "pending");

      // Don't proceed to bun check — the fix attempt failed
      if (attempt === MAX_RETRIES) {
        events.emit({ type: "fix.batch.complete", batchNum, success: false });
        return false;
      }
      continue;
    }

    // Store truncated output
    updateFixAttempt(config, attemptId, "running", {
      claudeOutput: claudeOutput.slice(0, 4000),
    });

    // Run bun check
    const checkProc = Bun.spawn(["bun", "check"], {
      cwd: config.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [checkOutput, checkStderr] = await Promise.all([
      new Response(checkProc.stdout).text(),
      new Response(checkProc.stderr).text(),
    ]);
    const checkExit = await checkProc.exited;

    if (checkExit === 0) {
      events.emit({ type: "fix.batch.check", batchNum, passed: true });
      log.info("  bun check passed");

      // Format
      const fmtProc = Bun.spawn(["bun", "format"], {
        cwd: config.projectRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      await fmtProc.exited;

      // Commit
      if (!skipCommits) {
        const commitPrompt = `Commit the staged and unstaged changes. These are fixes for audit issues: ${batchLabel} (${fileCount} files, ${issueCount} issues) based on project coding guidelines. Use /git-commit-manager`;
        const commitProc = Bun.spawn(
          [
            "claude",
            "--print",
            "--no-session-persistence",
            "--model",
            config.commitModel,
            "--permission-mode",
            "bypassPermissions",
          ],
          {
            stdin: new Response(commitPrompt),
            stdout: "ignore",
            stderr: "ignore",
            cwd: config.projectRoot,
          },
        );
        await commitProc.exited;
      }

      updateIssueFixStatus(config, issueIds, "fixed");
      updateFixAttempt(config, attemptId, "success");
      events.emit({ type: "fix.batch.complete", batchNum, success: true });
      return true;
    }

    // Check failed
    events.emit({ type: "fix.batch.check", batchNum, passed: false });
    log.warn(`bun check failed (attempt ${attempt}/${MAX_RETRIES})`, {
      event: "fix.check.failed",
      attempt,
      maxAttempts: MAX_RETRIES,
      batchLabel,
    });
    if (checkStderr.trim()) {
      log.debug(`  check stderr: ${checkStderr.trim().slice(0, 500)}`);
    }
    updateFixAttempt(config, attemptId, "check_failed", {
      checkOutput: checkOutput.slice(0, 4000),
    });

    if (attempt === MAX_RETRIES) {
      log.error(`All retries exhausted for ${batchLabel}`, {
        event: "fix.retries.exhausted",
        batchLabel,
        maxAttempts: MAX_RETRIES,
      });
      if (!skipCommits) {
        // Revert changes
        Bun.spawnSync(["git", "checkout", "--", "."], {
          cwd: config.projectRoot,
        });
      }
      updateIssueFixStatus(config, issueIds, "failed");
      events.emit({ type: "fix.batch.complete", batchNum, success: false });
      return false;
    }
  }

  return false;
}
