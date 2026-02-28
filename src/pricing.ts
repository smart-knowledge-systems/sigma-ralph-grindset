// ============================================================================
// Model-aware pricing estimation for audit runs
// ============================================================================

import type { ModelPricing, CostEstimate } from "./types";

/** Pricing table: $ per million tokens */
const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
    batchInput: 0.5,
    batchOutput: 2.5,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
    batchInput: 1.5,
    batchOutput: 7.5,
  },
  "claude-opus-4-6": {
    input: 5.0,
    output: 25.0,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    batchInput: 2.5,
    batchOutput: 12.5,
  },
};

/** Model alias resolution map */
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
};

/** Resolve a model alias to its full ID. */
export function resolveModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

/** Get pricing for a model. Falls back to haiku if unknown. */
export function getModelPricing(model: string): ModelPricing {
  const resolved = resolveModelId(model);
  return PRICING[resolved] ?? PRICING["claude-haiku-4-5"]!;
}

/** Rough token estimate: ~1 token per 3.5 characters. */
export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 3.5);
}

/**
 * Compute a cost estimate for an audit run.
 *
 * @param model - Model name or alias
 * @param branchCount - Number of branches to audit
 * @param systemPromptTokens - Estimated tokens in system prompt (shared across branches)
 * @param perBranchInputTokens - Average input tokens per branch (code content)
 * @param perBranchOutputTokens - Average output tokens per branch
 */
export function estimateCost(
  model: string,
  branchCount: number,
  systemPromptTokens: number,
  perBranchInputTokens: number,
  perBranchOutputTokens: number,
): CostEstimate {
  const pricing = getModelPricing(model);
  const n = branchCount;

  const totalInputTokens = systemPromptTokens * n + perBranchInputTokens * n;
  const totalOutputTokens = perBranchOutputTokens * n;

  // Cost WITHOUT caching: all input at standard rate
  const noCacheCost =
    (totalInputTokens * pricing.input) / 1_000_000 +
    (totalOutputTokens * pricing.output) / 1_000_000;

  // Cost WITH caching: system prompt cached across branches
  const cacheWriteCost = (systemPromptTokens * pricing.cacheWrite) / 1_000_000;
  const cacheReadCost =
    (systemPromptTokens * (n - 1) * pricing.cacheRead) / 1_000_000;
  const perBranchCost = (perBranchInputTokens * n * pricing.input) / 1_000_000;
  const outputCost = (totalOutputTokens * pricing.output) / 1_000_000;
  const cacheCost = cacheWriteCost + cacheReadCost + perBranchCost + outputCost;

  const cachingEnabled = n >= 2 && cacheCost < noCacheCost;
  const standardApiCost = cachingEnabled ? cacheCost : noCacheCost;
  const cachingSavings = cachingEnabled ? noCacheCost - cacheCost : 0;

  // Batch API: 50% off input/output tokens
  const batchOutputCost = (totalOutputTokens * pricing.batchOutput) / 1_000_000;

  // Batch WITHOUT caching: all input at batch rate
  const batchNoCacheCost =
    (totalInputTokens * pricing.batchInput) / 1_000_000 + batchOutputCost;

  // Batch WITH caching: cache write + conservative 50% cache hits
  const batchWithCacheCost =
    (systemPromptTokens * pricing.cacheWrite) / 1_000_000 +
    (systemPromptTokens * (n - 1) * 0.5 * pricing.cacheRead) / 1_000_000 +
    (systemPromptTokens * (n - 1) * 0.5 * pricing.batchInput) / 1_000_000 +
    (perBranchInputTokens * n * pricing.batchInput) / 1_000_000 +
    batchOutputCost;

  const batchCachingEnabled = n >= 2 && batchWithCacheCost < batchNoCacheCost;
  const batchApiCost = batchCachingEnabled
    ? batchWithCacheCost
    : batchNoCacheCost;

  return {
    model: resolveModelId(model),
    branchCount: n,
    totalInputTokens,
    totalOutputTokens,
    noCacheCost,
    cachingEnabled,
    cachingSavings,
    standardApiCost,
    batchApiCost,
    batchNoCacheCost,
    batchWithCacheCost,
    batchCachingEnabled,
  };
}

