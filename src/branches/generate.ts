// ============================================================================
// Branch generation — recursive directory splitting
// ============================================================================

import { readdirSync, existsSync, writeFileSync } from "fs";
import { resolve, relative } from "path";
import type { AuditConfig, Branch } from "../types";
import { log } from "../logging";
import { findSourceFiles, countLoc, isExcludedPath } from "./scanner";

/**
 * Count flat LOC (files in directory only, not subdirectories).
 */
function countFlatLoc(dir: string, config: AuditConfig): number {
  const files = findSourceFiles(dir, true, config);
  return files.length > 0 ? countLoc(files) : 0;
}

/**
 * Check if a directory has subdirectories containing matching source files.
 */
function hasSourceSubdirs(dir: string, config: AuditConfig): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = resolve(dir, entry.name);
      const relPath = relative(config.projectRoot, subdir);
      if (isExcludedPath(relPath, config.excludeDirs)) continue;
      const files = findSourceFiles(subdir, false, config);
      if (files.length > 0) return true;
    }
  } catch (e) {
    log.debug(
      `Cannot read directory for subdirectory check: ${dir} — ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }
  return false;
}

/**
 * Get immediate subdirectories that contain matching source files.
 */
function getSourceSubdirs(dir: string, config: AuditConfig): string[] {
  const result: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = resolve(dir, entry.name);
      const relPath = relative(config.projectRoot, subdir);
      if (isExcludedPath(relPath, config.excludeDirs)) continue;
      const files = findSourceFiles(subdir, false, config);
      if (files.length > 0) result.push(subdir);
    }
  } catch (e) {
    log.debug(
      `Cannot read directory for subdirectory listing: ${dir} — ${e instanceof Error ? e.message : "unknown error"}`,
    );
  }
  return result.sort();
}

/**
 * Recursively process a directory, building the branches array.
 */
function processDir(
  dir: string,
  config: AuditConfig,
  branches: Branch[],
): void {
  const relPath = relative(config.projectRoot, dir);

  if (isExcludedPath(relPath, config.excludeDirs)) return;
  if (!existsSync(dir)) return;

  const flatLoc = countFlatLoc(dir, config);
  const hasSubs = hasSourceSubdirs(dir, config);

  if (hasSubs) {
    // Check total LOC (flat + all subdirs) before deciding to split
    const allFiles = findSourceFiles(dir, false, config);
    const totalLoc = allFiles.length > 0 ? countLoc(allFiles) : 0;

    if (totalLoc <= config.maxLoc) {
      // Total fits in one branch — keep as a single non-flat branch
      branches.push({ raw: relPath, path: relPath, isFlat: false });
      log.info(`  ${relPath} (${totalLoc} LOC) - combined (under MAX_LOC)`);
    } else {
      // Too large — split into flat + subdirectories
      if (flatLoc > 0) {
        branches.push({
          raw: `${relPath} (flat)`,
          path: relPath,
          isFlat: true,
        });
        log.info(`  ${relPath} (flat) (flat: ${flatLoc} LOC)`);
      }

      log.info(
        `  ${relPath} - recursing into subdirectories (${totalLoc} LOC > MAX_LOC ${config.maxLoc})`,
      );
      for (const subdir of getSourceSubdirs(dir, config)) {
        processDir(subdir, config, branches);
      }
    }
  } else {
    // Leaf directory
    if (flatLoc > 0) {
      branches.push({ raw: relPath, path: relPath, isFlat: false });
      if (flatLoc <= config.maxLoc) {
        log.info(`  ${relPath} (${flatLoc} LOC) - leaf directory`);
      } else {
        log.info(
          `  ${relPath} (${flatLoc} LOC) - leaf directory, will batch at runtime`,
        );
      }
    }
  }
}

/**
 * Generate branches by scanning configured start directories.
 * Writes branches.txt and returns the branch list.
 */
export function generateBranches(config: AuditConfig): Branch[] {
  const branches: Branch[] = [];

  log.info(`Generating optimal BRANCHES array (MAX_LOC=${config.maxLoc})`);
  log.info("==========================================");
  log.info("");

  for (const startDir of config.startDirs) {
    const fullPath = resolve(config.projectRoot, startDir);
    if (existsSync(fullPath)) {
      log.info(`Processing: ${startDir}`);
      processDir(fullPath, config, branches);
      log.info("");
    } else {
      log.info(`Skipping: ${startDir} (not found)`);
      log.info("");
    }
  }

  if (branches.length === 0) {
    log.error("No branches generated — no source files found.");
    log.error(`  PROJECT_ROOT: ${config.projectRoot}`);
    log.error(`  START_DIRS: ${config.startDirs.join(", ")}`);
    log.error(`  FILE_EXTENSIONS: ${config.fileExtensions.join(" ")}`);
    process.exit(1);
  }

  // Write branches.txt
  const content = branches.map((b) => b.raw).join("\n") + "\n";
  writeFileSync(config.branchesFile, content);

  log.info("==========================================");
  log.info(`Generated ${branches.length} branches -> branches.txt`);
  log.info("==========================================");
  for (const b of branches) {
    log.info(`  ${b.raw}`);
  }
  log.info(`Wrote to: ${config.branchesFile}`);

  return branches;
}
