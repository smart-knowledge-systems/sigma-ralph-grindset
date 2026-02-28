// ============================================================================
// Single branch processing — stores results in DB
// ============================================================================

import type { AuditConfig, AuditResult, AuditMode } from "../types";
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
import { auditViaApi } from "./api-backend";

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
    type: "audit:branch:start",
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

  try {
    let result: AuditResult;

    if (mode === "cli") {
      const cliResult = await auditViaCli(
        branchPath,
        files,
        policyNames,
        config,
      );
      result = cliResult.result;
    } else {
      const apiResult = await auditViaApi(
        branchPath,
        files,
        policyNames,
        config,
        useCaching,
      );
      result = apiResult.result;
      const cost = computeActualCost(config.auditModel, apiResult.usage, false);
      updateScanUsage(config, scanId, apiResult.usage, cost);
    }

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
      type: "audit:branch:complete",
      branch: branchLabel,
      issueCount,
      policy: policyLabel,
    });
    log.info(`  Completed: ${issueCount} issues found`);

    return { success: true, issueCount };
  } catch (e: unknown) {
    const err = e as Error & { errorType?: string; stderr?: string };
    const errorMsg = err.stderr
      ? `${err.message}: ${err.stderr.slice(0, 500)}`
      : err.message;
    updateScanStatus(config, scanId, "failed", {
      errorMessage: errorMsg.slice(0, 4000),
    });
    events.emit({
      type: "audit:branch:fail",
      branch: branchLabel,
      error: err.message,
      policy: policyLabel,
    });
    log.error(`Failed for ${branchLabel}: ${err.message}`);
    return { success: false, issueCount: 0, errorType: err.errorType };
  }
}
