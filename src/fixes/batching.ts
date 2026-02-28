// ============================================================================
// LOC-based file batching for fix processing
// ============================================================================

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AuditConfig, FileWithLoc, FixBatch } from "../types";
import { getDb } from "../db";

/**
 * Get distinct file paths from all pending issues, with LOC counts.
 */
export function getFixFilesWithLoc(
  config: AuditConfig,
  policySqlFilter?: string,
): FileWithLoc[] {
  const d = getDb(config);
  const filter = policySqlFilter ?? "";

  const rows = d
    .prepare(
      `SELECT DISTINCT f.path
       FROM issues i
       JOIN issue_files jf ON jf.issue_id = i.id
       JOIN files f ON jf.file_id = f.id
       JOIN scans s ON i.scan_id = s.id
       WHERE i.fix_status = 'pending'
       ${filter}
       ORDER BY f.path`,
    )
    .all() as Array<{ path: string }>;

  return rows.map((row) => {
    const fullPath = resolve(config.projectRoot, row.path);
    let loc = 0;
    if (existsSync(fullPath)) {
      try {
        loc = readFileSync(fullPath, "utf-8").split("\n").length;
      } catch {
        // skip
      }
    }
    return { path: row.path, loc };
  });
}

/**
 * Greedily batch files by LOC. Files are already sorted by path
 * (keeps related directories together).
 */
export function batchFilesByLoc(
  files: FileWithLoc[],
  maxLoc: number,
): FixBatch[] {
  const batches: FixBatch[] = [];
  let currentBatch: FixBatch = { batchNum: 1, files: [], totalLoc: 0 };

  for (const file of files) {
    if (
      currentBatch.totalLoc + file.loc > maxLoc &&
      currentBatch.files.length > 0
    ) {
      batches.push(currentBatch);
      currentBatch = {
        batchNum: currentBatch.batchNum + 1,
        files: [],
        totalLoc: 0,
      };
    }
    currentBatch.files.push(file.path);
    currentBatch.totalLoc += file.loc;
  }

  if (currentBatch.files.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
