// ============================================================================
// CLI backend: spawns `claude -p` for audit
// ============================================================================

import type { AuditResult, AuditIssue, AuditConfig } from "../types";
import { log } from "../logging";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";
import {
  AUDIT_JSON_SCHEMA,
  AUDIT_SCHEMA_NAME,
  validateAuditResult,
} from "./schema";

// ============================================================================
// Module-level regex patterns (hoisted to avoid re-creation per call)
// ============================================================================

/** Matches JSON in a markdown code fence containing an "issues" array. */
const JSON_CODE_FENCE_RE =
  /```(?:json)?\s*\n(\{[\s\S]*?"issues"\s*:\s*\[[\s\S]*?\})\s*\n```/;

/** Matches bare JSON containing an "issues" array. */
const JSON_BARE_RE = /(\{\s*"issues"\s*:\s*\[[\s\S]*\})/;

/** Matches bare JSON containing "findings" or "violations" arrays (alternatives to "issues"). */
const JSON_ALT_RE = /(\{\s*"(?:findings|violations)"\s*:\s*\[[\s\S]*\})/;

/** Splits text on issue headings (### Issue N: or **Issue N:). */
const ISSUE_HEADING_SPLIT_RE =
  /(?=###?\s+Issue\s+\d+[:\s]|\*\*Issue\s+\d+[:\s])/i;

/** Tests whether a section starts with an issue heading. */
const ISSUE_HEADING_TEST_RE = /^###?\s+Issue\s+\d+[:\s]|\*\*Issue\s+\d+[:\s]/i;

/** Extracts the description from an issue heading line. */
const HEADING_DESCRIPTION_RE = /^###?\s+Issue\s+\d+:\s*(.+?)$/m;

/** Extracts field values from **Label**: Value patterns. */
const FIELD_RULE_RE = /\*\*Rule\*\*[:\s]+(.+?)$/m;
const FIELD_SEVERITY_RE = /\*\*Severity\*\*[:\s]+(.+?)$/m;
const FIELD_POLICY_RE = /\*\*Policy\*\*[:\s]+(.+?)$/m;
const FIELD_FILES_RE = /\*\*Files?\*\*[:\s]+(.+?)$/m;

/** Extracts suggestion text from **Fix** or **Suggestion** blocks. */
const SUGGESTION_RE =
  /\*\*(?:Fix|Suggestion)\*\*[:\s]+([\s\S]*?)(?=\n---|\n###|\n\*\*Issue|\Z)/i;

/** Tests whether a line is a known field label. */
const KNOWN_FIELD_RE = /^\*\*(Rule|Severity|Policy|Files?)\*\*/i;
const ISSUE_LINE_RE = /^###?\s+Issue/i;

/** Pattern for sanitizing potential secrets from stderr output. */
const SECRET_PATTERN_RE =
  /sk-ant-[a-zA-Z0-9_-]+|sk-[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._-]+/g;

// ============================================================================
// Parsing errors
// ============================================================================

export class ParseError extends Error {
  constructor(
    message: string,
    public rawOutput: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

// ============================================================================
// JSON extraction helpers
// ============================================================================

/**
 * Normalize objects that use alternative key names for the issues array.
 * Claude sometimes responds with "findings" or "violations" instead of "issues".
 */
function normalizeIssueKeys(obj: Record<string, unknown>): boolean {
  if ("issues" in obj) return true;
  for (const alt of ["findings", "violations"] as const) {
    if (alt in obj && Array.isArray(obj[alt])) {
      obj.issues = obj[alt];
      delete obj[alt];
      return true;
    }
  }
  return false;
}

/**
 * Try to extract a JSON object with an `issues` array from a string.
 * Handles raw JSON and JSON embedded in markdown code fences.
 * Also recognizes alternative key names like "findings" and "violations".
 */
function extractIssuesFromString(text: string): AuditResult | null {
  // Try direct parse first
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && normalizeIssueKeys(obj)) {
      return validateAuditResult(obj);
    }
  } catch {
    // not valid JSON — try extracting embedded JSON below
  }

  // Look for JSON in markdown code fences or bare {...}
  for (const re of [JSON_CODE_FENCE_RE, JSON_BARE_RE, JSON_ALT_RE]) {
    const m = text.match(re);
    if (m?.[1]) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj && typeof obj === "object" && normalizeIssueKeys(obj)) {
          return validateAuditResult(obj);
        }
      } catch {
        // keep trying
      }
    }
  }
  return null;
}

// ============================================================================
// Parsing strategies for CLI output
//
// The Claude CLI can return structured output in several formats depending on
// the flags used and whether the model followed the schema. Each strategy
// handles a specific format, and they are tried in order until one succeeds.
// ============================================================================

/** Strategy: CLI envelope with structured_output field. */
function parseStructuredOutput(
  obj: Record<string, unknown>,
): AuditResult | null {
  if (obj.structured_output && typeof obj.structured_output === "object") {
    const so = obj.structured_output as Record<string, unknown>;
    if ("issues" in so) return validateAuditResult(so);
  }
  return null;
}

/** Strategy: direct object with .issues array. */
function parseDirectIssues(obj: Record<string, unknown>): AuditResult | null {
  if ("issues" in obj) return validateAuditResult(obj);
  return null;
}

/** Strategy: CLI envelope where .result is an object with .issues. */
function parseResultObject(obj: Record<string, unknown>): AuditResult | null {
  if (
    obj.result &&
    typeof obj.result === "object" &&
    !Array.isArray(obj.result)
  ) {
    const res = obj.result as Record<string, unknown>;
    if ("issues" in res) return validateAuditResult(res);
  }
  return null;
}

/** Strategy: CLI envelope where .result is a string containing embedded JSON. */
function parseResultString(obj: Record<string, unknown>): AuditResult | null {
  if (typeof obj.result === "string") {
    return extractIssuesFromString(obj.result);
  }
  return null;
}

/** Strategy: parse an array response — check various element shapes. */
function parseArrayResponse(items: unknown[]): AuditResult | null {
  const last = items[items.length - 1] as Record<string, unknown> | undefined;
  if (!last) return null;

  // Last element has .structured_output.issues
  if (
    last.structured_output &&
    typeof last.structured_output === "object" &&
    (last.structured_output as Record<string, unknown>).issues
  ) {
    return validateAuditResult(last.structured_output);
  }

  // Last element has .result as object with issues
  if (
    last.result &&
    typeof last.result === "object" &&
    !Array.isArray(last.result)
  ) {
    const res = last.result as Record<string, unknown>;
    if (res.issues) return validateAuditResult(res);
  }

  // Last element has .result as string with embedded JSON
  if (typeof last.result === "string") {
    const extracted = extractIssuesFromString(last.result);
    if (extracted) return extracted;
  }

  // Last element IS the result
  if (last.issues) return validateAuditResult(last);

  // Search all elements for one with .issues
  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).issues
    ) {
      return validateAuditResult(item);
    }
  }

  return null;
}

