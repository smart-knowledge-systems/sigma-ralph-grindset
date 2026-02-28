// ============================================================================
// Config field definitions, read/validate/serialize/write
// ============================================================================

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { parseAuditConf } from "../config";

export interface ConfigField {
  key: string;
  label: string;
  type: "string" | "string[]" | "number" | "boolean" | "model" | "enum";
  options?: string[];
  default: string | string[] | number | boolean;
  description: string;
  section: "paths" | "limits" | "models" | "defaults";
}

export type ConfigValues = Record<string, string | string[] | number | boolean>;

export const MODEL_OPTIONS = ["haiku", "sonnet", "opus"];

export const CONFIG_FIELDS: ConfigField[] = [
  // === Paths ===
  {
    key: "PROJECT_ROOT",
    label: "Project root",
    type: "string",
    default: "",
    description:
      "Absolute path to the project being audited (empty = auto-detect)",
    section: "paths",
  },
  {
    key: "START_DIRS",
    label: "Scan directories",
    type: "string[]",
    default: ["src"],
    description: "Directories to scan for source files",
    section: "paths",
  },
  {
    key: "FILE_EXTENSIONS",
    label: "File extensions",
    type: "string",
    default: "ts tsx",
    description: "Space-separated file extensions to include",
    section: "paths",
  },
  {
    key: "EXCLUDE_DIRS",
    label: "Exclude directories",
    type: "string[]",
    default: [],
    description: "Directories to exclude from scanning",
    section: "paths",
  },
  // === Limits ===
  {
    key: "MAX_LOC",
    label: "Max LOC per branch",
    type: "number",
    default: 3000,
    description: "Branch splitting threshold",
    section: "limits",
  },
  {
    key: "MAX_FIX_LOC",
    label: "Max LOC per fix batch",
    type: "number",
    default: 2000,
    description: "Fix batching threshold",
    section: "limits",
  },
  // === Models ===
  {
    key: "AUDIT_MODEL",
    label: "Audit model",
    type: "model",
    default: "haiku",
    description: "Model for code review",
    section: "models",
  },
  {
    key: "FIX_MODEL",
    label: "Fix model",
    type: "model",
    default: "sonnet",
    description: "Model for applying fixes",
    section: "models",
  },
  {
    key: "COMMIT_MODEL",
    label: "Commit model",
    type: "model",
    default: "haiku",
    description: "Model for commit messages",
    section: "models",
  },
  // === Default Behavior ===
  {
    key: "DEFAULT_MODE",
    label: "Default mode",
    type: "enum",
    options: ["api", "cli"],
    default: "api",
    description: "Audit backend (--cli to override)",
    section: "defaults",
  },
  {
    key: "DEFAULT_DIFF",
    label: "Diff mode",
    type: "boolean",
    default: false,
    description: "--diff: only audit changed files",
    section: "defaults",
  },
  {
    key: "DEFAULT_DIFF_REF",
    label: "Diff ref",
    type: "string",
    default: "",
    description: "--diff [ref]: default git ref (e.g. HEAD~1, main)",
    section: "defaults",
  },
  {
    key: "DEFAULT_FORCE_ALL",
    label: "Force all",
    type: "boolean",
    default: false,
    description: "--all: ignore checkpoints, full audit",
    section: "defaults",
  },
  {
    key: "DEFAULT_DRY_RUN",
    label: "Dry run",
    type: "boolean",
    default: false,
    description: "--dry-run: show estimate without executing",
    section: "defaults",
  },
  {
    key: "DEFAULT_PER_POLICY",
    label: "Per-policy",
    type: "boolean",
    default: false,
    description: "--per-policy: run policies separately",
    section: "defaults",
  },
  {
    key: "DEFAULT_STDOUT",
    label: "Stdout only",
    type: "boolean",
    default: false,
    description: "--stdout: skip browser UI",
    section: "defaults",
  },
  {
    key: "DEFAULT_INTERACTIVE",
    label: "Interactive fix",
    type: "boolean",
    default: false,
    description: "--interactive: open Claude interactively for fixes",
    section: "defaults",
  },
  {
    key: "DEFAULT_SKIP_COMMITS",
    label: "Skip commits",
    type: "boolean",
    default: false,
    description: "--dangerously-skip-commits: skip git commits in fix",
    section: "defaults",
  },
];

