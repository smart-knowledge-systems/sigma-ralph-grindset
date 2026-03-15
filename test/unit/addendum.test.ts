import { describe, it, expect } from "bun:test";
import {
  parseFrontmatter,
  matchesContext,
  discoverAddendums,
  loadMatchingAddendums,
  buildAddendumContext,
} from "../../src/audit/addendum";
import type { AddendumContext, AddendumFrontmatter } from "../../src/audit/addendum";
import { resolve } from "path";

// ============================================================================
// parseFrontmatter
// ============================================================================

describe("parseFrontmatter", () => {
  it("parses file_extensions from valid frontmatter", () => {
    const content = [
      "---",
      "applies_when:",
      "  file_extensions: [ts, tsx]",
      "---",
      "",
      "# Body content",
    ].join("\n");

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.applies_when?.file_extensions).toEqual(["ts", "tsx"]);
    expect(body).toBe("# Body content");
  });

  it("parses dependencies from valid frontmatter", () => {
    const content = [
      "---",
      "applies_when:",
      "  dependencies: [axiom, @axiom-js/core]",
      "---",
      "",
      "# Body",
    ].join("\n");

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter!.applies_when?.dependencies).toEqual([
      "axiom",
      "@axiom-js/core",
    ]);
    expect(body).toBe("# Body");
  });

  it("parses both file_extensions and dependencies", () => {
    const content = [
      "---",
      "applies_when:",
      "  file_extensions: [ts, tsx]",
      "  dependencies: [axiom]",
      "---",
      "",
      "# Body",
    ].join("\n");

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.applies_when?.file_extensions).toEqual(["ts", "tsx"]);
    expect(frontmatter!.applies_when?.dependencies).toEqual(["axiom"]);
  });

  it("returns null frontmatter when no --- delimiters", () => {
    const content = "# Just a regular markdown file\n\nSome content.";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  it("returns null frontmatter when no closing ---", () => {
    const content = "---\napplies_when:\n  file_extensions: [ts]\n# No closing delimiter";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  it("returns empty applies_when when block is empty", () => {
    const content = "---\napplies_when:\n---\n\n# Body";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.applies_when).toEqual({});
    expect(body).toBe("# Body");
  });
});

// ============================================================================
// matchesContext
// ============================================================================

describe("matchesContext", () => {
  const tsContext: AddendumContext = {
    fileExtensions: ["ts", "tsx"],
    imports: ["@/lib/utils", "react", "@axiom-js/core"],
  };

  const exContext: AddendumContext = {
    fileExtensions: ["ex", "exs"],
    imports: [],
  };

  it("matches when file extensions overlap", () => {
    const fm: AddendumFrontmatter = {
      applies_when: { file_extensions: ["ts", "tsx"] },
    };
    expect(matchesContext(fm, tsContext)).toBe(true);
  });

  it("matches with partial extension overlap", () => {
    const fm: AddendumFrontmatter = {
      applies_when: { file_extensions: ["ts", "js"] },
    };
    expect(matchesContext(fm, tsContext)).toBe(true);
  });

  it("does not match when no extension overlap", () => {
    const fm: AddendumFrontmatter = {
      applies_when: { file_extensions: ["ex", "exs"] },
    };
    expect(matchesContext(fm, tsContext)).toBe(false);
  });

  it("matches when dependency appears in imports", () => {
    const fm: AddendumFrontmatter = {
      applies_when: { dependencies: ["axiom"] },
    };
    expect(matchesContext(fm, tsContext)).toBe(true);
  });

  it("does not match when dependency is absent from imports", () => {
    const fm: AddendumFrontmatter = {
      applies_when: { dependencies: ["phoenix"] },
    };
    expect(matchesContext(fm, tsContext)).toBe(false);
  });

  it("does not match dependencies when imports are empty", () => {
    const fm: AddendumFrontmatter = {
      applies_when: { dependencies: ["axiom"] },
    };
    expect(matchesContext(fm, exContext)).toBe(false);
  });

  it("ANDs file_extensions and dependencies (both must match)", () => {
    const fm: AddendumFrontmatter = {
      applies_when: {
        file_extensions: ["ts", "tsx"],
        dependencies: ["phoenix"],
      },
    };
    // Extensions match but dependency doesn't
    expect(matchesContext(fm, tsContext)).toBe(false);
  });

  it("matches when both conditions are satisfied", () => {
    const fm: AddendumFrontmatter = {
      applies_when: {
        file_extensions: ["ts", "tsx"],
        dependencies: ["axiom"],
      },
    };
    expect(matchesContext(fm, tsContext)).toBe(true);
  });

  it("always matches when frontmatter is null", () => {
    expect(matchesContext(null, tsContext)).toBe(true);
  });

  it("always matches when applies_when is undefined", () => {
    expect(matchesContext({}, tsContext)).toBe(true);
  });

  it("always matches when applies_when is empty", () => {
    expect(matchesContext({ applies_when: {} }, tsContext)).toBe(true);
  });
});

// ============================================================================
// discoverAddendums
// ============================================================================

describe("discoverAddendums", () => {
  const fpPolicyDir = resolve(
    import.meta.dir,
    "../../policies/functional-programming",
  );

  it("finds ADDENDUM-*.md files in a policy directory", () => {
    const addendums = discoverAddendums(fpPolicyDir);
    const names = addendums.map((p) => p.split("/").pop());
    expect(names).toContain("ADDENDUM-typescript.md");
    expect(names).toContain("ADDENDUM-elixir.md");
  });

  it("does not include POLICY.md", () => {
    const addendums = discoverAddendums(fpPolicyDir);
    const names = addendums.map((p) => p.split("/").pop());
    expect(names).not.toContain("POLICY.md");
  });

  it("returns sorted results", () => {
    const addendums = discoverAddendums(fpPolicyDir);
    const names = addendums.map((p) => p.split("/").pop());
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("returns empty array for directory without addendums", () => {
    const dir = resolve(import.meta.dir, "../../policies/testing-philosophy");
    expect(discoverAddendums(dir)).toEqual([]);
  });

  it("returns empty array for nonexistent directory", () => {
    expect(discoverAddendums("/nonexistent/path")).toEqual([]);
  });
});

// ============================================================================
// loadMatchingAddendums
// ============================================================================

describe("loadMatchingAddendums", () => {
  const fpPolicyDir = resolve(
    import.meta.dir,
    "../../policies/functional-programming",
  );

  it("includes TypeScript addendum for ts/tsx extensions", () => {
    const ctx: AddendumContext = { fileExtensions: ["ts", "tsx"], imports: [] };
    const result = loadMatchingAddendums(fpPolicyDir, ctx);
    expect(result).toContain("TypeScript FP Addendum");
    expect(result).not.toContain("Elixir FP Addendum");
  });

  it("includes Elixir addendum for ex/exs extensions", () => {
    const ctx: AddendumContext = { fileExtensions: ["ex", "exs"], imports: [] };
    const result = loadMatchingAddendums(fpPolicyDir, ctx);
    expect(result).toContain("Elixir FP Addendum");
    expect(result).not.toContain("TypeScript FP Addendum");
  });

  it("includes neither for unrelated extensions", () => {
    const ctx: AddendumContext = { fileExtensions: ["py"], imports: [] };
    const result = loadMatchingAddendums(fpPolicyDir, ctx);
    expect(result).toBe("");
  });

  it("returns empty string for directory without addendums", () => {
    const dir = resolve(import.meta.dir, "../../policies/testing-philosophy");
    const ctx: AddendumContext = { fileExtensions: ["ts"], imports: [] };
    expect(loadMatchingAddendums(dir, ctx)).toBe("");
  });

  it("strips frontmatter from returned content", () => {
    const ctx: AddendumContext = { fileExtensions: ["ts", "tsx"], imports: [] };
    const result = loadMatchingAddendums(fpPolicyDir, ctx);
    expect(result).not.toContain("applies_when:");
    expect(result).not.toContain("file_extensions:");
  });
});

// ============================================================================
// buildAddendumContext
// ============================================================================

describe("buildAddendumContext", () => {
  it("builds context from config without files", () => {
    const config = { fileExtensions: ["ts", "tsx"] } as any;
    const ctx = buildAddendumContext(config);
    expect(ctx.fileExtensions).toEqual(["ts", "tsx"]);
    expect(ctx.imports).toEqual([]);
  });
});
