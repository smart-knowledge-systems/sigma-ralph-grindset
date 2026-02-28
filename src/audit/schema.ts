// ============================================================================
// JSON Schema + runtime validation for structured audit output
// ============================================================================

import type { AuditResult } from "../types";
import { log } from "../logging";

/** Schema name (used at the format level for API, top-level for CLI). */
export const AUDIT_SCHEMA_NAME = "audit_report";

/** JSON Schema constant used for CLI --json-schema and API output_config.format.schema. */
export const AUDIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          rule: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          suggestion: { type: "string" },
          policy: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: [
          "description",
          "rule",
          "severity",
          "suggestion",
          "policy",
          "files",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
} as const;

const VALID_SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * Validate parsed JSON against the AuditResult schema at runtime.
 * Returns a valid AuditResult with only well-formed issues, or
 * a fallback with empty issues if the top-level structure is wrong.
 *
 * Shared by both API and CLI backends to validate JSON.parse output
 * at the type system boundary.
 */
export function validateAuditResult(parsed: unknown): AuditResult {
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
  const issues = raw.issues.filter(
    (item): item is AuditResult["issues"][number] => {
      if (typeof item !== "object" || item === null) return false;
      const o = item as Record<string, unknown>;
      if (typeof o.description !== "string" || !o.description) return false;
      if (typeof o.rule !== "string") return false;
      if (typeof o.severity !== "string" || !VALID_SEVERITIES.has(o.severity)) {
        // Coerce invalid severity to "medium" instead of rejecting
        o.severity = "medium";
      }
      if (typeof o.suggestion !== "string") o.suggestion = "";
      if (typeof o.policy !== "string") o.policy = "";
      if (
        !Array.isArray(o.files) ||
        o.files.length === 0 ||
        !o.files.every((f: unknown) => typeof f === "string")
      ) {
        return false;
      }
      return true;
    },
  );

  if (issues.length < raw.issues.length) {
    log.warn(
      `Filtered ${raw.issues.length - issues.length} invalid issues from audit result`,
    );
  }

  return { issues };
}
