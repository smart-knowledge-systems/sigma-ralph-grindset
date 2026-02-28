// SSE hook: connects to /api/events, hydrates from /api/state, dispatches events.
//
// Hydration fetches the current server snapshot and applies it as a single
// atomic "hydrate:snapshot" action so the reducer processes it in one pass.
// After hydration, an EventSource streams incremental PipelineEvents.

import { useEffect, useReducer, useRef } from "react";
import type { PipelineEvent, HydrationSnapshot, UIState } from "../types";
import { createInitialState, reducer } from "../state";

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

/** All valid PipelineEvent type discriminants (must match the PipelineEvent union in types.ts). */
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<PipelineEvent["type"]>([
  "connected",
  "infra.pipeline.start",
  "infra.pipeline.phase",
  "infra.pipeline.complete",
  "audit.start",
  "audit.branch.start",
  "audit.branch.complete",
  "audit.branch.fail",
  "audit.complete",
  "fix.start",
  "fix.batch.start",
  "fix.batch.attempt",
  "fix.batch.check",
  "fix.batch.complete",
  "fix.complete",
  "infra.cost.estimate",
  "infra.cost.estimate.aggregated",
  "infra.cost.confirm.request",
  "infra.cost.confirm.response",
  "log",
]);

/** Runtime type guard for incoming SSE events. */
function isValidEvent(data: unknown): data is PipelineEvent {
  if (data == null || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.type === "string" && VALID_EVENT_TYPES.has(obj.type);
}

// ---------------------------------------------------------------------------
// Module-level init guard — prevents double-hydration in React StrictMode
// ---------------------------------------------------------------------------

let didInit = false;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSSE(): UIState {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Guard against double-init in StrictMode dev remounts
    if (didInit) return;
    didInit = true;

    let eventSource: EventSource | null = null;
    let mounted = true;
    const abortController = new AbortController();

    // ----- Hydration: fetch /api/state and apply as single snapshot -----
    async function hydrate() {
      try {
        const res = await fetch("/api/state", {
          signal: abortController.signal,
        });
        if (!res.ok || !mounted) return;
        const snapshot: unknown = await res.json();
        if (!mounted) return;

        // Dispatch a single atomic action — the reducer validates and maps fields
        if (snapshot != null && typeof snapshot === "object") {
          dispatch({
            type: "hydrate:snapshot",
            snapshot: snapshot as HydrationSnapshot,
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("[infra.sse.hydration.failed]", {
          error: {
            type: err instanceof Error ? err.name : "UnknownError",
            message: err instanceof Error ? err.message : String(err),
            retriable: true,
          },
        });
      }
    }

    // ----- SSE connection -----
    function connect() {
      if (!mounted) return;
      eventSource = new EventSource("/api/events");

      eventSource.onmessage = (e) => {
        try {
          const parsed: unknown = JSON.parse(e.data);
          if (!isValidEvent(parsed)) {
            console.warn("[infra.sse.unknown_event]", {
              raw_type:
                parsed != null && typeof parsed === "object" && "type" in parsed
                  ? (parsed as Record<string, unknown>).type
                  : undefined,
            });
            return;
          }
          dispatch(parsed);
        } catch (err) {
          console.warn("[infra.sse.parse_error]", {
            error: {
              type: "ParseError",
              message: err instanceof Error ? err.message : String(err),
              retriable: false,
            },
            raw_length: e.data?.length,
          });
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        if (!mounted) return;
        // Clear any pending reconnect before scheduling a new one
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        console.warn("[infra.sse.connection.error]", {
          reconnect_delay_ms: 2000,
        });
        reconnectTimer.current = setTimeout(connect, 2000);
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
