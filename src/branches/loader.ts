// ============================================================================
// Branch loading and file-to-branch mapping
// ============================================================================

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AuditConfig, Branch } from "../types";
import { log } from "../logging";
import { matchesExtensions, isExcludedPath } from "./scanner";

/** Parse a branch entry from branches.txt. */
function parseBranchEntry(line: string): Branch {
  const flatMatch = line.match(/^(.*)\s+\(flat\)$/);
  if (flatMatch) {
    return { raw: line, path: flatMatch[1]!, isFlat: true };
  }
  return { raw: line, path: line, isFlat: false };
}

/** Load branches from branches.txt. */
export function loadBranches(config: AuditConfig): Branch[] {
  if (!existsSync(config.branchesFile)) {
    log.error(
      `${config.branchesFile} not found. Run 'branches' command first.`,
    );
    process.exit(1);
  }

  const content = readFileSync(config.branchesFile, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseBranchEntry);
}

/**
 * Map a file path (relative to PROJECT_ROOT) to its home branch.
 * Uses longest-prefix match. Respects flat vs recursive semantics.
 */
export function fileToBranch(filePath: string, branches: Branch[]): string {
  let bestMatch = "";
  let bestLen = 0;

  for (const branch of branches) {
    const bp = branch.path;

    if (bp === ".") {
      // Root branch
      if (branch.isFlat && filePath.includes("/")) continue;
      if (1 > bestLen) {
        bestMatch = ".";
        bestLen = 1;
      }
      continue;
    }

    // File must start with branch path + /
    if (!filePath.startsWith(bp + "/")) continue;

    // Flat branches: file must be directly in the directory
    if (branch.isFlat) {
      const remainder = filePath.slice(bp.length + 1);
      if (remainder.includes("/")) continue;
    }

    // Longest prefix match wins
    if (bp.length > bestLen) {
      bestMatch = bp;
      bestLen = bp.length;
    }
  }

  return bestMatch;
}

/**
 * Get changed files since a git ref that match configured extensions.
 * Returns absolute paths.
 */
export function getDiffFiles(config: AuditConfig, diffRef?: string): string[] {
  const opts = { cwd: config.projectRoot, encoding: "utf-8" as const };

  let rawFiles = "";

  if (diffRef) {
    try {
      rawFiles = execSync(
        `git diff --name-only --diff-filter=d ${diffRef}`,
        opts,
      );
    } catch (e) {
      log.debug(
        `git diff failed for ref ${diffRef}: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }
  } else {
    // Staged + unstaged
    try {
      rawFiles = execSync(
        "git diff --cached --name-only --diff-filter=d",
        opts,
      );
    } catch (e) {
      log.debug(
        `git diff --cached failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }
    try {
      rawFiles += "\n" + execSync("git diff --name-only --diff-filter=d", opts);
    } catch (e) {
      log.debug(
        `git diff failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }
  }

  // Untracked
  try {
    rawFiles +=
      "\n" + execSync("git ls-files --others --exclude-standard", opts);
  } catch (e) {
    log.debug(
      `git ls-files failed: ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }

  const seen = new Set<string>();
  const results: string[] = [];

  for (const file of rawFiles.split("\n")) {
    const trimmed = file.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    if (!matchesExtensions(trimmed, config.fileExtensions)) continue;
    if (isExcludedPath(trimmed, config.excludeDirs)) continue;

    const absPath = resolve(config.projectRoot, trimmed);
    if (existsSync(absPath)) {
      results.push(absPath);
    }
  }

  return results;
}
