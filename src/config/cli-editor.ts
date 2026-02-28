// ============================================================================
// Interactive terminal wizard for editing audit.conf
// ============================================================================

import { createInterface } from "readline";
import {
  CONFIG_FIELDS,
  MODEL_OPTIONS,
  readConfig,
  writeConfig,
  type ConfigField,
} from "./editor";
import { log } from "../logging";

function createRl() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: ReturnType<typeof createRl>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function promptField(
  rl: ReturnType<typeof createRl>,
  field: ConfigField,
  currentValue: unknown,
): Promise<unknown> {
  const defaultDisplay =
    field.type === "string[]"
      ? (currentValue as string[]).join(", ") || "(empty)"
      : field.type === "boolean"
        ? (currentValue as boolean)
          ? "Y"
          : "N"
        : String(currentValue || "(empty)");

  switch (field.type) {
    case "model": {
      const current = currentValue as string;
      const opts = MODEL_OPTIONS.map((m, i) => {
        const marker = m === current ? " *" : "";
        return `${i + 1}) ${m}${marker}`;
      });
      const defaultIdx = MODEL_OPTIONS.indexOf(current) + 1 || 1;
      const input = await ask(
        rl,
        `  ${field.label} (${opts.join("  ")}) [${defaultIdx}]: `,
      );
      if (!input) return current;
      const idx = parseInt(input, 10);
      if (idx >= 1 && idx <= MODEL_OPTIONS.length)
        return MODEL_OPTIONS[idx - 1]!;
      if (MODEL_OPTIONS.includes(input)) return input;
      return current;
    }

    case "enum": {
      const current = currentValue as string;
      const options = field.options ?? [];
      const input = await ask(
        rl,
        `  ${field.label} (${options.join("/")}) [${current}]: `,
      );
      if (!input) return current;
      if (options.includes(input)) return input;
      return current;
    }

    case "boolean": {
      const current = currentValue as boolean;
      const input = await ask(
        rl,
        `  ${field.label}? (y/N) [${defaultDisplay}]: `,
      );
      if (!input) return current;
      return input.toLowerCase() === "y" || input.toLowerCase() === "yes";
    }

    case "number": {
      const current = currentValue as number;
      const input = await ask(rl, `  ${field.label} [${current}]: `);
      if (!input) return current;
      const n = parseInt(input, 10);
      return isNaN(n) ? current : n;
    }

    case "string[]": {
      const current = currentValue as string[];
      const input = await ask(
        rl,
        `  ${field.label} (comma-separated) [${defaultDisplay}]: `,
      );
      if (!input) return current;
      return input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    case "string":
    default: {
      const current = currentValue as string;
      const input = await ask(rl, `  ${field.label} [${defaultDisplay}]: `);
      if (!input) return current;
      return input;
    }
  }
}

export async function runCliConfig(auditDir: string): Promise<void> {
  const values = readConfig(auditDir);
  const rl = createRl();

  console.log("");
  console.log("SIGMA Configuration");
  console.log("====================");
  console.log("");
  console.log("  Tip: Run `bun config --ui` to edit in the browser instead.");
  console.log(
    "  Tip: Delete audit.conf to restore defaults from audit.conf.default.",
  );

  const sections: Array<{ key: ConfigField["section"]; header: string }> = [
    { key: "paths", header: "Paths" },
    { key: "limits", header: "Limits" },
    { key: "models", header: "Models" },
    { key: "defaults", header: "Default Behavior" },
  ];

  // Special handling for PROJECT_ROOT
  console.log("");
  console.log("--- Project Setup ---");
  const currentRoot = values.PROJECT_ROOT as string;

  let rootChoice: string;
  if (currentRoot === "" || currentRoot === undefined) {
    rootChoice = "1";
  } else if (currentRoot === "./") {
    rootChoice = "2";
  } else {
    rootChoice = "3";
  }

  console.log("  What do you want to audit?");
  console.log("    1) Parent directory (auto-detect)");
  console.log("    2) This directory (./) — audit SIGMA itself");
  console.log("    3) Custom path");
  const rootInput = await ask(rl, `  Select [${rootChoice}]: `);
  const selection = rootInput || rootChoice;

  if (selection === "1") {
    values.PROJECT_ROOT = "";
  } else if (selection === "2") {
    values.PROJECT_ROOT = "./";
  } else if (selection === "3") {
    const customPath = await ask(rl, `  Custom path [${currentRoot}]: `);
    values.PROJECT_ROOT = customPath || currentRoot;
  }

  for (const section of sections) {
    const fields = CONFIG_FIELDS.filter((f) => f.section === section.key);
    // Skip PROJECT_ROOT since we already handled it
    const filteredFields = fields.filter((f) => f.key !== "PROJECT_ROOT");
    if (filteredFields.length === 0) continue;

    console.log("");
    console.log(`--- ${section.header} ---`);

    for (const field of filteredFields) {
      values[field.key] = (await promptField(rl, field, values[field.key])) as
        | string
        | string[]
        | number
        | boolean;
    }
  }

  // Summary
  console.log("");
  console.log("Summary:");
  for (const field of CONFIG_FIELDS) {
    const val = values[field.key];
    const display =
      field.type === "string[]"
        ? `(${(val as string[]).map((s) => `"${s}"`).join(" ")})`
        : field.type === "string" ||
            field.type === "model" ||
            field.type === "enum"
          ? `"${val}"`
          : String(val);
    console.log(`  ${field.key.padEnd(24)} = ${display}`);
  }

  console.log("");
  const confirm = await ask(rl, "Write to audit.conf? [Y/n]: ");
  rl.close();

  if (confirm.toLowerCase() === "n" || confirm.toLowerCase() === "no") {
    log.info("Configuration change cancelled.");
    return;
  }

  writeConfig(auditDir, values);
  log.info("Configuration saved to audit.conf.");
}
