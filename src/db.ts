// ============================================================================
// SQLite database wrapper using bun:sqlite
// ============================================================================

import { Database } from "bun:sqlite";
import { log } from "./logging";
import type { AuditConfig, ScanStatus, FixStatus } from "./types";

let db: Database | null = null;

/** Get or create the database connection. */
export function getDb(config: AuditConfig): Database {
  if (db) return db;
  db = new Database(config.dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

/** Close the database connection. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Initialize the database schema (idempotent). */
export function initDatabase(config: AuditConfig): Database {
  const d = getDb(config);

  d.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_path TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
      file_count INTEGER,
      total_loc INTEGER,
      error_message TEXT,
      issue_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL REFERENCES scans(id),
      description TEXT NOT NULL,
      rule TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
      suggestion TEXT,
      policy TEXT DEFAULT '',
      fix_status TEXT DEFAULT 'pending',
      fixed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS issue_files (
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      file_id INTEGER NOT NULL REFERENCES files(id),
      lines TEXT DEFAULT '',
      PRIMARY KEY (issue_id, file_id)
    );

    CREATE INDEX IF NOT EXISTS idx_issues_scan_id ON issues(scan_id);
    CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
    CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(rule);
    CREATE INDEX IF NOT EXISTS idx_scans_policy ON scans(policy);
    CREATE INDEX IF NOT EXISTS idx_issue_files_file_id ON issue_files(file_id);

    CREATE TABLE IF NOT EXISTS audit_checkpoints (
      policy TEXT PRIMARY KEY,
      git_commit TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS fix_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_path TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'success', 'check_failed', 'failed')),
      check_output TEXT,
      error_message TEXT,
      claude_output TEXT
    );
  `);

  // Migrations: add columns if missing
  const scanCols = d.prepare("PRAGMA table_info(scans)").all() as Array<{
    name: string;
  }>;
  const colNames = new Set(scanCols.map((c) => c.name));
  if (!colNames.has("input_tokens")) {
    d.exec(`
      ALTER TABLE scans ADD COLUMN input_tokens INTEGER;
      ALTER TABLE scans ADD COLUMN output_tokens INTEGER;
      ALTER TABLE scans ADD COLUMN cache_write_tokens INTEGER;
      ALTER TABLE scans ADD COLUMN cache_read_tokens INTEGER;
      ALTER TABLE scans ADD COLUMN actual_cost REAL;
      ALTER TABLE scans ADD COLUMN request_id TEXT;
    `);
  }

  log.debug(`Database initialized at ${config.dbPath}`);
  return d;
}

// ── Prepared statement helpers ────────────────────────────────────────────

/** Insert a scan record, returns the new scan ID. */
export function insertScan(
  config: AuditConfig,
  branchPath: string,
  policy: string,
  fileCount: number,
  totalLoc: number,
): number {
  const d = getDb(config);
  const stmt = d.prepare(
    `INSERT INTO scans (branch_path, policy, file_count, total_loc) VALUES (?, ?, ?, ?)`,
  );
  const result = stmt.run(branchPath, policy, fileCount, totalLoc);
  return Number(result.lastInsertRowid);
}

/** Update a scan's status. */
export function updateScanStatus(
  config: AuditConfig,
  scanId: number,
  status: ScanStatus,
  opts?: { errorMessage?: string; issueCount?: number },
): void {
  const d = getDb(config);
  if (opts?.errorMessage !== undefined) {
    d.prepare(
      `UPDATE scans SET status=?, error_message=?, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id=?`,
    ).run(status, opts.errorMessage, scanId);
  } else if (opts?.issueCount !== undefined) {
    d.prepare(
      `UPDATE scans SET status=?, issue_count=?, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id=?`,
    ).run(status, opts.issueCount, scanId);
  } else {
    d.prepare(
      `UPDATE scans SET status=?, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id=?`,
    ).run(status, scanId);
  }
}

/** Update a scan's token usage and cost. */
export function updateScanUsage(
  config: AuditConfig,
  scanId: number,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
  actualCost: number,
  requestId?: string,
): void {
  const d = getDb(config);
  d.prepare(
    `UPDATE scans SET input_tokens=?, output_tokens=?, cache_write_tokens=?, cache_read_tokens=?, actual_cost=?, request_id=? WHERE id=?`,
  ).run(
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
    actualCost,
    requestId ?? null,
    scanId,
  );
}

/** Insert an issue and return its ID. */
export function insertIssue(
  config: AuditConfig,
  scanId: number,
  description: string,
  rule: string,
  severity: string,
  suggestion: string,
  policy: string,
): number {
  const d = getDb(config);
  const result = d
    .prepare(
      `INSERT INTO issues (scan_id, description, rule, severity, suggestion, policy) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(scanId, description, rule, severity, suggestion, policy);
  return Number(result.lastInsertRowid);
}

/** Ensure a file exists in the files table, return its ID. */
export function ensureFile(config: AuditConfig, path: string): number {
  const d = getDb(config);
  d.prepare(`INSERT OR IGNORE INTO files (path) VALUES (?)`).run(path);
  const row = d.prepare(`SELECT id FROM files WHERE path=?`).get(path) as {
    id: number;
  } | null;
  if (!row) {
    throw new Error(`Failed to insert or find file record for: ${path}`);
  }
  return row.id;
}

