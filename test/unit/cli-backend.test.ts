import { describe, test, expect } from "bun:test";
import {
  parseCliOutput,
  parseNarrativeIssues,
  ParseError,
} from "../../src/audit/cli-backend";

describe("parseCliOutput", () => {
  test("structured_output envelope (primary path)", () => {
    const raw = JSON.stringify({
      type: "result",
      structured_output: {
        issues: [
          {
            description: "test",
            rule: "R1",
            severity: "low",
            suggestion: "fix",
            policy: "p",
            files: ["a.ts"],
          },
        ],
      },
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe("R1");
  });

  test("direct {issues:[]} object", () => {
    const raw = JSON.stringify({ issues: [] });
    const result = parseCliOutput(raw);
    expect(result.issues).toEqual([]);
  });

  test("array with structured_output in last element", () => {
    const raw = JSON.stringify([
      { type: "text", text: "thinking..." },
      {
        structured_output: {
          issues: [
            {
              description: "d",
              rule: "R2",
              severity: "high",
              suggestion: "s",
              policy: "p",
              files: ["b.ts"],
            },
          ],
        },
      },
    ]);
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(1);
  });

  test("array with .result in last element", () => {
    const raw = JSON.stringify([{ result: { issues: [] } }]);
    const result = parseCliOutput(raw);
    expect(result.issues).toEqual([]);
  });

  test("CLI envelope with .result as object containing issues", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      result: {
        issues: [
          {
            description: "d",
            rule: "R3",
            severity: "medium",
            suggestion: "s",
            policy: "p",
            files: ["c.ts"],
          },
        ],
      },
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe("R3");
  });

  test("CLI envelope with .result as string containing JSON", () => {
    const issues = {
      issues: [
        {
          description: "test issue",
          rule: "R4",
          severity: "low",
          suggestion: "fix it",
          policy: "p",
          files: ["d.ts"],
        },
      ],
    };
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Here are my findings:\n\n${JSON.stringify(issues)}`,
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe("R4");
  });

  test("CLI envelope with .result as string with JSON in code fence", () => {
    const issues = {
      issues: [
        {
          description: "fenced",
          rule: "R5",
          severity: "high",
          suggestion: "s",
          policy: "p",
          files: ["e.ts"],
        },
      ],
    };
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      result: `Audit complete:\n\n\`\`\`json\n${JSON.stringify(issues)}\n\`\`\``,
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe("R5");
  });

  test("array with .result as string containing JSON in last element", () => {
    const issues = { issues: [] };
    const raw = JSON.stringify([
      { type: "text", text: "thinking..." },
      { result: `No issues found.\n${JSON.stringify(issues)}` },
    ]);
    const result = parseCliOutput(raw);
    expect(result.issues).toEqual([]);
  });

  test("throws ParseError for invalid JSON", () => {
    expect(() => parseCliOutput("not json")).toThrow(ParseError);
  });

  test("throws ParseError when output has no recognizable structure", () => {
    expect(() => parseCliOutput(JSON.stringify({ foo: "bar" }))).toThrow(
      ParseError,
    );
  });

  test("CLI envelope with narrative markdown issues (fallback parser)", () => {
    const narrative = `I'll review the files.

## Audit Results

### Issue 1: Raw console.log bypasses logging library
**Rule**: Use the Logging Library (Rule 1)
**Severity**: medium
**Policy**: logging-strategy
**Files**: \`src/index.ts\`

**Fix**: Replace console.log with log.info().

---

### Issue 2: Missing error structure
**Rule**: Error Logging Structure (Rule 10)
**Severity**: high
**Policy**: logging-strategy
**Files**: \`src/logging.ts\`, \`src/index.ts\`

**Fix**: Add structured error fields.`;

    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: narrative,
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].rule).toBe("Use the Logging Library (Rule 1)");
    expect(result.issues[0].severity).toBe("medium");
    expect(result.issues[0].files).toEqual(["src/index.ts"]);
    expect(result.issues[1].severity).toBe("high");
    expect(result.issues[1].files).toEqual(["src/logging.ts", "src/index.ts"]);
  });

  test("returns empty issues for successful CLI envelope with no extractable issues", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: false,
      result: "I reviewed the code and found no issues to report.",
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toEqual([]);
  });

  test("throws ParseError for unrecognized envelope structure", () => {
    expect(() => parseCliOutput(JSON.stringify({ foo: "bar" }))).toThrow(
      ParseError,
    );
  });

  test("handles .result string with 'findings' key instead of 'issues'", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Audit complete:\n\n\`\`\`json\n${JSON.stringify({ findings: [] })}\n\`\`\``,
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toEqual([]);
  });

  test("handles .result string with 'violations' key instead of 'issues'", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Review results:\n\n\`\`\`json\n${JSON.stringify({ violations: [{ description: "test", rule: "R1", severity: "low", suggestion: "fix", policy: "p", files: ["a.ts"] }] })}\n\`\`\``,
    });
    const result = parseCliOutput(raw);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].rule).toBe("R1");
  });
});

describe("parseNarrativeIssues", () => {
  test("parses standard markdown issue format", () => {
    const text = `### Issue 1: Bad pattern
**Rule**: Rule A
**Severity**: low
**Policy**: my-policy
**Files**: \`a.ts\`

Some suggestion text.`;

    const issues = parseNarrativeIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toBe("Bad pattern");
    expect(issues[0].rule).toBe("Rule A");
    expect(issues[0].severity).toBe("low");
    expect(issues[0].policy).toBe("my-policy");
    expect(issues[0].files).toEqual(["a.ts"]);
  });

  test("parses multiple comma-separated files", () => {
    const text = `### Issue 1: Multi-file issue
**Rule**: R1
**Severity**: high
**Policy**: p
**Files**: \`a.ts\`, \`b.ts\`, \`c.ts\`

Fix it.`;

    const issues = parseNarrativeIssues(text);
    expect(issues[0].files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("defaults severity to medium for unknown values", () => {
    const text = `### Issue 1: Test
**Rule**: R
**Severity**: critical
**Policy**: p
**Files**: \`x.ts\``;

    const issues = parseNarrativeIssues(text);
    expect(issues[0].severity).toBe("medium");
  });

  test("returns empty array for non-issue text", () => {
    const issues = parseNarrativeIssues("No issues found. Good job!");
    expect(issues).toEqual([]);
  });
});
