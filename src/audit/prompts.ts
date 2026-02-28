// ============================================================================
// System + user prompt builders for audit
// ============================================================================

import { readFileSync, existsSync } from "fs";
import { resolve, relative } from "path";
import type { AuditConfig } from "../types";
import { log } from "../logging";
import { extToLang, extractImports } from "../branches/scanner";

/** Build the system prompt with audit instructions and policy text. */
export function buildSystemPrompt(
  config: AuditConfig,
  policyNames: string[],
): string {
  let prompt = `You are a code quality auditor specializing in React and TypeScript best practices.

## Your Task
Review the provided code and identify violations of the guidelines below. For each issue found:

1. Provide a clear description of the problem
2. Reference the specific rule name from the guidelines
3. Assign severity: high (performance/correctness issues), medium (maintainability concerns), low (style/minor improvements)
4. Suggest a concrete fix
5. List all affected files
6. Tag with the specific policy name that was violated (from the guideline sections below)

## Severity Mapping
- **high**: Performance problems, bugs, incorrect patterns that could break functionality
- **medium**: Maintainability issues, code smells, suboptimal patterns
- **low**: Style improvements, minor optimizations, cosmetic issues

## Output Constraints
- Focus on actionable issues that can be fixed
- Don't report issues for intentional design decisions (e.g., acceptable use of any for external data before Zod validation)
- Prioritize issues that improve readability and maintainability
- Each issue must include at least one file path
- For the policy field, use the exact policy name from the section headers below (e.g., "vercel-react-best-practices", "logging-strategy")

`;

  let loaded = 0;
  for (const policyName of policyNames) {
    const policyFile = resolve(config.policiesDir, policyName, "POLICY.md");
    if (!existsSync(policyFile)) {
      log.warn(`Policy file not found: ${policyFile}, skipping`);
      continue;
    }
    try {
      const content = readFileSync(policyFile, "utf-8");
      if (!content.trim()) {
        log.warn(`Policy file is empty: ${policyFile}, skipping`);
        continue;
      }
      prompt += `\n## Guidelines: ${policyName}\n\n${content}\n`;
      loaded++;
    } catch {
      log.warn(`Policy file not readable: ${policyFile}, skipping`);
    }
  }

  if (loaded === 0) {
    throw new Error("No valid policy files loaded");
  }

  return prompt;
}

/**
 * Build the system prompt as content blocks for API mode with prompt caching.
 * Returns array of content blocks where the policy text has cache_control.
 */
export function buildSystemPromptBlocks(
  config: AuditConfig,
  policyNames: string[],
): Array<{
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}> {
  const instructions = `You are a code quality auditor specializing in React and TypeScript best practices.

## Your Task
Review the provided code and identify violations of the guidelines below. For each issue found:

1. Provide a clear description of the problem
2. Reference the specific rule name from the guidelines
3. Assign severity: high (performance/correctness issues), medium (maintainability concerns), low (style/minor improvements)
4. Suggest a concrete fix
5. List all affected files
6. Tag with the specific policy name that was violated (from the guideline sections below)

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

  let policyText = "";
  for (const policyName of policyNames) {
    const policyFile = resolve(config.policiesDir, policyName, "POLICY.md");
    if (!existsSync(policyFile)) continue;
    try {
      const content = readFileSync(policyFile, "utf-8");
      if (content.trim()) {
        policyText += `\n## Guidelines: ${policyName}\n\n${content}\n`;
      }
    } catch {
      // skip
    }
  }

  return [
    { type: "text", text: instructions },
    { type: "text", text: policyText, cache_control: { type: "ephemeral" } },
  ];
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
