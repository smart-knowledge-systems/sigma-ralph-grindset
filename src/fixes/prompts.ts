// ============================================================================
// Fix prompt builder
// ============================================================================

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AuditConfig } from "../types";
import { log } from "../logging";

/** Build the system prompt for fix mode (scoped to relevant policies). */
export function buildFixSystemPrompt(
  config: AuditConfig,
  policyNames: string[],
): string {
  let prompt = `You are refactoring React/Next.js components for readability and maintainability.
These components were built ad hoc, and need to be organized so a new team member
can quickly get up to speed.

RULES:
- Keep functionality identical — this is a readability refactor only
- Lean toward readability over cleverness
- Follow the coding guidelines below
- After making changes, use /check-and-fix to verify lint and type checks pass
`;

  for (const policyName of policyNames) {
    const policyFile = resolve(config.policiesDir, policyName, "POLICY.md");
    if (!existsSync(policyFile)) continue;
    try {
      const content = readFileSync(policyFile, "utf-8");
      if (content.trim()) {
        prompt += `\n--- ${policyName} ---\n\n${content}\n`;
      }
    } catch (e) {
      log.warn(`Policy file not readable: ${policyName} — ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  return prompt;
}

/** Build the user prompt for a fix batch. */
export function buildFixPrompt(
  batchFiles: string[],
  issues: Array<{
    id: number;
    description: string;
    rule: string;
    severity: string;
    suggestion: string;
    file_paths: string;
    line_ranges: string;
  }>,
): string {
  let prompt =
    "I need you to fix the following code quality issues in these files:\n\n";
  prompt += "## Affected Files\n\n";

  for (const fp of batchFiles) {
    prompt += `- \`${fp}\`\n`;
  }

  prompt += "\n## Issues to Address\n\n";

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]!;
    const paths = issue.file_paths.split("|");
    const lineRanges = (issue.line_ranges ?? "").split("|");

    let fileList = "";
    for (let j = 0; j < paths.length; j++) {
      const lr = lineRanges[j] ?? "";
      fileList += lr
        ? `- \`${paths[j]}\` (lines ${lr})\n`
        : `- \`${paths[j]}\`\n`;
    }

    prompt += `### Issue ${i + 1} (${issue.severity}) — rule: ${issue.rule}\n`;
    prompt += `**Files:**\n${fileList}`;
    prompt += `**Problem:** ${issue.description}\n`;
    prompt += `**Suggestion:** ${issue.suggestion}\n\n`;
  }

  prompt += "## Instructions\n\n";
  prompt += "1. Read each affected file\n";
  prompt += "2. Fix the issues listed above\n";
  prompt +=
    "3. Keep all existing functionality — this is a readability/maintainability refactor\n";
  prompt += "4. Organize code so a new team member can quickly understand it\n";
  prompt += "5. After all edits use /check-and-fix, then run `bun format`\n";

  return prompt;
}
