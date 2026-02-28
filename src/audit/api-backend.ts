// ============================================================================
// API backend: Anthropic SDK for single-request and batch audit
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";
import type { AuditResult, AuditConfig, TokenUsage } from "../types";
import { log } from "../logging";
import { resolveModelId } from "../pricing";
import { buildSystemPromptBlocks, buildUserPrompt } from "./prompts";
import { AUDIT_JSON_SCHEMA } from "./schema";

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
  const result = JSON.parse(
    textBlock?.type === "text" ? textBlock.text : '{"issues":[]}',
  ) as AuditResult;

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
    const parsed = JSON.parse(
      textBlock?.type === "text" ? textBlock.text : '{"issues":[]}',
    ) as AuditResult;

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
