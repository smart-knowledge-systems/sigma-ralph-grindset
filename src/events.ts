// ============================================================================
// Typed singleton event bus for pipeline progress tracking
// ============================================================================

import type { CostEstimate, PerBranchCostEstimate } from "./types";

/**
 * Sanitize an error string for safe inclusion in events.
 * Strips URLs (may contain tokens), truncates to a safe length,
 * and redacts patterns that look like API keys or tokens.
 */
export function sanitizeErrorForEvent(error: string): string {
  return (
    error
      // Strip URLs that may contain tokens/credentials
      .replace(/https?:\/\/\S+/g, "[URL redacted]")
      // Redact strings that look like API keys (sk-..., key-..., etc.)
      .replace(
        /\b(sk|key|token|bearer|auth)[_-]?[A-Za-z0-9]{20,}\b/gi,
        "[credential redacted]",
      )
      // Truncate to 1000 chars max
      .slice(0, 1000)
  );
}

export type PipelineEvent =
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
      estimate: PerBranchCostEstimate;
    }
  | {
      type: "infra.cost.confirm.request";
      estimate: CostEstimate;
      requestId: string;
    }
  | {
      type: "infra.cost.confirm.response";
      approved: boolean;
      requestId: string;
    }
  | {
      type: "infra.cost.actual";
      model: string;
      actualCost: number;
      estimatedCost: number;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens: number;
        cacheReadInputTokens: number;
      };
    }
  | {
      type: "infra.apikey.request";
      requestId: string;
      message: string;
    }
  | {
      type: "infra.apikey.response";
      requestId: string;
      apiKey: string | null;
    }
  | {
      type: "log";
      level: string;
      message: string;
      timestamp: string;
      runId: string;
      meta?: Record<string, unknown>;
    };

type Handler = (event: PipelineEvent) => void;
type TypedHandler<T extends PipelineEvent["type"]> = (
  event: Extract<PipelineEvent, { type: T }>,
) => void;

class PipelineEventBus {
  private anyHandlers = new Set<Handler>();
  private typedHandlers = new Map<string, Set<Handler>>();
  private runId: string | null = null;

  /** Set the pipeline run ID. Attached to every emitted event for correlation. */
  setRunId(id: string): void {
    this.runId = id;
  }

  emit(event: PipelineEvent): void {
    // Enrich every event with runId for cross-event correlation
    if (this.runId) {
      Object.assign(event, { runId: this.runId });
    }

    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch (e) {
        // Log handler errors to stderr so failures are diagnosable
        process.stderr.write(
          `[EventBus] Handler error on ${event.type}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    const handlers = this.typedHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (e) {
          process.stderr.write(
            `[EventBus] Handler error on ${event.type}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    }
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  on<T extends PipelineEvent["type"]>(
    type: T,
    handler: TypedHandler<T>,
  ): () => void {
    let handlers = this.typedHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.typedHandlers.set(type, handlers);
    }
    handlers.add(handler as Handler);
    return () => {
      const current = this.typedHandlers.get(type);
      if (current) {
        current.delete(handler as Handler);
      }
    };
  }

  off<T extends PipelineEvent["type"]>(
    type: T,
    handler: TypedHandler<T>,
  ): void {
    const handlers = this.typedHandlers.get(type);
    if (handlers) {
      handlers.delete(handler as Handler);
    }
  }

  removeAllListeners(): void {
    this.anyHandlers.clear();
    this.typedHandlers.clear();
  }
}

export const events = new PipelineEventBus();
