// Pipeline event types — mirrors backend src/events.ts

export type PipelineEvent =
  | { type: "connected" }
  | { type: "infra.pipeline.start"; phase: string; totalPolicies: number }
  | {
      type: "infra.pipeline.phase";
      phase: string;
      status: "started" | "completed";
    }
  | { type: "infra.pipeline.complete"; success: boolean }
  | {
      type: "audit.start";
      policy: string;
      branchCount: number;
      policyIndex: number;
      totalPolicies: number;
    }
  | {
      type: "audit.branch.start";
      branch: string;
      fileCount: number;
      policy: string;
    }
  | {
      type: "audit.branch.complete";
      branch: string;
      issueCount: number;
      policy: string;
    }
  | {
      type: "audit.branch.fail";
      branch: string;
      error: string;
      policy: string;
    }
  | {
      type: "audit.complete";
      policy: string;
      processed: number;
      succeeded: number;
      failed: number;
    }
  | { type: "fix.start"; totalBatches: number; totalIssues: number }
  | {
      type: "fix.batch.start";
      batchNum: number;
      totalBatches: number;
      fileCount: number;
      issueCount: number;
    }
  | {
      type: "fix.batch.attempt";
      batchNum: number;
      attempt: number;
      maxAttempts: number;
    }
  | { type: "fix.batch.check"; batchNum: number; passed: boolean }
  | { type: "fix.batch.complete"; batchNum: number; success: boolean }
  | { type: "fix.complete"; fixed: number; failed: number }
  | {
      type: "infra.cost.estimate";
      estimate: {
        model: string;
        branchCount: number;
        noCacheCost: number;
        standardCost: number;
        batchCost: number;
      };
    }
  | {
      type: "infra.cost.estimate.aggregated";
      estimate: AggregatedCostEstimate;
    }
  | {
      type: "infra.cost.confirm.request";
      estimate: CostEstimate;
      requestId: string;
    }
  | { type: "log"; level: string; message: string; timestamp: string };

export interface BranchState {
  status: "running" | "done" | "failed";
  fileCount: number;
  issueCount: number;
  error?: string;
}

export interface AuditState {
  policy: string;
  branchCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  branches: Record<string, BranchState>;
}

export interface BatchState {
  status: "running" | "done" | "failed";
  fileCount: number;
  issueCount: number;
  attempt: number;
  maxAttempts: number;
  checkPassed?: boolean;
}

export interface FixState {
  totalBatches: number;
  totalIssues: number;
  fixed: number;
  failed: number;
  batches: Record<number, BatchState>;
}

export interface CostEstimate {
  model: string;
  branchCount: number;
  noCacheCost: number;
  standardCost: number;
  batchCost: number;
}

export interface AggregatedCostEstimate {
  model: string;
  branchCount: number;
  policyCount: number;
  totalRequests: number;
  totalBatchApiCost: number;
  totalNoCacheCost: number;
  perPolicy: Array<{
    policyName: string;
    policyTokens: number;
    batchApiCost: number;
  }>;
}

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

export interface UIState {
  connected: boolean;
  phase: string;
  phaseStatuses: Record<string, "started" | "completed">;
  totalPolicies: number;
  pipelineComplete: boolean;
  pipelineSuccess: boolean;
  audits: Record<string, AuditState>;
  fix: FixState;
  costEstimate: CostEstimate | null;
  costEstimateAggregated: AggregatedCostEstimate | null;
  costConfirmRequest: { estimate: CostEstimate; requestId: string } | null;
  logs: LogEntry[];
  startTime: string;
}
