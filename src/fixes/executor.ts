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

/**
 * Fix a batch of issues by spawning Claude CLI in agentic mode.
 */
export async function fixBatch(
  batchLabel: string,
  prompt: string,
  systemPrompt: string,
  issueIds: number[],
  fileCount: number,
  issueCount: number,
  config: AuditConfig,
  opts: {
    interactive?: boolean;
    skipCommits?: boolean;
    batchNum?: number;
    totalBatches?: number;
  },
): Promise<boolean> {
  const batchNum = opts.batchNum ?? 0;
  const totalBatches = opts.totalBatches ?? 0;
  events.emit({
    type: "fix:batch:start",
    batchNum,
    totalBatches,
    fileCount,
    issueCount,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    events.emit({
      type: "fix:batch:attempt",
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

    if (!opts.interactive) {
      claudeArgs.push("--print", "--no-session-persistence");
    }

    const proc = Bun.spawn(claudeArgs, {
      stdin: new Response(prompt + "\n"),
      stdout: opts.interactive ? "inherit" : "pipe",
      stderr: opts.interactive ? "inherit" : "pipe",
      cwd: config.projectRoot,
    });

    let claudeOutput = "";
    if (!opts.interactive) {
      // Consume both streams to prevent buffer backpressure
      const [stdoutText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      claudeOutput = stdoutText;
    }
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.error(`Claude CLI failed for ${batchLabel}: exit code ${exitCode}`);
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
    const [checkOutput] = await Promise.all([
      new Response(checkProc.stdout).text(),
      new Response(checkProc.stderr).text(),
    ]);
    const checkExit = await checkProc.exited;

    if (checkExit === 0) {
      events.emit({ type: "fix:batch:check", batchNum, passed: true });
      log.info("  bun check passed");

      // Format
      const fmtProc = Bun.spawn(["bun", "format"], {
        cwd: config.projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([
        new Response(fmtProc.stdout).text(),
        new Response(fmtProc.stderr).text(),
      ]);
      await fmtProc.exited;

      // Commit
      if (!opts.skipCommits) {
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
            stdout: "pipe",
            stderr: "pipe",
            cwd: config.projectRoot,
          },
        );
        await Promise.all([
          new Response(commitProc.stdout).text(),
          new Response(commitProc.stderr).text(),
        ]);
        await commitProc.exited;
      }

      updateIssueFixStatus(config, issueIds, "fixed");
      updateFixAttempt(config, attemptId, "success");
      events.emit({ type: "fix:batch:complete", batchNum, success: true });
      return true;
    }

    // Check failed
    events.emit({ type: "fix:batch:check", batchNum, passed: false });
    log.warn(`bun check failed (attempt ${attempt}/${MAX_RETRIES})`);
    updateFixAttempt(config, attemptId, "check_failed", {
      checkOutput: checkOutput.slice(0, 4000),
    });

    if (attempt === MAX_RETRIES) {
      log.error(`All retries exhausted for ${batchLabel}`);
      if (!opts.skipCommits) {
        // Revert changes
        Bun.spawnSync(["git", "checkout", "--", "."], {
          cwd: config.projectRoot,
        });
      }
      updateIssueFixStatus(config, issueIds, "failed");
      events.emit({ type: "fix:batch:complete", batchNum, success: false });
      return false;
    }
  }

  return false;
}
