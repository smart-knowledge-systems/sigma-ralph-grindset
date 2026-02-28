// SSE hook: connects to /api/events, hydrates from /api/state, dispatches events

import { useEffect, useReducer, useRef } from "react";
import type { PipelineEvent, UIState } from "../types";
import { createInitialState, reducer } from "../state";

const VALID_EVENT_TYPES = new Set([
  "connected",
  "pipeline:start",
  "pipeline:phase",
  "pipeline:complete",
  "audit:start",
  "audit:branch:start",
  "audit:branch:complete",
  "audit:branch:fail",
  "audit:complete",
  "fix:start",
  "fix:batch:start",
  "fix:batch:attempt",
  "fix:batch:check",
  "fix:batch:complete",
  "fix:complete",
  "cost:estimate",
  "cost:estimate:aggregated",
  "cost:confirm-request",
  "log",
]);

function isValidEvent(data: unknown): data is PipelineEvent {
  if (data == null || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.type === "string" && VALID_EVENT_TYPES.has(obj.type);
}

export function useSSE(): UIState {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let mounted = true;
    const abortController = new AbortController();

    async function hydrate() {
      try {
        const res = await fetch("/api/state", {
          signal: abortController.signal,
        });
        if (!res.ok || !mounted) return;
        const snapshot = await res.json();
        if (!mounted) return;

        // Replay snapshot as synthetic events
        if (snapshot.phase !== "idle") {
          dispatch({
            type: "pipeline:start",
            phase: snapshot.phase,
            totalPolicies: snapshot.totalPolicies,
          });
        }
        for (const [phase, status] of Object.entries(snapshot.phaseStatuses)) {
          dispatch({
            type: "pipeline:phase",
            phase,
            status: status as "started" | "completed",
          });
        }
        if (snapshot.pipelineComplete) {
          dispatch({
            type: "pipeline:complete",
            success: snapshot.pipelineSuccess,
          });
        }

        // Hydrate audits
        for (const audit of Object.values(snapshot.audits) as Array<{
          policy: string;
          branchCount: number;
          processed: number;
          succeeded: number;
          failed: number;
          branches: Record<
            string,
            {
              status: string;
              fileCount: number;
              issueCount: number;
              error?: string;
            }
          >;
        }>) {
          dispatch({
            type: "audit:start",
            policy: audit.policy,
            branchCount: audit.branchCount,
            policyIndex: 0,
            totalPolicies: snapshot.totalPolicies,
          });
          for (const [branch, bState] of Object.entries(audit.branches)) {
            dispatch({
              type: "audit:branch:start",
              branch,
              fileCount: bState.fileCount,
              policy: audit.policy,
            });
            if (bState.status === "done") {
              dispatch({
                type: "audit:branch:complete",
                branch,
                issueCount: bState.issueCount,
                policy: audit.policy,
              });
            } else if (bState.status === "failed") {
              dispatch({
                type: "audit:branch:fail",
                branch,
                error: bState.error ?? "Unknown error",
                policy: audit.policy,
              });
            }
          }
        }

        // Hydrate fix state
        if (snapshot.fix.totalBatches > 0) {
          dispatch({
            type: "fix:start",
            totalBatches: snapshot.fix.totalBatches,
            totalIssues: snapshot.fix.totalIssues,
          });
          for (const [numStr, batch] of Object.entries(
            snapshot.fix.batches,
          ) as Array<
            [
              string,
              {
                status: string;
                fileCount: number;
                issueCount: number;
                attempt: number;
                maxAttempts: number;
              },
            ]
          >) {
            const num = Number(numStr);
            dispatch({
              type: "fix:batch:start",
              batchNum: num,
              totalBatches: snapshot.fix.totalBatches,
              fileCount: batch.fileCount,
              issueCount: batch.issueCount,
            });
            if (batch.status === "done") {
              dispatch({
                type: "fix:batch:complete",
                batchNum: num,
                success: true,
              });
            } else if (batch.status === "failed") {
              dispatch({
                type: "fix:batch:complete",
                batchNum: num,
                success: false,
              });
            }
          }
        }

        // Hydrate cost estimate
        if (snapshot.costEstimate) {
          dispatch({ type: "cost:estimate", estimate: snapshot.costEstimate });
        }

        // Hydrate aggregated cost estimate
        if (snapshot.costEstimateAggregated) {
          dispatch({
            type: "cost:estimate:aggregated",
            estimate: snapshot.costEstimateAggregated,
          });
        }

        // Hydrate cost confirm request
        if (snapshot.costConfirmRequest) {
          dispatch({
            type: "cost:confirm-request",
            estimate: snapshot.costConfirmRequest.estimate,
            requestId: snapshot.costConfirmRequest.requestId,
          });
        }

        // Hydrate logs
        for (const log of snapshot.logs ?? []) {
          dispatch({ type: "log", ...log });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("SSE hydration failed:", err);
      }
    }

    function connect() {
      if (!mounted) return;
      eventSource = new EventSource("/api/events");

      eventSource.onmessage = (e) => {
        try {
          const parsed: unknown = JSON.parse(e.data);
          if (!isValidEvent(parsed)) {
            console.warn("SSE received unknown event type:", parsed);
            return;
          }
          dispatch(parsed);
        } catch (err) {
          console.warn("SSE parse error:", err);
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        if (mounted) {
          if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };
    }

    hydrate().then(connect);

    return () => {
      mounted = false;
      abortController.abort();
      eventSource?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, []);

  return state;
}
