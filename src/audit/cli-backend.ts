// ============================================================================
// CLI backend: spawns `claude -p` for audit
// ============================================================================

import type { AuditResult, AuditIssue, AuditConfig } from "../types";
import { log } from "../logging";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";
import { AUDIT_JSON_SCHEMA, AUDIT_SCHEMA_NAME } from "./schema";

/**
 * Try to extract a JSON object with an `issues` array from a string.
 * Handles raw JSON and JSON embedded in markdown code fences.
 */
function extractIssuesFromString(text: string): AuditResult | null {
  // Try direct parse first
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && "issues" in obj) {
      return obj as AuditResult;
    }
  } catch {
    // not valid JSON — try extracting embedded JSON below
  }

  // Look for JSON in markdown code fences or bare {...}
  const patterns = [
    /```(?:json)?\s*\n(\{[\s\S]*?"issues"\s*:\s*\[[\s\S]*?\})\s*\n```/,
    /(\{\s*"issues"\s*:\s*\[[\s\S]*\})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj && typeof obj === "object" && "issues" in obj) {
          return obj as AuditResult;
        }
      } catch {
        // keep trying
      }
    }
  }
  return null;
}

/** Parse Claude CLI JSON output using multiple strategies. */
export function parseCliOutput(raw: string): AuditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ParseError("Invalid JSON", raw);
  }

  // Strategy 1: CLI envelope with structured_output
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.structured_output && typeof obj.structured_output === "object") {
      const so = obj.structured_output as Record<string, unknown>;
      if ("issues" in so) return so as unknown as AuditResult;
    }
    // Strategy 2: direct object with .issues
    if ("issues" in obj) return obj as unknown as AuditResult;

    // Strategy 3: CLI envelope where .result is an object with .issues
    if (
      obj.result &&
      typeof obj.result === "object" &&
      !Array.isArray(obj.result)
    ) {
      const res = obj.result as Record<string, unknown>;
      if ("issues" in res) return res as unknown as AuditResult;
    }

    // Strategy 4: CLI envelope where .result is a string containing JSON
    if (typeof obj.result === "string") {
      const extracted = extractIssuesFromString(obj.result);
      if (extracted) return extracted;
    }
  }

  if (Array.isArray(parsed)) {
    const last = parsed[parsed.length - 1];

    // Strategy 5: last element has .structured_output
    if (last?.structured_output?.issues) {
      return last.structured_output as AuditResult;
    }

    // Strategy 6: last element has .result (object)
    if (last?.result && typeof last.result === "object" && last.result.issues) {
      return last.result as AuditResult;
    }

    // Strategy 7: last element has .result (string with embedded JSON)
    if (typeof last?.result === "string") {
      const extracted = extractIssuesFromString(last.result);
      if (extracted) return extracted;
    }

    // Strategy 8: last element IS the result
    if (last?.issues) {
      return last as AuditResult;
    }

    // Strategy 9: find first object with .issues
    for (const item of parsed) {
      if (item?.issues) {
        return item as AuditResult;
      }
    }
  }

  // Strategy 10: parse narrative markdown into structured issues
  const narrativeText =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? String((parsed as Record<string, unknown>).result ?? "")
      : typeof raw === "string"
        ? raw
        : "";
  if (narrativeText) {
    const issues = parseNarrativeIssues(narrativeText);
    if (issues.length > 0) {
      log.debug(
        `Extracted ${issues.length} issues from narrative markdown fallback`,
      );
      return { issues };
    }
  }

  throw new ParseError("Cannot extract issues from CLI output", raw);
}

/** Validate that parsed issues have required fields and correct types. */
function validateIssues(result: AuditResult): AuditResult {
  const validSeverities = new Set(["high", "medium", "low"]);
  const validated = result.issues.filter((issue) => {
    if (typeof issue.description !== "string" || !issue.description)
      return false;
    if (typeof issue.rule !== "string") return false;
    if (!validSeverities.has(issue.severity)) {
      issue.severity = "medium";
    }
    if (!Array.isArray(issue.files) || issue.files.length === 0) return false;
    if (typeof issue.suggestion !== "string") issue.suggestion = "";
    if (typeof issue.policy !== "string") issue.policy = "";
    return true;
  });
  return { issues: validated };
}

/**
 * Parse narrative markdown audit output into structured issues.
 * Handles the format the model produces when --json-schema is ignored:
 *
 *   ### Issue N: <description>
 *   **Rule**: <rule>
 *   **Severity**: <severity>
 *   **Policy**: <policy>
 *   **Files**: <file list>
 *   ... suggestion text ...
 */
