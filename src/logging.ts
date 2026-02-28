// ============================================================================
// Dual-output logger: console + always-debug file logging to disk
// ============================================================================

import { mkdirSync, appendFileSync, existsSync, rmSync, renameSync } from "fs";
import { resolve } from "path";
import { events } from "./events";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[2m",
  info: "",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

let logFilePath: string | null = null;
let logTmpDir: string | null = null;
let consoleLevel: number = LEVEL_NUM.info;

function timestamp(): string {
  return new Date().toISOString();
}

/** Initialize file logging. Creates ./logs/.tmp/ and opens a log file. */
export function initFileLogging(baseDir: string): void {
  logTmpDir = resolve(baseDir, "logs", ".tmp");
  mkdirSync(logTmpDir, { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "T")
    .slice(0, 15);
  logFilePath = resolve(logTmpDir, `run-${ts}.log`);
}

/** Set the console log level from env or explicit value. */
export function setLogLevel(level?: string): void {
  const resolved = (level ?? process.env.LOG_LEVEL ?? "info") as LogLevel;
  consoleLevel = LEVEL_NUM[resolved] ?? LEVEL_NUM.info;
}

/** Clean up log directory based on pipeline outcome. */
export function cleanupLogs(success: boolean, baseDir: string): string | null {
  if (!logTmpDir) return null;

  if (success) {
    try {
      rmSync(logTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    logFilePath = null;
    logTmpDir = null;
    return null;
  }

  // On failure, move .tmp/ to failed-TIMESTAMP/
  if (existsSync(logTmpDir)) {
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "")
      .replace("T", "T")
      .slice(0, 15);
    const failedDir = resolve(baseDir, "logs", `failed-${ts}`);
    try {
      renameSync(logTmpDir, failedDir);
      logFilePath = null;
      logTmpDir = null;
      return failedDir;
    } catch {
      // ignore
    }
  }

  logFilePath = null;
  logTmpDir = null;
  return null;
}

function writeToFile(level: string, msg: string, ts: string): void {
  if (!logFilePath) return;
  try {
    appendFileSync(logFilePath, `[${ts}] ${level} ${msg}\n`);
  } catch {
    // ignore file write errors
  }
}

// NOTE: This is a CLI tool — readerId/sessionId correlation IDs from the
// logging policy do not apply. Consider adding a runId (generated at startup)
// to tie all log lines from a single pipeline run together if needed.
function write(level: LogLevel, msg: string): void {
  // Capture timestamp once so the file log and event bus agree on timing
  const ts = timestamp();

  // Always write to file at debug level
  writeToFile(`[${level.toUpperCase()}]`, msg, ts);

  // Emit to event bus
  events.emit({ type: "log", level, message: msg, timestamp: ts });

  // Console output respects LOG_LEVEL
  if (LEVEL_NUM[level] < consoleLevel) return;

  const color = LEVEL_COLORS[level];
  const prefix =
    level === "info" ? "" : `${color}[${level.toUpperCase()}]${RESET} `;

  if (level === "error" || level === "warn" || level === "debug") {
    process.stderr.write(`${prefix}${msg}\n`);
  } else {
    process.stdout.write(`${prefix}${msg}\n`);
  }
}

export const log = {
  debug: (msg: string) => write("debug", msg),
  info: (msg: string) => write("info", msg),
  warn: (msg: string) => write("warn", msg),
  error: (msg: string) => write("error", msg),
};