/** Strategy: parse narrative markdown into structured issues (last resort). */
function parseNarrativeFallback(
  parsed: unknown,
  raw: string,
): AuditResult | null {
  const narrativeText =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? String((parsed as Record<string, unknown>).result ?? "")
      : typeof raw === "string"
        ? raw
        : "";

  if (!narrativeText) return null;

  const issues = parseNarrativeIssues(narrativeText);
  if (issues.length > 0) {
    log.debug(
      `Extracted ${issues.length} issues from narrative markdown fallback`,
    );
    return { issues };
  }
  return null;
}

// ============================================================================
// Main CLI output parser
// ============================================================================

/**
 * Parse Claude CLI JSON output using multiple strategies.
 *
 * Strategies are tried in order:
 * 1. Object with structured_output field
 * 2. Object with direct .issues array
 * 3. Object where .result is an object with .issues
 * 4. Object where .result is a string with embedded JSON
 * 5-9. Array responses (various element shapes)
 * 10. Narrative markdown fallback
 */
export function parseCliOutput(raw: string): AuditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ParseError("Invalid JSON", raw);
  }

  // Try object-based strategies
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const strategies = [
      parseStructuredOutput,
      parseDirectIssues,
      parseResultObject,
      parseResultString,
    ];
    for (const strategy of strategies) {
      const result = strategy(obj);
      if (result) return result;
    }
  }

  // Try array-based strategies
  if (Array.isArray(parsed)) {
    const result = parseArrayResponse(parsed);
    if (result) return result;
  }

  // Last resort: narrative markdown
  const narrative = parseNarrativeFallback(parsed, raw);
  if (narrative) return narrative;

  // If the CLI envelope indicates a successful, non-error result but no issues
  // were extractable, the model found no violations. Return empty issues rather
  // than failing — this happens when --json-schema is ignored and the model
  // responds with pure narrative like "No violations detected".
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).type === "result" &&
    (parsed as Record<string, unknown>).is_error === false &&
    typeof (parsed as Record<string, unknown>).result === "string"
  ) {
    const resultStr = (parsed as Record<string, unknown>).result as string;
    log.debug(
      "Successful CLI result with no extractable issues — treating as clean",
    );
    log.trace(
      `Unextractable result string (${resultStr.length} chars):\n${resultStr}`,
    );
    return { issues: [] };
  }

  throw new ParseError("Cannot extract issues from CLI output", raw);
}

