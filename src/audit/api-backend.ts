// ============================================================================
// API backend: Anthropic SDK for single-request and batch audit
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";
import type { AuditResult, AuditConfig, TokenUsage } from "../types";
import type { AddendumContext } from "./addendum";
import { log } from "../logging";
import { resolveModelId } from "../pricing";
import {
  buildSystemPromptBlocks,
  buildSystemPromptBlocksForBranch,
  buildUserPrompt,
  buildUserPromptForPolicy,
} from "./prompts";
import { AUDIT_JSON_SCHEMA, validateAuditResult } from "./schema";
import { getApiKey } from "./ensure-api-key";

// ============================================================================
// Shared helpers
// ============================================================================

let client: Anthropic | null = null;
let clientKey: string | undefined;

function getClient(): Anthropic {
  const key = getApiKey();
  // Re-create the client if the key changed (e.g. ephemeral key was cleared)
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

/** Build the output_config format block used by all API requests. */
function buildOutputConfig() {
  return {
    format: {
      type: "json_schema" as const,
      schema: AUDIT_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Extract token usage from an Anthropic API message usage object.
 * Uses optional chaining with defaults — no unsafe casts needed since
 * the SDK types include cache_creation_input_tokens and cache_read_input_tokens
 * as `number | null`.
 */
function extractUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens:
      (usage as { cache_creation_input_tokens?: number | null })
        .cache_creation_input_tokens ?? 0,
    cacheReadInputTokens:
      (usage as { cache_read_input_tokens?: number | null })
        .cache_read_input_tokens ?? 0,
  };
}

/** Extract and validate the AuditResult from an API message's text block. */
function extractResultFromMessage(
  content: Anthropic.ContentBlock[],
): AuditResult {
  const textBlock = content.find((b) => b.type === "text");
  const rawJson = textBlock?.type === "text" ? textBlock.text : '{"issues":[]}';
  const parsed = JSON.parse(rawJson);
  return validateAuditResult(parsed);
}

/** Accumulate token usage into a running total. */
function accumulateUsage(total: TokenUsage, usage: TokenUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  total.cacheReadInputTokens += usage.cacheReadInputTokens;
}

/** Create a slug from a path, capped to a max length. */
function toSlug(value: string, maxLen: number): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen);
}

// ============================================================================
// Common batch request builder
// ============================================================================

/**
 * Create a single batch request object with standard parameters.
 * Both buildBatchRequest and buildBatchRequestForBranch delegate here
 * to avoid duplicating the request structure.
 */
function createBatchRequest(
  customId: string,
  system: Anthropic.MessageCreateParams["system"],
  userPrompt: string,
  model: string,
): Anthropic.Messages.BatchCreateParams.Request {
  return {
    custom_id: customId,
    params: {
      model,
      max_tokens: 16384,
      system,
      messages: [{ role: "user", content: userPrompt }],
      output_config: buildOutputConfig(),
    },
  };
}

// ============================================================================
// Single-request audit
// ============================================================================

/**
 * Single-request audit via the Anthropic API with structured output.
 */
export async function auditViaApi(
  branchPath: string,
  files: string[],
  policyNames: string[],
  config: AuditConfig,
  useCaching: boolean,
  ctx?: AddendumContext,
): Promise<{ result: AuditResult; usage: TokenUsage }> {
  const c = getClient();
  const model = resolveModelId(config.auditModel);
  const userPrompt = buildUserPrompt(branchPath, files, config);

  const system = useCaching
    ? (buildSystemPromptBlocks(
        config,
        policyNames,
        ctx,
      ) as Anthropic.MessageCreateParams["system"])
    : buildSystemPromptBlocks(config, policyNames, ctx)
        .map((b) => b.text)
        .join("\n");

  log.debug(
    `API call: model=${model} branch=${branchPath} caching=${useCaching}`,
  );

  const startTime = performance.now();
  const response = await c.messages.create({
    model,
    max_tokens: 16384,
    system,
    messages: [{ role: "user", content: userPrompt }],
    output_config: buildOutputConfig(),
  });
  const durationMs = Math.round(performance.now() - startTime);

  log.debug(
    `API response: request_id=${response.id} duration_ms=${durationMs}`,
  );

  const result = extractResultFromMessage(response.content);
  const usage = extractUsage(response.usage);

  return { result, usage };
}

// ============================================================================
// Combined batch audit (single policy, all branches in one batch)
// ============================================================================

