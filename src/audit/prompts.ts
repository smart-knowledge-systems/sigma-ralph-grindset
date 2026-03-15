// ============================================================================
// System + user prompt builders for audit
// ============================================================================

import { readFileSync, existsSync } from "fs";
import { resolve, relative } from "path";
import type { AuditConfig } from "../types";
import type { AddendumContext } from "./addendum";
import { loadMatchingAddendums } from "./addendum";
import { log } from "../logging";
import { extToLang, extractImports } from "../branches/scanner";

/**
 * Shared instruction text for all audit prompts.
 * Extracted as a const to avoid duplication between prompt builders (issue #97).
 */
export const AUDIT_INSTRUCTIONS = `You are a code quality auditor specializing in React and TypeScript best practices.

## Your Task
Review the provided code and identify violations of the guidelines below. For each issue found:

1. Provide a clear description of the problem
2. Reference the specific rule name from the guidelines
3. Assign severity: high (performance/correctness issues), medium (maintainability concerns), low (style/minor improvements)
4. Suggest a concrete fix
5. List all affected files
6. Tag with the specific policy name that was violated (from the guideline sections below)

## Required JSON Fields (use these exact names)
- "description": string — what the problem is
- "rule": string — the specific rule name violated
- "severity": "high" | "medium" | "low"
- "suggestion": string — how to fix it
- "policy": string — the policy name
- "files": string[] — affected file paths (at least one)

Do NOT use alternative field names like "affected_files", "rule_violations", "fix", "title", or "id".

## Severity Mapping
- **high**: Performance problems, bugs, incorrect patterns that could break functionality
- **medium**: Maintainability issues, code smells, suboptimal patterns
- **low**: Style improvements, minor optimizations, cosmetic issues

## Output Constraints
- Focus on actionable issues that can be fixed
- Don't report issues for intentional design decisions
- Prioritize issues that improve readability and maintainability
- Each issue must include at least one file path
- For the policy field, use the exact policy name from the section headers below`;

/** Module-level cache for file reads to avoid repeated I/O for the same path. */
const fileContentCache = new Map<string, string | null>();

/** Read a file with caching. Returns content or null if unavailable/empty. */
export function cachedReadFile(path: string): string | null {
  if (fileContentCache.has(path)) return fileContentCache.get(path)!;
  if (!existsSync(path)) {
    fileContentCache.set(path, null);
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    const result = content.trim() ? content : null;
    fileContentCache.set(path, result);
    return result;
  } catch {
    fileContentCache.set(path, null);
    return null;
  }
}

/** Load and return the text content of a single policy file, or null if unavailable.
 *  When an AddendumContext is provided, matching addendums are appended. */
function loadPolicyText(
  config: AuditConfig,
  policyName: string,
  ctx?: AddendumContext,
): string | null {
  const policyFile = resolve(config.policiesDir, policyName, "POLICY.md");
  const base = cachedReadFile(policyFile);
  if (base === null) return null;

  if (ctx) {
    const policyDir = resolve(config.policiesDir, policyName);
    const addendumText = loadMatchingAddendums(policyDir, ctx);
    if (addendumText) {
      return base + "\n\n" + addendumText;
    }
  }
  return base;
}

/**
 * Load and format all policies into a single text block.
 * Shared by buildSystemPrompt and buildSystemPromptBlocks.
 */
function loadFormattedPolicies(
  config: AuditConfig,
  policyNames: string[],
  ctx?: AddendumContext,
): { text: string; loaded: number } {
  let text = "";
  let loaded = 0;
  for (const policyName of policyNames) {
    const content = loadPolicyText(config, policyName, ctx);
    if (content === null) {
      log.warn(`Policy file not found or empty: ${policyName}, skipping`);
      continue;
    }
    text += `\n## Guidelines: ${policyName}\n\n${content}\n`;
    loaded++;
  }
  return { text, loaded };
}

/** Build the system prompt with audit instructions and policy text. */
export function buildSystemPrompt(
  config: AuditConfig,
  policyNames: string[],
  ctx?: AddendumContext,
): string {
  const { text: policyText, loaded } = loadFormattedPolicies(
    config,
    policyNames,
    ctx,
  );
  if (loaded === 0) {
    throw new Error("No valid policy files loaded");
  }
  return AUDIT_INSTRUCTIONS + "\n\n" + policyText;
}

