// ============================================================================
// HTTP server for live progress UI — uses Bun.serve with SSE
// ============================================================================

import { resolve, normalize } from "path";
import { existsSync, realpathSync } from "fs";
import type { PipelineEvent } from "./events";
import { events } from "./events";

/** Accumulated state for late-connecting clients */
interface AccumulatedState {
  phase: string;
  phaseStatuses: Record<string, "started" | "completed">;
  totalPolicies: number;
  pipelineComplete: boolean;
  pipelineSuccess: boolean;
  audits: Record<
    string,
    {
      policy: string;
      branchCount: number;
      processed: number;
      succeeded: number;
      failed: number;
      branches: Record<
        string,
        {
          status: "running" | "done" | "failed";
          fileCount: number;
          issueCount: number;
          error?: string;
        }
      >;
    }
  >;
  fix: {
    totalBatches: number;
    totalIssues: number;
    fixed: number;
    failed: number;
    batches: Record<
      number,
      {
        status: "running" | "done" | "failed";
        fileCount: number;
        issueCount: number;
        attempt: number;
        maxAttempts: number;
        checkPassed?: boolean;
      }
    >;
  };
  costEstimate: {
    model: string;
    branchCount: number;
    noCacheCost: number;
    standardCost: number;
    batchCost: number;
  } | null;
  costEstimateAggregated: {
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
  } | null;
  costConfirmRequest: {
    estimate: {
      model: string;
      branchCount: number;
      noCacheCost: number;
      standardCost: number;
      batchCost: number;
    };
    requestId: string;
  } | null;
  logs: Array<{ level: string; message: string; timestamp: string }>;
  startTime: string;
}