/** Build a batch request for a single branch audit (combined policy mode). */
function buildBatchRequest(
  branchPath: string,
  files: string[],
  policyNames: string[],
  config: AuditConfig,
  useCaching: boolean,
  ctx?: AddendumContext,
): Anthropic.Messages.BatchCreateParams.Request {
  const model = resolveModelId(config.auditModel);
  const userPrompt = buildUserPrompt(branchPath, files, config);

  const system = useCaching
    ? buildSystemPromptBlocks(config, policyNames, ctx)
    : buildSystemPromptBlocks(config, policyNames, ctx).map((b) => ({
        type: b.type,
        text: b.text,
      }));

  const customId = `audit-${toSlug(branchPath, 57)}`;
  return createBatchRequest(
    customId,
    system as Anthropic.MessageCreateParams["system"],
    userPrompt,
    model,
  );
}

/**
 * Submit a batch of audit requests and poll until completion.
 * Yields progress events.
 */
export async function* auditViaBatch(
  branches: Array<{ path: string; files: string[] }>,
  policyNames: string[],
  config: AuditConfig,
  useCaching: boolean,
  ctx?: AddendumContext,
): AsyncGenerator<{
  type: "progress" | "result" | "complete";
  branchPath?: string;
  result?: AuditResult;
  usage?: TokenUsage;
  requestId?: string;
  totalUsage?: TokenUsage;
  message?: string;
}> {
  const c = getClient();

  // Build all requests and a lookup map for custom_id → branch path
  const idToBranch = new Map<string, string>();
  const requests = branches.map((b) => {
    const req = buildBatchRequest(
      b.path,
      b.files,
      policyNames,
      config,
      useCaching,
      ctx,
    );
    idToBranch.set(req.custom_id, b.path);
    return req;
  });

  log.info(`Submitting batch of ${requests.length} audit requests...`);

  const startTime = performance.now();
  const batch = await c.messages.batches.create({ requests });
  log.info(`Batch created: ${batch.id}`);

  // Poll until complete
  const pollInterval = 10; // seconds
  let status = batch.processing_status;
  while (status !== "ended") {
    await Bun.sleep(pollInterval * 1000);
    const updated = await c.messages.batches.retrieve(batch.id);
    status = updated.processing_status;
    const counts = updated.request_counts;
    const total =
      counts.succeeded +
      counts.errored +
      counts.expired +
      counts.canceled +
      counts.processing;
    const done =
      counts.succeeded + counts.errored + counts.expired + counts.canceled;

    yield {
      type: "progress",
      message: `Batch ${batch.id}: ${status} (${done}/${total} done, ${counts.succeeded} succeeded)`,
    };
  }

  const durationMs = Math.round(performance.now() - startTime);
  log.debug(`Batch polling completed in ${durationMs}ms`);

  // Collect results
  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  for await (const result of await c.messages.batches.results(batch.id)) {
    const branchPath = idToBranch.get(result.custom_id) ?? result.custom_id;

    if (result.result.type !== "succeeded") {
      let errDetail = "";
      if (result.result.type === "errored") {
        const { error } = result.result;
        errDetail = ` — ${error.error.type}: ${error.error.message}`;
      }
      log.warn(
        `Batch result failed for ${branchPath}: ${result.result.type}${errDetail}`,
      );
      continue;
    }

    const message = result.result.message;
    log.debug(
      `Batch result: custom_id=${result.custom_id} request_id=${message.id}`,
    );
    const parsed = extractResultFromMessage(message.content);
    const usage = extractUsage(message.usage);
    accumulateUsage(totalUsage, usage);

    yield {
      type: "result",
      branchPath,
      result: parsed,
      usage,
      requestId: message.id,
    };
  }

  yield {
    type: "complete",
    totalUsage,
    message: `Batch complete. Total: ${totalUsage.inputTokens} input, ${totalUsage.outputTokens} output tokens`,
  };
}

// ============================================================================
// Per-branch batch audit (one batch per branch, one request per policy)
// ============================================================================

/**
 * Build a batch request for a single branch+policy combination
 * using the per-branch prompt structure (source code in system, policy in user).
 */
export function buildBatchRequestForBranch(
  branchPath: string,
  files: string[],
  policyName: string,
  config: AuditConfig,
  useCaching: boolean = true,
  ctx?: AddendumContext,
): Anthropic.Messages.BatchCreateParams.Request {
  const model = resolveModelId(config.auditModel);
  const rawBlocks = buildSystemPromptBlocksForBranch(config, branchPath, files);
  const systemBlocks = useCaching
    ? rawBlocks
    : rawBlocks.map((b) => ({ type: b.type, text: b.text }));
  const userPrompt = buildUserPromptForPolicy(policyName, config, ctx);

  // custom_id format: a-{branchSlug}-{policySlug} (max 64 chars)
  const branchSlug = toSlug(branchPath, 28);
  const policySlug = toSlug(policyName, 28);
  const customId = `a-${branchSlug}-${policySlug}`.slice(0, 64);

  return createBatchRequest(
    customId,
    systemBlocks as Anthropic.MessageCreateParams["system"],
    userPrompt,
    model,
  );
}