/** Apply parsed conf values onto a ConfigValues object. */
function applyParsed(
  values: ConfigValues,
  parsed: Record<string, string | string[]>,
): void {
  for (const field of CONFIG_FIELDS) {
    const raw = parsed[field.key];
    if (raw === undefined) continue;

    switch (field.type) {
      case "string":
      case "model":
      case "enum":
        if (typeof raw === "string") values[field.key] = raw;
        break;
      case "string[]":
        if (Array.isArray(raw)) values[field.key] = raw;
        break;
      case "number":
        if (typeof raw === "string") {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) values[field.key] = n;
        }
        break;
      case "boolean":
        if (typeof raw === "string") values[field.key] = raw === "true";
        break;
    }
  }
}

/**
 * Read effective config: field defaults → audit.conf.default → audit.conf.
 * Delete audit.conf to restore defaults.
 */
export function readConfig(auditDir: string): ConfigValues {
  const values: ConfigValues = {};

  // 1. Start with hardcoded field defaults
  for (const field of CONFIG_FIELDS) {
    values[field.key] = field.default;
  }

  // 2. Overlay audit.conf.default (ships with repo)
  const defaultPath = resolve(auditDir, "audit.conf.default");
  if (existsSync(defaultPath)) {
    applyParsed(values, parseAuditConf(readFileSync(defaultPath, "utf-8")));
  }

  // 3. Overlay audit.conf (user overrides, gitignored)
  const confPath = resolve(auditDir, "audit.conf");
  if (existsSync(confPath)) {
    applyParsed(values, parseAuditConf(readFileSync(confPath, "utf-8")));
  }

  return values;
}

/** Validate a single field value. Returns error string or null. */
export function validateField(
  field: ConfigField,
  value: unknown,
): string | null {
  switch (field.type) {
    case "string":
      if (typeof value !== "string") return `${field.label} must be a string`;
      break;
    case "string[]":
      if (!Array.isArray(value)) return `${field.label} must be an array`;
      break;
    case "number":
      if (typeof value !== "number" || isNaN(value))
        return `${field.label} must be a number`;
      if (value < 0) return `${field.label} must be positive`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${field.label} must be a boolean`;
      break;
    case "model":
      if (typeof value !== "string") return `${field.label} must be a string`;
      if (!MODEL_OPTIONS.includes(value))
        return `${field.label} must be one of: ${MODEL_OPTIONS.join(", ")}`;
      break;
    case "enum":
      if (typeof value !== "string") return `${field.label} must be a string`;
      if (field.options && !field.options.includes(value))
        return `${field.label} must be one of: ${field.options.join(", ")}`;
      break;
  }
  return null;
}

/** Serialize config values to bash-format string with section comments. */
export function serializeConfig(values: ConfigValues): string {
  const lines: string[] = [];

  lines.push(
    "# audit.conf — User overrides (delete this file to restore defaults)",
  );
  lines.push(
    "# Defaults live in audit.conf.default. Run `bun config` to edit.",
  );
  lines.push("");

  const sections: Array<{
    key: ConfigField["section"];
    header: string;
  }> = [
    { key: "paths", header: "Project paths" },
    { key: "limits", header: "LOC limits" },
    { key: "models", header: "Claude model selection per stage" },
    { key: "defaults", header: "Default CLI behavior" },
  ];

  for (const section of sections) {
    const fields = CONFIG_FIELDS.filter((f) => f.section === section.key);
    lines.push(`# ${section.header}`);

    for (const field of fields) {
      const val = values[field.key] ?? field.default;

      if (field.type === "string[]") {
        const arr = Array.isArray(val) ? val : [];
        if (arr.length === 0) {
          lines.push(`${field.key}=()`);
        } else {
          const quoted = arr.map((s) => `"${s}"`).join(" ");
          lines.push(`${field.key}=(${quoted})`);
        }
      } else if (
        field.type === "string" ||
        field.type === "model" ||
        field.type === "enum"
      ) {
        lines.push(`${field.key}="${val}"`);
      } else if (field.type === "number") {
        lines.push(`${field.key}=${val}`);
      } else if (field.type === "boolean") {
        lines.push(`${field.key}=${val}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Write user overrides to audit.conf. Delete this file to restore defaults. */
export function writeConfig(auditDir: string, values: ConfigValues): void {
  const confPath = resolve(auditDir, "audit.conf");
  writeFileSync(confPath, serializeConfig(values), "utf-8");
}