/** Link an issue to a file. */
export function linkIssueFile(
  config: AuditConfig,
  issueId: number,
  fileId: number,
  lines: string,
): void {
  const d = getDb(config);
  d.prepare(
    `INSERT OR IGNORE INTO issue_files (issue_id, file_id, lines) VALUES (?, ?, ?)`,
  ).run(issueId, fileId, lines);
}

/** Supersede pending issues for a branch+policy combination. Returns count. */
export function supersedePendingIssues(
  config: AuditConfig,
  branchPath: string,
  policies: string[],
): number {
  const d = getDb(config);
  const placeholders = policies.map(() => "?").join(",");
  const result = d
    .prepare(
      `UPDATE issues SET fix_status = 'superseded'
       WHERE fix_status = 'pending'
         AND scan_id IN (
           SELECT id FROM scans
           WHERE (branch_path = ? OR branch_path LIKE ? || ' [batch %]')
             AND policy IN (${placeholders})
         )`,
    )
    .run(branchPath, branchPath, ...policies);
  return result.changes;
}

/** Update fix_status for a set of issue IDs. */
export function updateIssueFixStatus(
  config: AuditConfig,
  issueIds: number[],
  status: FixStatus,
): void {
  const d = getDb(config);
  const placeholders = issueIds.map(() => "?").join(",");
  d.prepare(
    `UPDATE issues SET fix_status = ?${status === "fixed" ? ", fixed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')" : ""} WHERE id IN (${placeholders})`,
  ).run(status, ...issueIds);
}

/** Get the checkpoint commit for policies. Returns the oldest checkpoint or null. */
export function getCheckpointCommit(
  config: AuditConfig,
  policies: string[],
): string | null {
  const d = getDb(config);
  const placeholders = policies.map(() => "?").join(",");
  const row = d
    .prepare(
      `SELECT git_commit FROM audit_checkpoints WHERE policy IN (${placeholders}) ORDER BY completed_at ASC LIMIT 1`,
    )
    .get(...policies) as { git_commit: string } | null;
  return row?.git_commit ?? null;
}

/** Record a checkpoint for a policy. */
export function recordCheckpoint(
  config: AuditConfig,
  policy: string,
  gitCommit: string,
): void {
  const d = getDb(config);
  d.prepare(
    `INSERT OR REPLACE INTO audit_checkpoints (policy, git_commit, completed_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
  ).run(policy, gitCommit);
}

/** Get pending issues for a set of files. Returns issue rows with file paths. */
export function getPendingIssuesForFiles(
  config: AuditConfig,
  filePaths: string[],
): Array<{
  id: number;
  description: string;
  rule: string;
  severity: string;
  suggestion: string;
  file_paths: string;
  line_ranges: string;
}> {
  const d = getDb(config);
  const placeholders = filePaths.map(() => "?").join(",");

  // First get issue IDs
  const idRows = d
    .prepare(
      `SELECT DISTINCT i.id
       FROM issues i
       JOIN issue_files jf ON jf.issue_id = i.id
       JOIN files f ON jf.file_id = f.id
       WHERE i.fix_status = 'pending' AND f.path IN (${placeholders})
       ORDER BY i.id`,
    )
    .all(...filePaths) as Array<{ id: number }>;

  if (idRows.length === 0) return [];

  const issueIds = idRows.map((r) => r.id);
  const idPlaceholders = issueIds.map(() => "?").join(",");

  return d
    .prepare(
      `SELECT
         i.id, i.description, i.rule, i.severity, i.suggestion,
         GROUP_CONCAT(f.path, '|') as file_paths,
         GROUP_CONCAT(jf.lines, '|') as line_ranges
       FROM issues i
       JOIN issue_files jf ON jf.issue_id = i.id
       JOIN files f ON jf.file_id = f.id
       WHERE i.id IN (${idPlaceholders}) AND i.fix_status = 'pending'
       GROUP BY i.id
       ORDER BY CASE i.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, i.id`,
    )
    .all(...issueIds) as Array<{
    id: number;
    description: string;
    rule: string;
    severity: string;
    suggestion: string;
    file_paths: string;
    line_ranges: string;
  }>;
}

/** Insert a fix attempt record. Returns the new ID. */
export function insertFixAttempt(
  config: AuditConfig,
  branchPath: string,
  attemptNumber: number,
): number {
  const d = getDb(config);
  const result = d
    .prepare(
      `INSERT INTO fix_attempts (branch_path, attempt_number) VALUES (?, ?)`,
    )
    .run(branchPath, attemptNumber);
  return Number(result.lastInsertRowid);
}

/** Update a fix attempt record. */
export function updateFixAttempt(
  config: AuditConfig,
  attemptId: number,
  status: string,
  opts?: { checkOutput?: string; claudeOutput?: string },
): void {
  const d = getDb(config);
  d.prepare(
    `UPDATE fix_attempts SET status=?, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
     check_output=COALESCE(?, check_output), claude_output=COALESCE(?, claude_output)
     WHERE id=?`,
  ).run(
    status,
    opts?.checkOutput ?? null,
    opts?.claudeOutput ?? null,
    attemptId,
  );
}
