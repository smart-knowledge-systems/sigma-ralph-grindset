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
 * Normalize common field-name aliases that models (especially Haiku) produce
 * instead of the schema-specified names. Mutates the object in place.
 * Returns true if any remapping was applied.
 */
function normalizeIssueFields(o: Record<string, unknown>): boolean {
  let remapped = false;

  // affected_files → files
  if (o.files === undefined && Array.isArray(o.affected_files)) {
    o.files = o.affected_files;
    delete o.affected_files;
    remapped = true;
  }

  // rule_violations (array) → rule (joined string)
  if (o.rule === undefined && Array.isArray(o.rule_violations)) {
    o.rule = (o.rule_violations as string[]).join("; ");
    delete o.rule_violations;
    remapped = true;
  }

  // fix / recommended_fix → suggestion
  if (o.suggestion === undefined || o.suggestion === "") {
    const alt = o.fix ?? o.recommended_fix;
    if (typeof alt === "string" && alt) {
      o.suggestion = alt;
      delete o.fix;
      delete o.recommended_fix;
      remapped = true;
    }
  }

  // title → prepend to description
  if (typeof o.title === "string" && o.title) {
    if (typeof o.description === "string" && o.description) {
      o.description = `${o.title}: ${o.description}`;
    } else {
      o.description = o.title;
    }
    delete o.title;
    remapped = true;
  }

  // Strip known extra fields that models invent
  for (const extra of ["id", "code_example", "line_numbers"] as const) {
    if (extra in o) {
      delete o[extra];
      remapped = true;
    }
  }

  return remapped;
}

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
  let remappedCount = 0;
  const rejected: Array<{ item: unknown; reason: string }> = [];
  const issues = raw.issues.filter(
    (item): item is AuditResult["issues"][number] => {
      if (typeof item !== "object" || item === null) {
        rejected.push({ item, reason: "not an object" });
        return false;
      }
      const o = item as Record<string, unknown>;

      // Normalize field aliases before validation
      if (normalizeIssueFields(o)) remappedCount++;

      if (typeof o.description !== "string" || !o.description) {
        rejected.push({ item: o, reason: "missing or empty description" });
        return false;
      }
      if (typeof o.rule !== "string") {
        rejected.push({ item: o, reason: "missing rule" });
        return false;
      }
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
        rejected.push({
          item: o,
          reason: `invalid files field: ${JSON.stringify(o.files)}`,
        });
        return false;
      }
      return true;
    },
  );

  if (remappedCount > 0) {
    log.debug(`Remapped field aliases on ${remappedCount} issues`);
  }

  if (rejected.length > 0) {
    log.warn(`Filtered ${rejected.length} invalid issues from audit result`);
    for (const { item, reason } of rejected) {
      log.debug(`  Rejected (${reason}): ${JSON.stringify(item)}`);
    }
  }

  return { issues };
}