// ============================================================================
// Narrative markdown parser
// ============================================================================

/** Extract a single field from a narrative section using a regex pattern. */
function extractField(section: string, pattern: RegExp): string {
  return pattern.exec(section)?.[1]?.replace(/[`*]/g, "").trim() ?? "";
}

/** Extract the suggestion text from a narrative section. */
function extractSuggestion(section: string): string {
  const match = SUGGESTION_RE.exec(section);
  if (match?.[1]?.trim()) return match[1].trim();

  // Fallback: grab text after all the **Field** lines
  const lines = section.split("\n");
  const afterFields: string[] = [];
  let pastFields = false;
  for (const line of lines) {
    if (pastFields) {
      afterFields.push(line);
    } else if (
      !KNOWN_FIELD_RE.test(line) &&
      !ISSUE_LINE_RE.test(line) &&
      line.trim()
    ) {
      pastFields = true;
      afterFields.push(line);
    }
  }
  return afterFields.join("\n").trim();
}

/** Parse comma/semicolon-separated file list from markdown. */
function parseFileList(rawFiles: string): string[] {
  return rawFiles
    .split(/[,;]\s*/)
    .map((f) => f.replace(/[`*]/g, "").trim())
    .filter(Boolean);
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
  const issueSections = text.split(ISSUE_HEADING_SPLIT_RE);
  const issues: AuditIssue[] = [];

  for (const section of issueSections) {
    if (!ISSUE_HEADING_TEST_RE.test(section)) continue;

    const description =
      HEADING_DESCRIPTION_RE.exec(section)?.[1]?.replace(/\*+/g, "").trim() ??
      "";
    const rule = extractField(section, FIELD_RULE_RE);
    const rawSeverity = extractField(section, FIELD_SEVERITY_RE).toLowerCase();
    const severity = (
      ["high", "medium", "low"].includes(rawSeverity) ? rawSeverity : "medium"
    ) as AuditIssue["severity"];
    const policy = extractField(section, FIELD_POLICY_RE);
    const files = parseFileList(extractField(section, FIELD_FILES_RE));
    const suggestion = extractSuggestion(section);

    if (description && files.length > 0) {
      issues.push({ description, rule, severity, suggestion, policy, files });
    }
  }

  return issues;
}

// ============================================================================
// Stderr sanitization
// ============================================================================

/** Redact potential API keys and tokens from stderr before logging. */
function sanitizeStderr(stderr: string, maxLen: number): string {
  return stderr.slice(0, maxLen).replace(SECRET_PATTERN_RE, "[REDACTED]");
}

// ============================================================================
// CLI audit runner
// ============================================================================

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
      `Claude CLI failed (exit ${exitCode}, ${durationMs}ms): ${sanitizeStderr(stderr, 200)}`,
    );
    throw Object.assign(new Error(`Claude CLI exit code ${exitCode}`), {
      errorType,
      stderr: sanitizeStderr(stderr, 500),
    });
  }

  log.debug(`Claude CLI completed in ${durationMs}ms`);
  log.trace(`Claude CLI raw stdout:\n${stdout}`);

  try {
    const result = parseCliOutput(stdout);
    return { result };
  } catch (e) {
    const errorType = "json_parse_error";
    log.debug(`Raw output type: ${typeof stdout}`);
    log.debug(`Raw output (first 2000 chars): ${stdout.slice(0, 2000)}`);
    throw Object.assign(e as Error, { errorType });
  }
}
