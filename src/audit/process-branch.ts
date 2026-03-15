// ============================================================================
// Single branch processing — stores results in DB
// ============================================================================

import type { AuditConfig, AuditResult, AuditMode } from "../types";
import { buildAddendumContext } from "./addendum";
import { log } from "../logging";
import { events } from "../events";
import {
  insertScan,
  updateScanStatus,
  updateScanUsage,
  insertIssue,
  ensureFile,
  linkIssueFile,
  supersedePendingIssues,
} from "../db";
import { computeActualCost } from "../pricing";
import { countLoc } from "../branches/scanner";
import { parseFileRef } from "../branches/scanner";
import { auditViaCli } from "./cli-backend";

export interface ProcessBranchResult {
  success: boolean;
  issueCount: number;
  errorType?: string;
}

/**
 * Process a single branch: run audit and store results in DB.
 */
export async function processBranch(
  branchPath: string,
  batchSuffix: string,
  files: string[],
  policyNames: string[],
  policyLabel: string,
  config: AuditConfig,
  mode: AuditMode,
  useCaching: boolean,
): Promise<ProcessBranchResult> {
  const branchLabel = `${branchPath}${batchSuffix}`;

  // Supersede pending issues
  const allPolicies = [...policyNames, policyLabel];
  const superseded = supersedePendingIssues(config, branchPath, allPolicies);
  if (superseded > 0) {
    log.info(
      `  Superseded ${superseded} stale issues for ${branchPath} [${policyLabel}]`,
    );
  }

  events.emit({
    type: "audit.branch.start",
    branch: branchLabel,
    fileCount: files.length,
    policy: policyLabel,
  });
  log.info(`Processing: ${branchLabel} (${files.length} files)`);

  const totalLoc = countLoc(files);
  const scanId = insertScan(
    config,
    branchLabel,
    policyLabel,
    files.length,
    totalLoc,
  );

  const startTime = performance.now();

  const addendumCtx = buildAddendumContext(config, files);

  try {
    let result: AuditResult;

    if (mode === "cli") {
      const cliResult = await auditViaCli(
        branchPath,
        files,
        policyNames,
        config,
        addendumCtx,
      );
      result = cliResult.result;
    } else {
      const { auditViaApi } = await import("./api-backend");
      const apiResult = await auditViaApi(
        branchPath,
        files,
        policyNames,
        config,
        useCaching,
        addendumCtx,
      );
      result = apiResult.result;
      const cost = computeActualCost(config.auditModel, apiResult.usage, false);
      updateScanUsage(config, scanId, apiResult.usage, cost);
    }

    const durationMs = Math.round(performance.now() - startTime);

    // Store issues
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

      for (const rawFilePath of issue.files) {
        const { path: cleanPath, lines } = parseFileRef(rawFilePath);
        const fileId = ensureFile(config, cleanPath);
        linkIssueFile(config, issueId, fileId, lines);
      }

      issueCount++;
    }

    updateScanStatus(config, scanId, "completed", { issueCount });
    events.emit({
      type: "audit.branch.complete",
      branch: branchLabel,
      issueCount,
      policy: policyLabel,
    });
    log.info(`  Completed: ${issueCount} issues found (${durationMs}ms)`);

    return { success: true, issueCount };
  } catch (e: unknown) {
    const durationMs = Math.round(performance.now() - startTime);
    const err = e instanceof Error ? e : new Error(String(e));

    // Extract custom properties with type guards instead of `as` casts
    const errorType =
      e !== null && typeof e === "object" && "errorType" in e
        ? String((e as { errorType: unknown }).errorType)
        : undefined;
    const stderr =
      e !== null && typeof e === "object" && "stderr" in e
        ? String((e as { stderr: unknown }).stderr)
        : undefined;

    const errorMsg = stderr
      ? `${err.message}: ${stderr.slice(0, 500)}`
      : err.message;
    updateScanStatus(config, scanId, "failed", {
      errorMessage: errorMsg.slice(0, 4000),
    });
    events.emit({
      type: "audit.branch.fail",
      branch: branchLabel,
      error: err.message,
      policy: policyLabel,
    });
    log.error(`Failed for ${branchLabel} (${durationMs}ms): ${err.message}`);
    return { success: false, issueCount: 0, errorType };
  }
}
