// State reducer: PipelineEvent -> UIState

import type { PipelineEvent, UIState } from "./types";

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
    costConfirmRequest: null,
    logs: [],
    startTime: new Date().toISOString(),
  };
}

export function reducer(state: UIState, event: PipelineEvent): UIState {
  switch (event.type) {
    case "connected":
      return { ...state, connected: true };

    case "pipeline:start":
      return {
        ...state,
        phase: event.phase,
        totalPolicies: event.totalPolicies,
      };

    case "pipeline:phase":
      return {
        ...state,
        phaseStatuses: { ...state.phaseStatuses, [event.phase]: event.status },
        phase: event.status === "started" ? event.phase : state.phase,
      };

    case "pipeline:complete":
      return {
        ...state,
        pipelineComplete: true,
        pipelineSuccess: event.success,
        phase: "done",
      };

    case "audit:start":
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

    case "audit:branch:start": {
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

    case "audit:branch:complete": {
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

    case "audit:branch:fail": {
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

    case "audit:complete": {
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

    case "fix:start":
      return {
        ...state,
        fix: {
          ...state.fix,
          totalBatches: event.totalBatches,
          totalIssues: event.totalIssues,
        },
      };

    case "fix:batch:start":
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

    case "fix:batch:attempt": {
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

    case "fix:batch:check": {
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

    case "fix:batch:complete": {
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

    case "fix:complete":
      return {
        ...state,
        fix: { ...state.fix, fixed: event.fixed, failed: event.failed },
      };

    case "cost:estimate":
      return { ...state, costEstimate: event.estimate };

    case "cost:confirm-request":
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
