// ============================================================================
// Shared type definitions for the SIGMA audit pipeline
// ============================================================================

/** Configuration loaded from audit.conf */
export interface AuditConfig {
  projectRoot: string;
  auditDir: string;
  dbPath: string;
  branchesFile: string;
  policiesDir: string;
  startDirs: string[];
  fileExtensions: string[];
  excludeDirs: string[];
  maxLoc: number;
  maxFixLoc: number;
  auditModel: string;
  fixModel: string;
  commitModel: string;
  defaultMode: AuditMode;
  defaultDiff: boolean;
  defaultDiffRef: string;
  defaultForceAll: boolean;
  defaultDryRun: boolean;
  defaultPerPolicy: boolean;
  defaultStdout: boolean;
  defaultInteractive: boolean;
  defaultSkipCommits: boolean;
}

/** A branch entry from branches.txt */
export interface Branch {
  /** Raw entry (e.g., "src/components (flat)") */
  raw: string;
  /** Cleaned path (e.g., "src/components") */
  path: string;
  /** Whether this is a flat (non-recursive) branch */
  isFlat: boolean;
}

/** A single audit issue as returned by Claude */
export interface AuditIssue {
  description: string;
  rule: string;
  severity: "high" | "medium" | "low";
  suggestion: string;
  policy: string;
  files: string[];
}

/** The structured output from an audit call */
export interface AuditResult {
  issues: AuditIssue[];
}

/** Token usage from an API call */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Cost estimate for an audit run */
export interface CostEstimate {
  model: string;
  branchCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  noCacheCost: number;
  cachingEnabled: boolean;
  cachingSavings: number;
  standardApiCost: number;
  batchApiCost: number;
  batchNoCacheCost: number;
  batchWithCacheCost: number;
  batchCachingEnabled: boolean;
}

/** Per-model pricing ($ per million tokens) */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  batchInput: number;
  batchOutput: number;
}

/** Audit backend mode */
export type AuditMode = "cli" | "api" | "batch";

/** CLI options parsed from argv */
export interface CliOptions {
  command: "audit" | "fix" | "all" | "branches" | "config";
  policies: string[];
  api: boolean;
  batch: boolean;
  cli: boolean;
  diff: boolean;
  diffRef?: string;
  forceAll: boolean;
  model?: string;
  dryRun: boolean;
  interactive: boolean;
  skipCommits: boolean;
  maxLoc?: number;
  stdout: boolean;
  perPolicy: boolean;
  ui: boolean;
}

/** A file with its LOC count for batching */
export interface FileWithLoc {
  path: string;
  loc: number;
}

/** A batch of files for fix processing */
export interface FixBatch {
  batchNum: number;
  files: string[];
  totalLoc: number;
}

/** Issue record from the database */
export interface DbIssue {
  id: number;
  description: string;
  rule: string;
  severity: string;
  suggestion: string;
  filePaths: string;
  lineRanges: string;
}

/** Scan status in the database */
export type ScanStatus = "running" | "completed" | "failed" | "skipped";

/** Fix status in the database */
export type FixStatus =
  | "pending"
  | "in_progress"
  | "fixed"
  | "failed"
  | "skipped"
  | "superseded";