/**
 * Compute actual cost from real token usage (batch API rates).
 * Uses cache write rate for cache_creation tokens and cache read rate for cache_read tokens.
 */
export function computeActualCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
  batch: boolean,
): number {
  const pricing = getModelPricing(model);
  const inputRate = batch ? pricing.batchInput : pricing.input;
  const outputRate = batch ? pricing.batchOutput : pricing.output;

  // Non-cached input tokens = total input - cache creation - cache read
  const plainInput = Math.max(
    0,
    usage.inputTokens -
      usage.cacheCreationInputTokens -
      usage.cacheReadInputTokens,
  );

  return (
    (plainInput * inputRate) / 1_000_000 +
    (usage.cacheCreationInputTokens * pricing.cacheWrite) / 1_000_000 +
    (usage.cacheReadInputTokens * pricing.cacheRead) / 1_000_000 +
    (usage.outputTokens * outputRate) / 1_000_000
  );
}

/** Format token usage and actual cost for display. */
export function formatActualCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
  batch: boolean,
  estimate?: number,
): string {
  const lines: string[] = [];
  const actual = computeActualCost(model, usage, batch);
  const fmt = (n: number) => `$${n.toFixed(4)}`;
  const k = (n: number) => `${Math.round(n / 1000)}K`;

  lines.push(`Actual cost (${resolveModelId(model)}):`);
  lines.push(
    `  Input tokens:        ${k(usage.inputTokens)} (${k(usage.inputTokens - usage.cacheCreationInputTokens - usage.cacheReadInputTokens)} plain, ${k(usage.cacheCreationInputTokens)} cache write, ${k(usage.cacheReadInputTokens)} cache read)`,
  );
  lines.push(`  Output tokens:       ${k(usage.outputTokens)}`);
  lines.push(`  Actual cost:         ${fmt(actual)}`);

  if (estimate !== undefined) {
    const error = actual - estimate;
    const pct = estimate > 0 ? ((error / estimate) * 100).toFixed(1) : "N/A";
    lines.push(`  Estimated cost:      ${fmt(estimate)}`);
    lines.push(
      `  Prediction error:    ${error >= 0 ? "+" : ""}${fmt(error)} (${pct}%)`,
    );
  }

  return lines.join("\n");
}

/** Format a cost estimate for display. */
export function formatEstimate(est: CostEstimate): string {
  const lines: string[] = [];
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  lines.push(`Audit estimate (${est.model}):`);
  lines.push(`  Branches: ${est.branchCount}`);
  lines.push(
    `  Input: ~${Math.round(est.totalInputTokens / 1000)}K tokens, Output: ~${Math.round(est.totalOutputTokens / 1000)}K tokens`,
  );
  lines.push("");

  lines.push(
    `  Without Batch API:            ${fmt(est.noCacheCost)}  (reference)`,
  );
  if (est.cachingEnabled) {
    lines.push(
      `  Without Batch API (cached):   ${fmt(est.standardApiCost)}  (reference)`,
    );
  }
  lines.push(`  Batch API:                    ${fmt(est.batchNoCacheCost)}`);
  if (est.branchCount >= 2) {
    lines.push(
      `  Batch API + caching:          ${fmt(est.batchWithCacheCost)}`,
    );
  }

  lines.push("");
  if (est.batchCachingEnabled) {
    lines.push(`  Recommended: Batch API + caching (${fmt(est.batchApiCost)})`);
  } else {
    lines.push(`  Recommended: Batch API (${fmt(est.batchApiCost)})`);
  }

  lines.push("");
  lines.push("  Tip: To audit without an API key, use: bun audit --cli");
  lines.push("       (requires `claude` CLI installed, uses claude -p)");

  return lines.join("\n");
}
