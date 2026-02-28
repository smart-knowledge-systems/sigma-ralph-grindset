// SSE hook: connects to /api/events, hydrates from /api/state, dispatches events

import { useEffect, useReducer, useRef } from "react";
import type { PipelineEvent, UIState } from "../types";
import { createInitialState, reducer } from "../state";

export function useSSE(): UIState {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let mounted = true;

    async function hydrate() {
      try {
        const res = await fetch("/api/state");
        if (!res.ok) return;
        const snapshot = await res.json();

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
      } catch {
        // ignore hydration errors
      }
    }

    function connect() {
      if (!mounted) return;
      eventSource = new EventSource("/api/events");

      eventSource.onmessage = (e) => {
        try {
          const event: PipelineEvent = JSON.parse(e.data);
          dispatch(event);
        } catch {
          // ignore parse errors
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        if (mounted) {
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };
    }

    hydrate().then(connect);

    return () => {
      mounted = false;
      eventSource?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, []);

  return state;
}
