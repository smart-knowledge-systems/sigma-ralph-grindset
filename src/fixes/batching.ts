// ============================================================================
// LOC-based file batching for fix processing
// ============================================================================

import { existsSync } from "fs";
import { resolve } from "path";
import type { AuditConfig, FileWithLoc, FixBatch } from "../types";
import { getDb } from "../db";
import { log } from "../logging";

/**
 * Count lines in a file using async I/O (avoids blocking the event loop).
 * Returns 0 if the file cannot be read.
 */
async function countFileLines(
  fullPath: string,
  relPath: string,
): Promise<number> {
  try {
    const content = await Bun.file(fullPath).text();
    return content.split("\n").length;
  } catch (e) {
    log.warn(
      `Failed to read file for LOC count: ${relPath} — ${e instanceof Error ? e.message : "unknown error"}`,
    );
    return 0;
  }
}

/**
 * Get distinct file paths from all pending issues, with LOC counts.
 * Uses async file reading to avoid blocking the event loop on large codebases.
 */
export async function getFixFilesWithLoc(
  config: AuditConfig,
  policyFilter?: string,
): Promise<FileWithLoc[]> {
  const d = getDb(config);

  const sql = policyFilter
    ? `SELECT DISTINCT f.path
       FROM issues i
       JOIN issue_files jf ON jf.issue_id = i.id
       JOIN files f ON jf.file_id = f.id
       JOIN scans s ON i.scan_id = s.id
       WHERE i.fix_status = 'pending'
       AND s.policy = ?
       ORDER BY f.path`
    : `SELECT DISTINCT f.path
       FROM issues i
       JOIN issue_files jf ON jf.issue_id = i.id
       JOIN files f ON jf.file_id = f.id
       JOIN scans s ON i.scan_id = s.id
       WHERE i.fix_status = 'pending'
       ORDER BY f.path`;

  // Parameterized query — policy filter uses ? binding, never string interpolation
  const rows = (
    policyFilter ? d.prepare(sql).all(policyFilter) : d.prepare(sql).all()
  ) as Array<{ path: string }>;

  // Read all files concurrently for LOC counting
  const results = await Promise.all(
    rows.map(async (row) => {
      const fullPath = resolve(config.projectRoot, row.path);
      const loc = existsSync(fullPath)
        ? await countFileLines(fullPath, row.path)
        : 0;
      return { path: row.path, loc };
    }),
  );

  return results;
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
