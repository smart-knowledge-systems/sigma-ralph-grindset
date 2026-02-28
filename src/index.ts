// ============================================================================
// CLI entry point — parses argv and delegates to the appropriate module
// ============================================================================

import type { AuditMode, CliOptions } from "./types";
import { loadConfig } from "./config";
import { log, setLogLevel, initFileLogging, cleanupLogs } from "./logging";

function printUsage(): void {
  log.info(`Usage: sigma <command> [options]

Commands:
  audit [policies...]   Run code quality audit
  fix [policy]          Apply fixes from audit.db
  all                   Full pipeline: branches + audit + fix + checkpoint
  branches              Generate branches.txt
  config                Edit audit.conf interactively

Audit options:
  --cli                 Use Claude CLI (claude -p) instead of Batch API
  --diff [ref]          Audit only changed files
  --all                 Full audit (ignore checkpoints)
  --model <name>        Override audit model
  --dry-run             Show cost estimate, don't execute
  --max-loc <n>         Override MAX_LOC

Fix options:
  --interactive         Open Claude interactively
  --dangerously-skip-commits  Skip git commits

Config options:
  --ui                  Open config editor in browser

General options:
  --stdout              Terminal-only output (no browser UI)
`);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2); // skip bun and script path

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printUsage();
    process.exit(0);
  }

  const command = args[0] as CliOptions["command"];
  if (!["audit", "fix", "all", "branches", "config"].includes(command)) {
    log.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const opts: CliOptions = {
    command,
    policies: [],
    api: false,
    batch: false,
    cli: false,
    diff: false,
    forceAll: false,
    dryRun: false,
    interactive: false,
    skipCommits: false,
    stdout: false,
    ui: false,
  };

  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case "--api":
        // Back-compat alias — API is now the default
        opts.api = true;
        break;
      case "--batch":
        // Back-compat alias
        opts.batch = true;
        break;
      case "--cli":
        opts.cli = true;
        break;
      case "--diff":
        opts.diff = true;
        // Peek at next arg for optional ref
        if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
          opts.diffRef = args[++i];
        }
        break;
      case "--all":
        opts.forceAll = true;
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--max-loc": {
        const n = parseInt(args[++i]!, 10);
        if (isNaN(n)) {
          log.error("--max-loc requires a numeric value");
          process.exit(1);
        }
        opts.maxLoc = n;
        break;
      }
      case "--interactive":
        opts.interactive = true;
        break;
      case "--dangerously-skip-commits":
        opts.skipCommits = true;
        break;
      case "--stdout":
        opts.stdout = true;
        break;
      case "--ui":
        opts.ui = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          log.error(`Unknown flag: ${arg}`);
          process.exit(1);
        }
        // Positional arg = policy name
        opts.policies.push(arg);
        break;
    }
    i++;
  }

  return opts;
}

async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // ignore — browser open is best-effort
  }
}

