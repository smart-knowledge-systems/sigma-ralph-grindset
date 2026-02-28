// ============================================================================
// CLI backend: spawns `claude -p` for audit
// ============================================================================

import type { AuditResult, AuditConfig } from "../types";
import { log } from "../logging";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";
import { AUDIT_JSON_SCHEMA, AUDIT_SCHEMA_NAME } from "./schema";

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
  }

  if (Array.isArray(parsed)) {
    // Strategy 3: last element has .structured_output
    const last = parsed[parsed.length - 1];
    if (last?.structured_output?.issues) {
      return last.structured_output as AuditResult;
    }

    // Strategy 4: last element has .result
    if (last?.result?.issues) {
      return last.result as AuditResult;
    }

    // Strategy 5: last element IS the result
    if (last?.issues) {
      return last as AuditResult;
    }

    // Strategy 6: find first object with .issues
    for (const item of parsed) {
      if (item?.issues) {
        return item as AuditResult;
      }
    }
  }

  throw new ParseError("Cannot extract issues from CLI output", raw);
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

  const schemaStr = JSON.stringify({ name: AUDIT_SCHEMA_NAME, ...AUDIT_JSON_SCHEMA });

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

  const proc = Bun.spawn(args, {
    stdin: new Response(userPrompt),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: "" },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errorType = `cli_exit_${exitCode}`;
    log.error(`Claude CLI failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    throw Object.assign(new Error(`Claude CLI exit code ${exitCode}`), {
      errorType,
      stderr: stderr.slice(0, 500),
    });
  }

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
