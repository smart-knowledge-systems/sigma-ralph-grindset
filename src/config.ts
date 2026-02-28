// ============================================================================
// Configuration loader — parses audit.conf and resolves paths
// ============================================================================

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { AuditConfig, AuditMode } from "./types";

/**
 * Parse a bash-style audit.conf file into key-value pairs.
 * Handles: KEY=VALUE, KEY="value", KEY=("a" "b"), and bash arrays.
 */
export function parseAuditConf(
  content: string,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Handle quoted values: extract content between quotes, ignore trailing comment
    if (value.startsWith('"')) {
      const closeQuote = value.indexOf('"', 1);
      if (closeQuote !== -1) {
        result[key] = value.slice(1, closeQuote);
        continue;
      }
    } else if (value.startsWith("'")) {
      const closeQuote = value.indexOf("'", 1);
      if (closeQuote !== -1) {
        result[key] = value.slice(1, closeQuote);
        continue;
      }
    }

    // Bash array: KEY=("a" "b" "c") or KEY=()
    if (value.startsWith("(") && value.endsWith(")")) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        result[key] = [];
      } else {
        // Parse space-separated quoted or unquoted values.
        // Regex is a static literal — no user input in the pattern, so no injection risk.
        const items: string[] = [];
        for (const match of inner.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
          items.push(match[1] ?? match[2] ?? match[3] ?? "");
        }
        result[key] = items;
      }
      continue;
    }

    // Remove inline comments for unquoted values
    const commentIdx = value.indexOf(" #");
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();

    result[key] = value;
  }

  return result;
}

/**
 * Resolve PROJECT_ROOT using the same 4-step portable mode logic as lib.sh.
 */
function resolveProjectRoot(auditDir: string): string {
  // 1. SIGMA_PROJECT_ROOT env var
  const envRoot = process.env.SIGMA_PROJECT_ROOT;
  if (envRoot) return resolve(envRoot);

  // 2. Parent has .git → portable mode
  const parentGit = resolve(auditDir, "..", ".git");
  if (existsSync(parentGit)) return resolve(auditDir, "..");

  // 3. AUDIT_DIR has .git → self-audit
  const selfGit = resolve(auditDir, ".git");
  if (existsSync(selfGit)) return auditDir;

  // 4. Portable mode fallback
  return resolve(auditDir, "..");
}

/** Load configuration from audit.conf and resolve all paths. */
export function loadConfig(auditDir?: string): AuditConfig {
  const resolvedAuditDir = auditDir
    ? resolve(auditDir)
    : resolve(import.meta.dir, "..");

  // Load audit.conf.default first, then overlay audit.conf (user overrides)
  let conf: Record<string, string | string[]> = {};
  const defaultConfPath = resolve(resolvedAuditDir, "audit.conf.default");
  if (existsSync(defaultConfPath)) {
    conf = parseAuditConf(readFileSync(defaultConfPath, "utf-8"));
  }
  const confPath = resolve(resolvedAuditDir, "audit.conf");
  if (existsSync(confPath)) {
    const overrides = parseAuditConf(readFileSync(confPath, "utf-8"));
    Object.assign(conf, overrides);
  }

  // Resolve PROJECT_ROOT (conf value or auto-detect)
  const confProjectRoot = conf.PROJECT_ROOT;
  const projectRoot =
    typeof confProjectRoot === "string" && confProjectRoot
      ? resolve(resolvedAuditDir, confProjectRoot)
      : resolveProjectRoot(resolvedAuditDir);

  const fileExtStr =
    typeof conf.FILE_EXTENSIONS === "string" ? conf.FILE_EXTENSIONS : "ts tsx";
  const fileExtensions = fileExtStr.split(/\s+/).filter(Boolean);

  const startDirs = Array.isArray(conf.START_DIRS)
    ? conf.START_DIRS
    : [
        "src/components",
        "src/app",
        "src/lib",
        "src/backend",
        "src/frontend",
        "src/providers",
      ];

  const excludeDirs = Array.isArray(conf.EXCLUDE_DIRS) ? conf.EXCLUDE_DIRS : [];

  const getNum = (key: string, def: number): number => {
    const v = conf[key];
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return isNaN(n) ? def : n;
    }
    return def;
  };

  const getStr = (key: string, def: string): string => {
    const v = conf[key];
    return typeof v === "string" && v ? v : def;
  };

  return {
    projectRoot,
    auditDir: resolvedAuditDir,
    dbPath: resolve(resolvedAuditDir, "audit.db"),
    branchesFile: resolve(resolvedAuditDir, "branches.txt"),
    policiesDir: resolve(resolvedAuditDir, "policies"),
    startDirs,
    fileExtensions,
    excludeDirs,
    maxLoc: getNum("MAX_LOC", 3000),
    maxFixLoc: getNum("MAX_FIX_LOC", 2000),
    auditModel: getStr("AUDIT_MODEL", "haiku"),
    fixModel: getStr("FIX_MODEL", "sonnet"),
    commitModel: getStr("COMMIT_MODEL", "haiku"),
    defaultMode: ((): AuditMode => {
      const raw = getStr("DEFAULT_MODE", "api");
      if (raw === "cli" || raw === "api" || raw === "batch") return raw;
      return "api";
    })(),
    defaultDiff: getStr("DEFAULT_DIFF", "false") === "true",
    defaultDiffRef: getStr("DEFAULT_DIFF_REF", ""),
    defaultForceAll: getStr("DEFAULT_FORCE_ALL", "false") === "true",
    defaultDryRun: getStr("DEFAULT_DRY_RUN", "false") === "true",
    defaultStdout: getStr("DEFAULT_STDOUT", "false") === "true",
    defaultInteractive: getStr("DEFAULT_INTERACTIVE", "false") === "true",
    defaultSkipCommits: getStr("DEFAULT_SKIP_COMMITS", "false") === "true",
  };
}
