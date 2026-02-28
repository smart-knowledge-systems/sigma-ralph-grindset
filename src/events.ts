// ============================================================================
// Typed singleton event bus for pipeline progress tracking
// ============================================================================

import type { CostEstimate } from "./types";

export type PipelineEvent =
  | { type: "pipeline:start"; phase: string; totalPolicies: number }
  | { type: "pipeline:phase"; phase: string; status: "started" | "completed" }
  | { type: "pipeline:complete"; success: boolean }
  | {
      type: "audit:start";
      policy: string;
      branchCount: number;
      policyIndex: number;
      totalPolicies: number;
    }
  | {
      type: "audit:branch:start";
      branch: string;
      fileCount: number;
      policy: string;
    }
  | {
      type: "audit:branch:complete";
      branch: string;
      issueCount: number;
      policy: string;
    }
  | {
      type: "audit:branch:fail";
      branch: string;
      error: string;
      policy: string;
    }
  | {
      type: "audit:complete";
      policy: string;
      processed: number;
      succeeded: number;
      failed: number;
    }
  | { type: "fix:start"; totalBatches: number; totalIssues: number }
  | {
      type: "fix:batch:start";
      batchNum: number;
      totalBatches: number;
      fileCount: number;
      issueCount: number;
    }
  | {
      type: "fix:batch:attempt";
      batchNum: number;
      attempt: number;
      maxAttempts: number;
    }
  | { type: "fix:batch:check"; batchNum: number; passed: boolean }
  | { type: "fix:batch:complete"; batchNum: number; success: boolean }
  | { type: "fix:complete"; fixed: number; failed: number }
  | {
      type: "cost:estimate";
      estimate: {
        model: string;
        branchCount: number;
        noCacheCost: number;
        standardCost: number;
        batchCost: number;
      };
    }
  | {
      type: "cost:confirm-request";
      estimate: CostEstimate;
      requestId: string;
    }
  | {
      type: "cost:confirm-response";
      approved: boolean;
      requestId: string;
    }
  | { type: "log"; level: string; message: string; timestamp: string };

type Handler = (event: PipelineEvent) => void;
type TypedHandler<T extends PipelineEvent["type"]> = (
  event: Extract<PipelineEvent, { type: T }>,
) => void;

class PipelineEventBus {
  private anyHandlers: Handler[] = [];
  private typedHandlers = new Map<string, Handler[]>();

  emit(event: PipelineEvent): void {
    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch {
        // fire-and-forget
      }
    }
    const handlers = this.typedHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // fire-and-forget
        }
      }
    }
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.push(handler);
    return () => {
      this.anyHandlers = this.anyHandlers.filter((h) => h !== handler);
    };
  }

  on<T extends PipelineEvent["type"]>(
    type: T,
    handler: TypedHandler<T>,
  ): () => void {
    const handlers = this.typedHandlers.get(type) ?? [];
    handlers.push(handler as Handler);
    this.typedHandlers.set(type, handlers);
    return () => {
      const current = this.typedHandlers.get(type);
      if (current) {
        this.typedHandlers.set(
          type,
          current.filter((h) => h !== handler),
        );
      }
    };
  }

  off<T extends PipelineEvent["type"]>(
    type: T,
    handler: TypedHandler<T>,
  ): void {
    const handlers = this.typedHandlers.get(type);
    if (handlers) {
      this.typedHandlers.set(
        type,
        handlers.filter((h) => h !== handler),
      );
    }
  }

  removeAllListeners(): void {
    this.anyHandlers = [];
    this.typedHandlers.clear();
  }
}

export const events = new PipelineEventBus();