export function parseNarrativeIssues(text: string): AuditIssue[] {
  // Split on issue headings (### Issue N: or ## Issue N: or **Issue N:**)
  const issueSections = text.split(
    /(?=###?\s+Issue\s+\d+[:\s]|\*\*Issue\s+\d+[:\s])/i,
  );

  const issues: AuditIssue[] = [];

  for (const section of issueSections) {
    // Must start with an issue heading
    if (!/^###?\s+Issue\s+\d+[:\s]|\*\*Issue\s+\d+[:\s]/i.test(section))
      continue;

    // Extract description from heading
    const headingMatch = section.match(/^###?\s+Issue\s+\d+:\s*(.+?)$/m);
    const description = headingMatch?.[1]?.replace(/\*+/g, "").trim() ?? "";

    // Extract fields using **Label**: Value pattern
    const ruleMatch = section.match(/\*\*Rule\*\*[:\s]+(.+?)$/m);
    const severityMatch = section.match(/\*\*Severity\*\*[:\s]+(.+?)$/m);
    const policyMatch = section.match(/\*\*Policy\*\*[:\s]+(.+?)$/m);
    const filesMatch = section.match(/\*\*Files?\*\*[:\s]+(.+?)$/m);

    const rule = ruleMatch?.[1]?.replace(/[`*]/g, "").trim() ?? "";
    const rawSeverity =
      severityMatch?.[1]?.replace(/[`*]/g, "").trim().toLowerCase() ?? "";
    const severity = (
      ["high", "medium", "low"].includes(rawSeverity) ? rawSeverity : "medium"
    ) as AuditIssue["severity"];
    const policy = policyMatch?.[1]?.replace(/[`*]/g, "").trim() ?? "";

    // Parse files — could be comma-separated, backtick-wrapped
    const rawFiles = filesMatch?.[1]?.trim() ?? "";
    const files = rawFiles
      .split(/[,;]\s*/)
      .map((f) => f.replace(/[`*]/g, "").trim())
      .filter(Boolean);

    // Extract suggestion — text between the fields block and the next heading/divider
    const suggestionMatch = section.match(
      /\*\*(?:Fix|Suggestion)\*\*[:\s]+([\s\S]*?)(?=\n---|\n###|\n\*\*Issue|\Z)/i,
    );
    let suggestion = suggestionMatch?.[1]?.trim() ?? "";
    if (!suggestion) {
      // Fallback: grab text after all the **Field** lines
      const lines = section.split("\n");
      const afterFields: string[] = [];
      let pastFields = false;
      for (const line of lines) {
        if (pastFields) {
          afterFields.push(line);
        } else if (
          !/^\*\*(Rule|Severity|Policy|Files?)\*\*/i.test(line) &&
          !/^###?\s+Issue/i.test(line) &&
          line.trim()
        ) {
          pastFields = true;
          afterFields.push(line);
        }
      }
      suggestion = afterFields.join("\n").trim();
    }

    if (description && files.length > 0) {
      issues.push({ description, rule, severity, suggestion, policy, files });
    }
  }

  return issues;
}

export class ParseError extends Error {
  constructor(
    message: string,
    public rawOutput: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Run an audit via the Claude CLI for a single branch.
 */
export async function auditViaCli(
  branchPath: string,
  files: string[],
  policyNames: string[],
  config: AuditConfig,
): Promise<{ result: AuditResult; errorType?: string }> {
  const systemPrompt = buildSystemPrompt(config, policyNames);
  const userPrompt = buildUserPrompt(branchPath, files, config);

  const schemaStr = JSON.stringify({
    name: AUDIT_SCHEMA_NAME,
    ...AUDIT_JSON_SCHEMA,
  });

  const args = [
    "claude",
    "--print",
    "--no-session-persistence",
    "--model",
    config.auditModel,
    "--output-format",
    "json",
    "--max-turns",
    "100",
    "--json-schema",
    schemaStr,
    "--append-system-prompt",
    systemPrompt,
  ];

  log.debug(`Spawning: claude --print --model ${config.auditModel}`);

  const startTime = performance.now();
  const proc = Bun.spawn(args, {
    stdin: new Response(userPrompt),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: "" },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const durationMs = Math.round(performance.now() - startTime);

  if (exitCode !== 0) {
    const errorType = `cli_exit_${exitCode}`;
    log.error(
      `Claude CLI failed (exit ${exitCode}, ${durationMs}ms): ${stderr.slice(0, 200)}`,
    );
    throw Object.assign(new Error(`Claude CLI exit code ${exitCode}`), {
      errorType,
      stderr: stderr.slice(0, 500),
    });
  }

  log.debug(`Claude CLI completed in ${durationMs}ms`);

  try {
    const result = validateIssues(parseCliOutput(stdout));
    return { result };
  } catch (e) {
    const errorType = "json_parse_error";
    log.debug(`Raw output type: ${typeof stdout}`);
    log.debug(`Raw output (first 2000 chars): ${stdout.slice(0, 2000)}`);
    throw Object.assign(e as Error, { errorType });
  }
}
