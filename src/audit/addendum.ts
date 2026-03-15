// ============================================================================
// Addendum discovery, frontmatter parsing, and conditional loading
// ============================================================================

import { readdirSync } from "fs";
import { resolve } from "path";
import { cachedReadFile } from "./prompts";
import { extractImports } from "../branches/scanner";
import type { AuditConfig } from "../types";

/** Parsed YAML frontmatter from an addendum file. */
export interface AddendumFrontmatter {
  applies_when?: {
    file_extensions?: string[];
    dependencies?: string[];
  };
}

/** Runtime context used to evaluate addendum conditions. */
export interface AddendumContext {
  fileExtensions: string[];
  imports: string[];
}

/**
 * Parse YAML frontmatter from an addendum file.
 * Supports a minimal subset: `applies_when.file_extensions` and
 * `applies_when.dependencies` with inline array syntax `[a, b]`.
 */
export function parseFrontmatter(content: string): {
  frontmatter: AddendumFrontmatter | null;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: null, body: content };
  }

  const yamlBlock = content.slice(content.indexOf("\n") + 1, endIdx);
  const body = content.slice(endIdx + 4).trimStart();

  const frontmatter: AddendumFrontmatter = {};
  const lines = yamlBlock.split("\n");

  let inAppliesWhen = false;
  for (const line of lines) {
    if (/^applies_when:\s*$/.test(line)) {
      inAppliesWhen = true;
      frontmatter.applies_when = {};
      continue;
    }
    if (!inAppliesWhen) continue;

    // Stop parsing applies_when on a non-indented line
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      inAppliesWhen = false;
      continue;
    }

    const extMatch = line.match(/^\s+file_extensions:\s*\[([^\]]*)\]/);
    if (extMatch) {
      frontmatter.applies_when!.file_extensions = extMatch[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    const depMatch = line.match(/^\s+dependencies:\s*\[([^\]]*)\]/);
    if (depMatch) {
      frontmatter.applies_when!.dependencies = depMatch[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return { frontmatter, body };
}

/**
 * Check whether an addendum's conditions match the current audit context.
 * All conditions under `applies_when` are AND'd together.
 * Null/empty frontmatter = always matches.
 */
export function matchesContext(
  frontmatter: AddendumFrontmatter | null,
  context: AddendumContext,
): boolean {
  if (!frontmatter?.applies_when) return true;

  const { file_extensions, dependencies } = frontmatter.applies_when;

  // file_extensions: match if any overlap
  if (file_extensions && file_extensions.length > 0) {
    const extSet = new Set(context.fileExtensions);
    const hasOverlap = file_extensions.some((ext) => extSet.has(ext));
    if (!hasOverlap) return false;
  }

  // dependencies: match if any listed dep appears as substring in imports
  if (dependencies && dependencies.length > 0) {
    if (context.imports.length === 0) return false;
    const importsJoined = context.imports.join("\n");
    const hasMatch = dependencies.some((dep) => importsJoined.includes(dep));
    if (!hasMatch) return false;
  }

  return true;
}

/** Discover addendum files (ADDENDUM-*.md) in a policy directory. */
export function discoverAddendums(policyDir: string): string[] {
  try {
    const entries = readdirSync(policyDir);
    return entries
      .filter(
        (name) =>
          name.startsWith("ADDENDUM-") && name.endsWith(".md"),
      )
      .sort()
      .map((name) => resolve(policyDir, name));
  } catch {
    return [];
  }
}

/**
 * Load and concatenate all addendums that match the given context.
 * Returns the combined body text (empty string if no matches).
 */
export function loadMatchingAddendums(
  policyDir: string,
  context: AddendumContext,
): string {
  const paths = discoverAddendums(policyDir);
  const parts: string[] = [];

  for (const path of paths) {
    const content = cachedReadFile(path);
    if (!content) continue;

    const { frontmatter, body } = parseFrontmatter(content);
    if (matchesContext(frontmatter, context)) {
      parts.push(body);
    }
  }

  return parts.join("\n\n");
}

/** Build an AddendumContext from audit config and optional branch files. */
export function buildAddendumContext(
  config: AuditConfig,
  files?: string[],
): AddendumContext {
  const imports: string[] = [];
  if (files) {
    const seen = new Set<string>();
    for (const file of files) {
      for (const imp of extractImports(file)) {
        if (!seen.has(imp)) {
          seen.add(imp);
          imports.push(imp);
        }
      }
    }
  }
  return { fileExtensions: config.fileExtensions, imports };
}