async function main(): Promise<void> {
  setLogLevel();
  const opts = parseArgs(process.argv);
  const config = loadConfig();

  // Apply config defaults — CLI flags always win
  const has = (flag: string) => process.argv.some((a) => a === flag);

  if (!has("--diff") && config.defaultDiff) opts.diff = true;
  if (!opts.diffRef && config.defaultDiffRef)
    opts.diffRef = config.defaultDiffRef;
  if (!has("--all") && config.defaultForceAll) opts.forceAll = true;
  if (!has("--dry-run") && config.defaultDryRun) opts.dryRun = true;
  if (!has("--stdout") && config.defaultStdout) opts.stdout = true;
  if (!has("--interactive") && config.defaultInteractive)
    opts.interactive = true;
  if (!has("--dangerously-skip-commits") && config.defaultSkipCommits)
    opts.skipCommits = true;

  // Override model if specified
  if (opts.model) {
    (config as { auditModel: string }).auditModel = opts.model;
  }
  if (opts.maxLoc) {
    (config as { maxLoc: number }).maxLoc = opts.maxLoc;
  }

  // Determine mode: explicit --cli flag > config default > "batch"
  const mode: AuditMode = has("--cli")
    ? "cli"
    : config.defaultMode === "cli"
      ? "cli"
      : "batch";

  // Handle config command before initializing pipeline infrastructure
  if (opts.command === "config") {
    if (opts.ui) {
      const { startConfigServer } = await import("./config/server");
      const srv = startConfigServer(config.auditDir);
      log.info(`Config editor: http://localhost:${srv.port}`);
      await openBrowser(`http://localhost:${srv.port}`);
      await new Promise<void>((r) =>
        process.on("SIGINT", () => {
          srv.stop();
          r();
        }),
      );
    } else {
      const { runCliConfig } = await import("./config/cli-editor");
      await runCliConfig(config.auditDir);
    }
    return;
  }

  // Initialize file logging for non-branches commands
  if (opts.command !== "branches") {
    initFileLogging(config.auditDir);
  }

  // Start progress UI server unless --stdout
  let stopServer: (() => Promise<void>) | null = null;
  if (!opts.stdout && opts.command !== "branches") {
    try {
      const { startServer } = await import("./server");
      const server = startServer();
      stopServer = server.stop;
      const url = `http://localhost:${server.port}`;
      log.info(`Progress UI: ${url}`);
      await openBrowser(url);
    } catch {
      // Fall back to stdout-only if server fails
    }
  }

  let success = false;
  try {
    switch (opts.command) {
      case "branches": {
        const { generateBranches } = await import("./branches/generate");
        generateBranches(config);
        break;
      }

      case "audit": {
        const {
          runAudit,
          discoverPolicies,
          computePerBranchCostEstimate,
          waitForConfirmation,
        } = await import("./audit/run-audit");
        const { formatPerBranchEstimate } = await import("./pricing");
        const { events } = await import("./events");
        const { randomUUID } = await import("crypto");
        const policies =
          opts.policies.length > 0 ? opts.policies : discoverPolicies(config);

        if (mode === "cli") {
          // CLI mode: sequential per-policy
          for (const policy of policies) {
            await runAudit(config, {
              policies: [policy],
              forceAll: opts.forceAll,
              diffMode: opts.diff,
              diffRef: opts.diffRef,
              mode,
              dryRun: opts.dryRun,
            });
          }
        } else if (policies.length > 1) {
          // Multi-policy batch: compute upfront cost, single confirmation
          const estimate = computePerBranchCostEstimate(
            config,
            policies,
          );

          log.info(formatPerBranchEstimate(estimate));
          events.emit({
            type: "cost:estimate:aggregated",
            estimate,
          });

          if (opts.dryRun) {
            log.info("\n--dry-run: exiting without executing.");
            break;
          }

          // Single confirmation for all policies
          const requestId = randomUUID();
          events.emit({
            type: "cost:confirm-request",
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
            break;
          }

          // Run with pre-approved cost
          await runAudit(config, {
            policies,
            forceAll: opts.forceAll,
            diffMode: opts.diff,
            diffRef: opts.diffRef,
            mode,
            dryRun: false,
            costApproved: true,
          });
        } else {
          // Single policy batch: standard flow
          await runAudit(config, {
            policies,
            forceAll: opts.forceAll,
            diffMode: opts.diff,
            diffRef: opts.diffRef,
            mode,
            dryRun: opts.dryRun,
          });
        }
        break;
      }

      case "fix": {
        const { runFixes } = await import("./fixes/run-fixes");
        await runFixes(config, {
          interactive: opts.interactive,
          skipCommits: opts.skipCommits,
          policyFilter: opts.policies[0],
        });
        break;
      }

      case "all": {
        const { runPipeline } = await import("./pipeline/run-all");
        await runPipeline(config, {
          forceAll: opts.forceAll,
          diffMode: opts.diff,
          diffRef: opts.diffRef,
          mode,
        });
        break;
      }
    }
    success = true;
  } finally {
    // Clean up file logs
    if (opts.command !== "branches") {
      const failedDir = cleanupLogs(success, config.auditDir);
      if (failedDir) log.error(`Debug logs saved to: ${failedDir}`);
    }

    // Keep server alive briefly for UI to catch final state
    if (stopServer) {
      await Bun.sleep(5000);
      await stopServer();
    }
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