function createInitialState(): AccumulatedState {
  return {
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

function applyEvent(state: AccumulatedState, event: PipelineEvent): void {
  switch (event.type) {
    case "pipeline:start":
      state.phase = event.phase;
      state.totalPolicies = event.totalPolicies;
      break;
    case "pipeline:phase":
      state.phaseStatuses[event.phase] = event.status;
      if (event.status === "started") state.phase = event.phase;
      break;
    case "pipeline:complete":
      state.pipelineComplete = true;
      state.pipelineSuccess = event.success;
      state.phase = "done";
      break;
    case "audit:start":
      state.audits[event.policy] = {
        policy: event.policy,
        branchCount: event.branchCount,
        processed: 0,
        succeeded: 0,
        failed: 0,
        branches: {},
      };
      break;
    case "audit:branch:start": {
      const audit = state.audits[event.policy];
      if (audit) {
        audit.branches[event.branch] = {
          status: "running",
          fileCount: event.fileCount,
          issueCount: 0,
        };
      }
      break;
    }
    case "audit:branch:complete": {
      const audit = state.audits[event.policy];
      if (audit) {
        const branch = audit.branches[event.branch];
        if (branch) {
          branch.status = "done";
          branch.issueCount = event.issueCount;
        }
        audit.succeeded++;
        audit.processed++;
      }
      break;
    }
    case "audit:branch:fail": {
      const audit = state.audits[event.policy];
      if (audit) {
        const branch = audit.branches[event.branch];
        if (branch) {
          branch.status = "failed";
          branch.error = event.error;
        }
        audit.failed++;
        audit.processed++;
      }
      break;
    }
    case "audit:complete": {
      const audit = state.audits[event.policy];
      if (audit) {
        audit.processed = event.processed;
        audit.succeeded = event.succeeded;
        audit.failed = event.failed;
      }
      break;
    }
    case "fix:start":
      state.fix.totalBatches = event.totalBatches;
      state.fix.totalIssues = event.totalIssues;
      break;
    case "fix:batch:start":
      state.fix.batches[event.batchNum] = {
        status: "running",
        fileCount: event.fileCount,
        issueCount: event.issueCount,
        attempt: 1,
        maxAttempts: 3,
      };
      break;
    case "fix:batch:attempt": {
      const batch = state.fix.batches[event.batchNum];
      if (batch) {
        batch.attempt = event.attempt;
        batch.maxAttempts = event.maxAttempts;
      }
      break;
    }
    case "fix:batch:check": {
      const batch = state.fix.batches[event.batchNum];
      if (batch) batch.checkPassed = event.passed;
      break;
    }
    case "fix:batch:complete": {
      const batch = state.fix.batches[event.batchNum];
      if (batch) batch.status = event.success ? "done" : "failed";
      if (event.success) state.fix.fixed++;
      else state.fix.failed++;
      break;
    }
    case "fix:complete":
      state.fix.fixed = event.fixed;
      state.fix.failed = event.failed;
      break;
    case "cost:estimate":
      state.costEstimate = event.estimate;
      break;
    case "cost:estimate:aggregated":
      state.costEstimateAggregated = event.estimate;
      break;
    case "cost:confirm-request":
      state.costConfirmRequest = {
        estimate: {
          model: event.estimate.model,
          branchCount: event.estimate.branchCount,
          noCacheCost: event.estimate.noCacheCost,
          standardCost: event.estimate.standardApiCost,
          batchCost: event.estimate.batchApiCost,
        },
        requestId: event.requestId,
      };
      break;
    case "cost:confirm-response":
      state.costConfirmRequest = null;
      break;
    case "log":
      // Keep last 500 log lines for state hydration
      state.logs.push({
        level: event.level,
        message: event.message,
        timestamp: event.timestamp,
      });
      if (state.logs.length > 500) {
        state.logs.shift();
      }
      break;
  }
}

let serverInstance: ReturnType<typeof Bun.serve> | null = null;

export function startServer(): { port: number; stop: () => Promise<void> } {
  const state = createInitialState();
  const sseClients = new Set<ReadableStreamDefaultController>();

  // Subscribe to all events and accumulate state
  const unsub = events.onAny((event) => {
    applyEvent(state, event);
    const data = JSON.stringify(event);
    for (const controller of sseClients) {
      try {
        controller.enqueue(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(controller);
      }
    }
  });

  const distDir = resolve(import.meta.dir, "ui", "dist");

  const server = Bun.serve({
    port: 0,
    idleTimeout: 255, // max value — SSE connections are long-lived
    routes: {
      "/api/events": () => {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            // Send a connection confirmation
            controller.enqueue(
              `data: ${JSON.stringify({ type: "connected" })}\n\n`,
            );
          },
          cancel(controller) {
            sseClients.delete(controller);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },

      "/api/state": () => {
        return Response.json(state, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      },

      "/api/confirm": {
        async POST(req: Request) {
          const body = await req.json();
          if (
            !body ||
            typeof body !== "object" ||
            typeof body.approved !== "boolean" ||
            typeof body.requestId !== "string"
          ) {
            return Response.json(
              { error: "Invalid body: requires { approved: boolean, requestId: string }" },
              {
                status: 400,
                headers: { "Access-Control-Allow-Origin": "*" },
              },
            );
          }
          events.emit({
            type: "cost:confirm-response",
            approved: body.approved,
            requestId: body.requestId,
          });
          return Response.json(
            { ok: true },
            {
              headers: {
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        },
        OPTIONS() {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          });
        },
      },
    },

    fetch(req) {
      const url = new URL(req.url);
      const filePath = url.pathname;

      // CORS for API routes
      if (filePath.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      // Serve static files from dist
      if (filePath.startsWith("/assets/")) {
        const assetPath = resolve(distDir, normalize(filePath.slice(1)));
        if (
          existsSync(assetPath) &&
          realpathSync(assetPath).startsWith(realpathSync(distDir) + "/")
        ) {
          return new Response(Bun.file(assetPath));
        }
      }

      // SPA fallback — serve index.html
      const indexPath = resolve(distDir, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath));
      }

      return new Response("UI not built. Run: bun build:ui", { status: 404 });
    },
  });

  serverInstance = server;

  return {
    port: server.port as number,
    async stop() {
      unsub();
      for (const controller of sseClients) {
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
      await server.stop();
      serverInstance = null;
    },
  };
}

export function getServerInstance() {
  return serverInstance;
}