/**
 * Build the system prompt as content blocks for API mode with prompt caching.
 * Returns array of content blocks where the policy text has cache_control.
 */
export function buildSystemPromptBlocks(
  config: AuditConfig,
  policyNames: string[],
  ctx?: AddendumContext,
): Array<{
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}> {
  const { text: policyText } = loadFormattedPolicies(config, policyNames, ctx);
  return [
    { type: "text", text: AUDIT_INSTRUCTIONS },
    { type: "text", text: policyText, cache_control: { type: "ephemeral" } },
  ];
}

/**
 * Build system prompt blocks for per-branch batching.
 * Block 1: shared audit instructions
 * Block 2: branch source code with cache_control (cached across policies for the same branch)
 */
export function buildSystemPromptBlocksForBranch(
  config: AuditConfig,
  branchPath: string,
  files: string[],
): Array<{
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}> {
  const lang = extToLang(config.fileExtensions);

  let sourceCode = `# Source Code: ${branchPath}\n\n`;
  sourceCode += `${files.length} files from \`${branchPath}\`:\n\n`;

  for (const file of files) {
    const relPath = relative(config.projectRoot, file);
    try {
      const content = readFileSync(file, "utf-8");
      sourceCode += `\`\`\`${lang}:${relPath}\n${content}\n\`\`\`\n\n`;
    } catch {
      sourceCode += `\`\`\`${lang}:${relPath}\n(unreadable)\n\`\`\`\n\n`;
    }
  }

  // Append dependencies
  const allImports = new Set<string>();
  for (const file of files) {
    for (const imp of extractImports(file)) {
      allImports.add(imp);
    }
  }
  if (allImports.size > 0) {
    sourceCode += `## Dependencies (imported)\n\n`;
    for (const imp of [...allImports].sort()) {
      sourceCode += `- \`${imp}\`\n`;
    }
  }

  return [
    { type: "text", text: AUDIT_INSTRUCTIONS },
    { type: "text", text: sourceCode, cache_control: { type: "ephemeral" } },
  ];
}

/**
 * Build the user prompt for a single policy in per-branch mode.
 * Loads the policy POLICY.md (with matching addendums) and appends review
 * instructions specifying the policy name for the output `policy` field.
 */
export function buildUserPromptForPolicy(
  policyName: string,
  config: AuditConfig,
  ctx?: AddendumContext,
): string {
  const content = loadPolicyText(config, policyName, ctx);
  if (!content) {
    throw new Error(`Policy file not found or empty: ${policyName}`);
  }

  let prompt = `## Guidelines: ${policyName}\n\n${content}\n\n`;
  prompt += `## Review Instructions\n\n`;
  prompt += `Review the source code provided in the system prompt against the "${policyName}" policy above.\n`;
  prompt += `For each violation found, set the \`policy\` field to exactly: "${policyName}"\n`;
  prompt += `Return your findings in the specified JSON schema format.\n`;

  return prompt;
}

/** Build the user prompt for a single branch audit. */
export function buildUserPrompt(
  branchPath: string,
  files: string[],
  config: AuditConfig,
): string {
  const lang = extToLang(config.fileExtensions);
  let prompt = `# Code Quality Review: ${branchPath}\n\n`;
  prompt += `Review the following ${files.length} files from the \`${branchPath}\` directory.\n\n`;

  // File contents
  prompt += `## File Contents\n\n`;
  for (const file of files) {
    const relPath = relative(config.projectRoot, file);
    try {
      const content = readFileSync(file, "utf-8");
      prompt += `\`\`\`${lang}:${relPath}\n${content}\n\`\`\`\n\n`;
    } catch {
      prompt += `\`\`\`${lang}:${relPath}\n(unreadable)\n\`\`\`\n\n`;
    }
  }

  // Dependencies
  prompt += `## Dependencies (imported)\n\n`;
  const allImports = new Set<string>();
  for (const file of files) {
    for (const imp of extractImports(file)) {
      allImports.add(imp);
    }
  }
  if (allImports.size > 0) {
    for (const imp of [...allImports].sort()) {
      prompt += `- \`${imp}\`\n`;
    }
  } else {
    prompt += `(none)\n`;
  }

  prompt += `\n## Instructions\n\n`;
  prompt += `Identify code quality issues following the guidelines provided in the system prompt. `;
  prompt += `Return your findings in the specified JSON schema format.\n`;

  return prompt;
}
