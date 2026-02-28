// ============================================================================
// API backend: Anthropic SDK for single-request and batch audit
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";
import type { AuditResult, AuditConfig, TokenUsage } from "../types";
import { log } from "../logging";
import { resolveModelId } from "../pricing";
import {
  buildSystemPromptBlocks,
  buildSystemPromptBlocksForBranch,
  buildUserPrompt,
  buildUserPromptForPolicy,
} from "./prompts";
import { AUDIT_JSON_SCHEMA } from "./schema";

/**
 * Validate parsed JSON against the AuditResult schema at runtime.
 * Returns a valid AuditResult with only well-formed issues, or
 * a fallback with empty issues if the top-level structure is wrong.
 */
function validateAuditResult(parsed: unknown): AuditResult {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("issues" in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).issues)
  ) {
    log.warn("Parsed audit result missing 'issues' array, returning empty");
    return { issues: [] };
  }

  const raw = parsed as { issues: unknown[] };
  const validSeverities = new Set(["high", "medium", "low"]);
  const issues = raw.issues.filter(
    (item): item is AuditResult["issues"][number] => {
      if (typeof item !== "object" || item === null) return false;
      const o = item as Record<string, unknown>;
      return (
        typeof o.description === "string" &&
        typeof o.rule === "string" &&
        typeof o.severity === "string" &&
        validSeverities.has(o.severity) &&
        typeof o.suggestion === "string" &&
        typeof o.policy === "string" &&
        Array.isArray(o.files) &&
        o.files.length >= 1 &&
        o.files.every((f: unknown) => typeof f === "string")
      );
    },
  );

  if (issues.length < raw.issues.length) {
    log.warn(
      `Filtered ${raw.issues.length - issues.length} invalid issues from audit result`,
    );
  }

  return { issues };
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Single-request audit via the Anthropic API with structured output.
 */
export async function auditViaApi(
  branchPath: string,
  files: string[],
  policyNames: string[],
  config: AuditConfig,
  useCaching: boolean,
): Promise<{ result: AuditResult; usage: TokenUsage }> {
  const c = getClient();
  const model = resolveModelId(config.auditModel);
  const userPrompt = buildUserPrompt(branchPath, files, config);

  const system = useCaching
    ? (buildSystemPromptBlocks(
        config,
        policyNames,
      ) as Anthropic.MessageCreateParams["system"])
    : buildSystemPromptBlocks(config, policyNames)
        .map((b) => b.text)
        .join("\n");

  log.debug(
    `API call: model=${model} branch=${branchPath} caching=${useCaching}`,
  );

  const response = await c.messages.create({
    model,
    max_tokens: 16384,
    system,
    messages: [{ role: "user", content: userPrompt }],
    output_config: {
      format: {
        type: "json_schema" as const,
        schema: AUDIT_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  log.debug(`API response: request_id=${response.id}`);

  // Extract structured output from text block (json_schema output_config)
  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(
    textBlock?.type === "text" ? textBlock.text : '{"issues":[]}',
  );
  const result = validateAuditResult(parsed);

  const rawUsage = response.usage as unknown as Record<string, number>;
  const usage: TokenUsage = {
    inputTokens: rawUsage.input_tokens ?? 0,
    outputTokens: rawUsage.output_tokens ?? 0,
    cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
  };

  return { result, usage };
}

/** Build a batch request for a single branch audit. */
function buildBatchRequest(
  branchPath: string,
  files: string[],
  policyNames: string[],
  config: AuditConfig,
  useCaching: boolean,
): Anthropic.Messages.BatchCreateParams.Request {
  const model = resolveModelId(config.auditModel);
  const userPrompt = buildUserPrompt(branchPath, files, config);

  const system = useCaching
    ? buildSystemPromptBlocks(config, policyNames)
    : buildSystemPromptBlocks(config, policyNames).map((b) => ({
        type: b.type,
        text: b.text,
      }));

  return {
    custom_id: `audit-${branchPath.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 57)}`,
    params: {
      model,
      max_tokens: 16384,
      system: system as Anthropic.MessageCreateParams["system"],
      messages: [{ role: "user", content: userPrompt }],
      output_config: {
        format: {
          type: "json_schema" as const,
          schema: AUDIT_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    },
  };
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
    );
    idToBranch.set(req.custom_id, b.path);
    return req;
  });

  log.info(`Submitting batch of ${requests.length} audit requests...`);

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
    // Extract structured output from text block (json_schema output_config)
    const textBlock = message.content.find((b) => b.type === "text");
    const rawParsed = JSON.parse(
      textBlock?.type === "text" ? textBlock.text : '{"issues":[]}',
    );
    const parsed = validateAuditResult(rawParsed);

    const msgUsage = message.usage as unknown as Record<string, number>;
    const usage: TokenUsage = {
      inputTokens: msgUsage.input_tokens ?? 0,
      outputTokens: msgUsage.output_tokens ?? 0,
      cacheCreationInputTokens: msgUsage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: msgUsage.cache_read_input_tokens ?? 0,
    };

    totalUsage.inputTokens += usage.inputTokens;
    totalUsage.outputTokens += usage.outputTokens;
    totalUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    totalUsage.cacheReadInputTokens += usage.cacheReadInputTokens;

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
// Per-branch batch backend: one batch per branch, one request per policy
// ============================================================================

/** Create a slug from a path, capped to a max length. */
function toSlug(value: string, maxLen: number): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen);
}

/**
 * Build a batch request for a single branch+policy combination
 * using the per-branch prompt structure (source code in system, policy in user).
 */
export function buildBatchRequestForBranch(
  branchPath: string,
  files: string[],
  policyName: string,
  config: AuditConfig,
): Anthropic.Messages.BatchCreateParams.Request {
  const model = resolveModelId(config.auditModel);
  const systemBlocks = buildSystemPromptBlocksForBranch(
    config,
    branchPath,
    files,
  );
  const userPrompt = buildUserPromptForPolicy(policyName, config);

  // custom_id format: a-{branchSlug}-{policySlug} (max 64 chars)
  const branchSlug = toSlug(branchPath, 28);
  const policySlug = toSlug(policyName, 28);
  const custom_id = `a-${branchSlug}-${policySlug}`.slice(0, 64);

  return {
    custom_id,
    params: {
      model,
      max_tokens: 16384,
      system: systemBlocks as Anthropic.MessageCreateParams["system"],
      messages: [{ role: "user", content: userPrompt }],
      output_config: {
        format: {
          type: "json_schema" as const,
          schema: AUDIT_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    },
  };
}

/** Extract token usage from an API message usage object. */
function extractUsage(rawUsage: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: (rawUsage.input_tokens as number) ?? 0,
    outputTokens: (rawUsage.output_tokens as number) ?? 0,
    cacheCreationInputTokens:
      (rawUsage.cache_creation_input_tokens as number) ?? 0,
    cacheReadInputTokens: (rawUsage.cache_read_input_tokens as number) ?? 0,
  };
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

  // Build and submit one batch per branch
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
      const textBlock = message.content.find((b) => b.type === "text");
      const rawParsed = JSON.parse(
        textBlock?.type === "text" ? textBlock.text : '{"issues":[]}',
      );
      const parsed = validateAuditResult(rawParsed);

      const usage = extractUsage(
        message.usage as unknown as Record<string, unknown>,
      );

      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;
      totalUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      totalUsage.cacheReadInputTokens += usage.cacheReadInputTokens;

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
