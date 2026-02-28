import { describe, test, expect } from "bun:test";
import { parseCliOutput, ParseError } from "../../src/audit/cli-backend";

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

  test("throws ParseError for invalid JSON", () => {
    expect(() => parseCliOutput("not json")).toThrow(ParseError);
  });

  test("throws ParseError when no issues found", () => {
    expect(() => parseCliOutput(JSON.stringify({ foo: "bar" }))).toThrow(
      ParseError,
    );
  });
});
