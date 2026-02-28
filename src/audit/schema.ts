// ============================================================================
// JSON Schema for structured audit output
// ============================================================================

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