/**
 * Per-branch batch audit: for each branch, build one request per policy and
 * submit as a single batch. All branch batches are submitted in parallel.
 * A unified 10s poll loop tracks all active batches until completion.
 *
 * Yields:
 *   - { type: "result", branchPath, policyName, result, usage } per request
 *   - { type: "progress", message } during polling
 *   - { type: "complete", totalUsage } at end
 */
export async function* auditViaBatchPerBranch(
  branches: Array<{ path: string; files: string[] }>,
  policyNames: string[],
  config: AuditConfig,
  useCaching: boolean = true,
  ctx?: AddendumContext,
): AsyncGenerator<{
  type: "progress" | "result" | "complete";
  branchPath?: string;
  policyName?: string;
  result?: AuditResult;
  usage?: TokenUsage;
  totalUsage?: TokenUsage;
  message?: string;
}> {
  const c = getClient();

  // Build and submit one batch per branch (all in parallel)
  type BatchInfo = {
    batchId: string;
    idToPolicy: Map<string, { branchPath: string; policyName: string }>;
  };

  const batchSubmissions: Promise<BatchInfo>[] = branches.map(
    async (branch) => {
      const idToPolicy = new Map<
        string,
        { branchPath: string; policyName: string }
      >();

      const requests = policyNames.map((policyName) => {
        const req = buildBatchRequestForBranch(
          branch.path,
          branch.files,
          policyName,
          config,
          useCaching,
          ctx,
        );
        idToPolicy.set(req.custom_id, {
          branchPath: branch.path,
          policyName,
        });
        return req;
      });

      log.info(
        `Submitting batch for branch ${branch.path}: ${requests.length} requests`,
      );
      const batch = await c.messages.batches.create({ requests });
      log.info(`Batch created for ${branch.path}: ${batch.id}`);

      return { batchId: batch.id, idToPolicy };
    },
  );

  // Submit all batches in parallel
  const allBatches = await Promise.all(batchSubmissions);
  log.info(`All ${allBatches.length} branch batches submitted`);

  // Unified poll loop: track all active batches
  const activeBatches = new Map<string, BatchInfo>();
  for (const info of allBatches) {
    activeBatches.set(info.batchId, info);
  }

  const pollInterval = 10_000; // 10 seconds
  while (activeBatches.size > 0) {
    await Bun.sleep(pollInterval);

    // Poll all active batches in parallel
    const pollResults = await Promise.all(
      [...activeBatches.keys()].map(async (batchId) => {
        const updated = await c.messages.batches.retrieve(batchId);
        return { batchId, updated };
      }),
    );

    for (const { batchId, updated } of pollResults) {
      const counts = updated.request_counts;
      const total =
        counts.succeeded +
        counts.errored +
        counts.expired +
        counts.canceled +
        counts.processing;
      const done =
        counts.succeeded + counts.errored + counts.expired + counts.canceled;

      yield {
        type: "progress",
        message: `Batch ${batchId}: ${updated.processing_status} (${done}/${total} done, ${counts.succeeded} succeeded)`,
      };

      if (updated.processing_status === "ended") {
        activeBatches.delete(batchId);
      }
    }
  }

  // Collect results from all batches
  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  for (const info of allBatches) {
    for await (const result of await c.messages.batches.results(info.batchId)) {
      const meta = info.idToPolicy.get(result.custom_id);

      if (result.result.type !== "succeeded") {
        let errDetail = "";
        if (result.result.type === "errored") {
          const { error } = result.result;
          errDetail = ` — ${error.error.type}: ${error.error.message}`;
        }
        log.warn(
          `Batch result failed for ${meta?.branchPath ?? result.custom_id} / ${meta?.policyName ?? "?"}: ${result.result.type}${errDetail}`,
        );
        continue;
      }

      const message = result.result.message;
      const parsed = extractResultFromMessage(message.content);
      const usage = extractUsage(message.usage);
      accumulateUsage(totalUsage, usage);

      yield {
        type: "result",
        branchPath: meta?.branchPath ?? result.custom_id,
        policyName: meta?.policyName,
        result: parsed,
        usage,
      };
    }
  }

  yield {
    type: "complete",
    totalUsage,
    message: `All batches complete. Total: ${totalUsage.inputTokens} input, ${totalUsage.outputTokens} output tokens`,
  };
}
