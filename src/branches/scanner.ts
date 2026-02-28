// ============================================================================
// File scanning, LOC counting, and extension matching
// ============================================================================

import { type Dirent, readdirSync, readFileSync } from "fs";
import { resolve, extname, relative } from "path";
import type { AuditConfig } from "../types";

/** Check if a filename matches configured extensions. */
export function matchesExtensions(
  filename: string,
  extensions: string[],
): boolean {
  const ext = extname(filename).slice(1); // remove leading dot
  return extensions.includes(ext);
}

/** Check if a path is under an excluded directory. */
export function isExcludedPath(
  filePath: string,
  excludeDirs: string[],
): boolean {
  const clean = filePath.replace(/^\.\//, "");
  return excludeDirs.some((dir) => {
    const cleanDir = dir.replace(/^\.\//, "");
    return clean === cleanDir || clean.startsWith(cleanDir + "/");
  });
}

/** Map the first file extension to a code fence language tag. */
export function extToLang(extensions: string[]): string {
  if (extensions.length === 0) return "";
  const first = extensions[0]!;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    sh: "bash",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
  };
  return map[first] ?? first;
}

/** Human-readable label for configured extensions. */
export function extDisplayLabel(extensions: string[]): string {
  return extensions.map((e) => `.${e}`).join("/");
}

/** Count LOC in one or more files. */
export function countLoc(filePaths: string[]): number {
  let total = 0;
  for (const fp of filePaths) {
    try {
      const content = readFileSync(fp, "utf-8");
      total += content.split("\n").length;
    } catch {
      // skip unreadable files
    }
  }
  return total;
}

/**
 * Find source files in a directory.
 * @param dir - Absolute directory path
 * @param flat - If true, only scan top-level files (no recursion)
 * @param config - Audit configuration
 */
export function findSourceFiles(
  dir: string,
  flat: boolean,
  config: AuditConfig,
): string[] {
  const results: string[] = [];

  function scan(currentDir: string, depth: number): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      const relPath = relative(config.projectRoot, fullPath);

      if (entry.isDirectory()) {
        if (isExcludedPath(relPath, config.excludeDirs)) continue;
        scan(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (isExcludedPath(relPath, config.excludeDirs)) continue;
        if (matchesExtensions(entry.name, config.fileExtensions)) {
          results.push(fullPath);
        }
      }
    }
  }

  if (flat) {
    // Only scan direct children
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = resolve(dir, entry.name);
        const relPath = relative(config.projectRoot, fullPath);
        if (isExcludedPath(relPath, config.excludeDirs)) continue;
        if (matchesExtensions(entry.name, config.fileExtensions)) {
          results.push(fullPath);
        }
      }
    } catch {
      // skip
    }
  } else {
    scan(dir, 0);
  }

  return results;
}

/** Parse a file reference like "path:14-22" into path + line range. */
export function parseFileRef(raw: string): { path: string; lines: string } {
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx === -1) return { path: raw, lines: "" };

  const after = raw.slice(colonIdx + 1);
  if (/^\d/.test(after)) {
    return { path: raw.slice(0, colonIdx), lines: after };
  }
  return { path: raw, lines: "" };
}

/** Extract and resolve import paths from a TypeScript/JS source file. */
export function extractImports(filePath: string): string[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const imports = new Set<string>();
  const importRegex =
    /^\s*(?:import|export)\s.*\sfrom\s+['"]([@./][^'"]+)['"]/gm;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1]!;
    const resolved = resolveAlias(importPath);
    if (resolved) imports.add(resolved);
  }

  return [...imports].sort();
}

function resolveAlias(importPath: string): string {
  if (!/^[@./]/.test(importPath)) return "";
  if (importPath.startsWith("@/convex/"))
    return importPath.replace("@/convex", "convex");
  if (importPath.startsWith("@/")) return importPath.replace("@/", "src/");
  return importPath;
}
