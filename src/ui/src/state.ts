// State reducer: ReducerAction -> UIState

import type {
  ReducerAction,
  UIState,
  AuditState,
  BranchState,
  BatchState,
  FixState,
  HydrationSnapshot,
} from "./types";

export function createInitialState(): UIState {
  return {
    connected: false,
    phase: "idle",
    phaseStatuses: {},
    totalPolicies: 0,
    pipelineComplete: false,
    pipelineSuccess: false,
    audits: {},
    fix: {
      totalBatches: 0,
      totalIssues: 0,
      fixed: 0,
      failed: 0,
      batches: {},
    },
    costEstimate: null,
    costEstimateAggregated: null,
    costConfirmRequest: null,
    logs: [],
    startTime: new Date().toISOString(),
  };
}

export function reducer(state: UIState, event: ReducerAction): UIState {
  switch (event.type) {
    case "connected":
      return { ...state, connected: true };

    case "hydrate:snapshot":
      return applySnapshot(state, event.snapshot);

    case "infra.pipeline.start":
      return {
        ...state,
        phase: event.phase,
        totalPolicies: event.totalPolicies,
      };

    case "infra.pipeline.phase":
      return {
        ...state,
        phaseStatuses: { ...state.phaseStatuses, [event.phase]: event.status },
        phase: event.status === "started" ? event.phase : state.phase,
      };

    case "infra.pipeline.complete":
      return {
        ...state,
        pipelineComplete: true,
        pipelineSuccess: event.success,
        phase: "done",
      };

    case "audit.start":
      return {
        ...state,
        audits: {
          ...state.audits,
          [event.policy]: {
            policy: event.policy,
            branchCount: event.branchCount,
            processed: 0,
            succeeded: 0,
            failed: 0,
            branches: {},
          },
        },
      };

    case "audit.branch.start": {
      const audit = state.audits[event.policy];
      if (!audit) return state;
      return {
        ...state,
        audits: {
          ...state.audits,
          [event.policy]: {
            ...audit,
            branches: {
              ...audit.branches,
              [event.branch]: {
                status: "running",
                fileCount: event.fileCount,
                issueCount: 0,
              },
            },
          },
        },
      };
    }

    case "audit.branch.complete": {
      const audit = state.audits[event.policy];
      if (!audit) return state;
      const branch = audit.branches[event.branch];
      return {
        ...state,
        audits: {
          ...state.audits,
          [event.policy]: {
            ...audit,
            succeeded: audit.succeeded + 1,
            processed: audit.processed + 1,
            branches: {
              ...audit.branches,
              [event.branch]: {
                ...(branch ?? { fileCount: 0 }),
                status: "done",
                issueCount: event.issueCount,
              },
            },
          },
        },
      };
    }

    case "audit.branch.fail": {
      const audit = state.audits[event.policy];
      if (!audit) return state;
      const branch = audit.branches[event.branch];
      return {
        ...state,
        audits: {
          ...state.audits,
          [event.policy]: {
            ...audit,
            failed: audit.failed + 1,
            processed: audit.processed + 1,
            branches: {
              ...audit.branches,
              [event.branch]: {
                ...(branch ?? { fileCount: 0, issueCount: 0 }),
                status: "failed",
                error: event.error,
              },
            },
          },
        },
      };
    }

    case "audit.complete": {
      const audit = state.audits[event.policy];
      if (!audit) return state;
      return {
        ...state,
        audits: {
          ...state.audits,
          [event.policy]: {
            ...audit,
            processed: event.processed,
            succeeded: event.succeeded,
            failed: event.failed,
          },
        },
      };
    }

    case "fix.start":
      return {
        ...state,
        fix: {
          ...state.fix,
          totalBatches: event.totalBatches,
          totalIssues: event.totalIssues,
        },
      };

    case "fix.batch.start":
      return {
        ...state,
        fix: {
          ...state.fix,
          batches: {
            ...state.fix.batches,
            [event.batchNum]: {
              status: "running",
              fileCount: event.fileCount,
              issueCount: event.issueCount,
              attempt: 1,
              maxAttempts: 3,
            },
          },
        },
      };

    case "fix.batch.attempt": {
      const batch = state.fix.batches[event.batchNum];
      if (!batch) return state;
      return {
        ...state,
        fix: {
          ...state.fix,
          batches: {
            ...state.fix.batches,
            [event.batchNum]: {
              ...batch,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
            },
          },
        },
      };
    }

    case "fix.batch.check": {
      const batch = state.fix.batches[event.batchNum];
      if (!batch) return state;
      return {
        ...state,
        fix: {
          ...state.fix,
          batches: {
            ...state.fix.batches,
            [event.batchNum]: { ...batch, checkPassed: event.passed },
          },
        },
      };
    }

    case "fix.batch.complete": {
      const batch = state.fix.batches[event.batchNum];
      return {
        ...state,
        fix: {
          ...state.fix,
          fixed: state.fix.fixed + (event.success ? 1 : 0),
          failed: state.fix.failed + (event.success ? 0 : 1),
          batches: {
            ...state.fix.batches,
            [event.batchNum]: {
              ...(batch ?? {
                fileCount: 0,
                issueCount: 0,
                attempt: 1,
                maxAttempts: 3,
              }),
              status: event.success ? "done" : "failed",
            },
          },
        },
      };
    }

    case "fix.complete":
      return {
        ...state,
        fix: { ...state.fix, fixed: event.fixed, failed: event.failed },
      };

    case "infra.cost.estimate":
      return { ...state, costEstimate: event.estimate };

    case "infra.cost.estimate.aggregated":
      return { ...state, costEstimateAggregated: event.estimate };

    case "infra.cost.confirm.request":
      return {
        ...state,
        costConfirmRequest: {
          estimate: event.estimate,
          requestId: event.requestId,
        },
      };

    case "log":
      return {
        ...state,
        logs: [
          ...state.logs,
          {
            level: event.level,
            message: event.message,
            timestamp: event.timestamp,
          },
        ].slice(-500),
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Snapshot hydration — maps the /api/state response into UIState atomically.
// All fields are defensively accessed since the snapshot is external data.
// ---------------------------------------------------------------------------

function toBranchStatus(raw: string): BranchState["status"] {
  if (raw === "done" || raw === "failed") return raw;
  return "running";
}

function toBatchStatus(raw: string): BatchState["status"] {
  if (raw === "done" || raw === "failed") return raw;
  return "running";
}

function toPhaseStatus(raw: string): "started" | "completed" {
  return raw === "completed" ? "completed" : "started";
}

function applySnapshot(state: UIState, s: HydrationSnapshot): UIState {
  // Build audit state
  const audits: Record<string, AuditState> = {};
  for (const [key, raw] of Object.entries(s.audits ?? {})) {
    const branches: Record<string, BranchState> = {};
    for (const [bKey, b] of Object.entries(raw.branches ?? {})) {
      branches[bKey] = {
        status: toBranchStatus(b.status),
        fileCount: b.fileCount ?? 0,
        issueCount: b.issueCount ?? 0,
        error: b.error,
      };
    }
    audits[key] = {
      policy: raw.policy,
      branchCount: raw.branchCount,
      processed: raw.processed,
      succeeded: raw.succeeded,
      failed: raw.failed,
      branches,
    };
  }

  // Build fix state
  const batches: Record<number, BatchState> = {};
  for (const [numStr, raw] of Object.entries(s.fix?.batches ?? {})) {
    const num = Number(numStr);
    if (Number.isNaN(num)) continue;
    batches[num] = {
      status: toBatchStatus(raw.status),
      fileCount: raw.fileCount ?? 0,
      issueCount: raw.issueCount ?? 0,
      attempt: raw.attempt ?? 1,
      maxAttempts: raw.maxAttempts ?? 3,
    };
  }
  const doneCount = Object.values(batches).filter(
    (b) => b.status === "done",
  ).length;
  const failCount = Object.values(batches).filter(
    (b) => b.status === "failed",
  ).length;
  const fix: FixState = {
    totalBatches: s.fix?.totalBatches ?? 0,
    totalIssues: s.fix?.totalIssues ?? 0,
    fixed: doneCount,
    failed: failCount,
    batches,
  };

  // Build phase statuses with validated values
  const phaseStatuses: Record<string, "started" | "completed"> = {};
  for (const [phase, status] of Object.entries(s.phaseStatuses ?? {})) {
    phaseStatuses[phase] = toPhaseStatus(status);
  }

  return {
    ...state,
    connected: true,
    phase: s.phase ?? state.phase,
    totalPolicies: s.totalPolicies ?? state.totalPolicies,
    phaseStatuses,
    pipelineComplete: s.pipelineComplete ?? false,
    pipelineSuccess: s.pipelineSuccess ?? false,
    audits,
    fix,
    costEstimate: s.costEstimate ?? null,
    costEstimateAggregated: s.costEstimateAggregated ?? null,
    costConfirmRequest: s.costConfirmRequest ?? null,
    logs: [...state.logs, ...(s.logs ?? [])].slice(-500),
  };
}
