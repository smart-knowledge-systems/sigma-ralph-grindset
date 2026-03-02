// ============================================================================
// Dual-output logger: console + always-debug file logging to disk
// ============================================================================

import { mkdirSync, appendFileSync, existsSync, rmSync, renameSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { events } from "./events";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Optional structured metadata attached to log entries for structured logging. */
export type LogMeta = Record<string, unknown>;

const LEVEL_NUM: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[2;35m", // dim magenta — distinguishes from debug
  debug: "\x1b[2m",
  info: "",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

let logFilePath: string | null = null;
let logTmpDir: string | null = null;
let consoleLevel: number = LEVEL_NUM.info;
let errorCount = 0;

/**
 * Unique ID for the current pipeline run. Generated once at startup
 * so all log lines from a single invocation can be correlated.
 */
const runId: string = randomUUID();

// Wire up runId to the event bus so ALL events (not just log events)
// include the correlation ID automatically.
events.setRunId(runId);

function timestamp(): string {
  return new Date().toISOString();
}

/** Get the current run ID for correlation. */
export function getRunId(): string {
  return runId;
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

function isValidLogLevel(s: string): s is LogLevel {
  return s in LEVEL_NUM;
}

/** Set the console log level from env or explicit value. */
export function setLogLevel(level?: string): void {
  const raw = level ?? process.env.LOG_LEVEL ?? "info";
  consoleLevel = isValidLogLevel(raw) ? LEVEL_NUM[raw] : LEVEL_NUM.info;
}

/** Clean up log directory based on pipeline outcome. */
export function cleanupLogs(success: boolean, baseDir: string): string | null {
  if (!logTmpDir) return null;

  if (success && errorCount === 0) {
    try {
      rmSync(logTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    logFilePath = null;
    logTmpDir = null;
    return null;
  }

  // Treat as failure if pipeline "succeeded" but errors were logged
  if (success && errorCount > 0) {
    log.warn(
      `Pipeline reported success but ${errorCount} error(s) were logged — preserving logs`,
    );
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

function writeToFile(
  level: string,
  msg: string,
  ts: string,
  meta?: LogMeta,
): void {
  if (!logFilePath) return;
  try {
    let line = `[${ts}] [${runId.slice(0, 8)}] ${level} ${msg}`;
    if (meta && Object.keys(meta).length > 0) {
      line += ` ${JSON.stringify(meta)}`;
    }
    appendFileSync(logFilePath, line + "\n");
  } catch {
    // ignore file write errors
  }
}

/**
 * Sanitize a log message by redacting patterns that may contain PII or secrets.
 * Strips API keys, bearer tokens, emails, and authorization headers.
 */
function sanitize(msg: string): string {
  return (
    msg
      // Redact API keys and tokens (sk-..., key-..., etc.)
      .replace(
        /\b(sk|key|token|bearer|auth)[_-]?[A-Za-z0-9]{20,}\b/gi,
        "[credential redacted]",
      )
      // Redact email addresses
      .replace(
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[email redacted]",
      )
      // Redact Authorization headers
      .replace(/Authorization:\s*\S+/gi, "Authorization: [redacted]")
  );
}

// NOTE: This is a CLI tool — readerId/sessionId correlation IDs from the
// logging policy do not apply. A runId is generated at startup to tie all
// log lines from a single pipeline run together. The event bus also enriches
// every emitted event with runId automatically (see events.setRunId above).
function write(level: LogLevel, msg: string, meta?: LogMeta): void {
  const sanitized = sanitize(msg);

  // Capture timestamp once so the file log and event bus agree on timing
  const ts = timestamp();

  if (level === "error") errorCount++;

  // Always write to file at all levels including trace (includes structured metadata if present)
  writeToFile(`[${level.toUpperCase()}]`, sanitized, ts, meta);

  // Emit to event bus (runId is attached automatically by the bus)
  events.emit({
    type: "log",
    level,
    message: sanitized,
    timestamp: ts,
    runId,
    ...(meta ? { meta } : {}),
  });

  // Console output respects LOG_LEVEL (always human-readable strings)
  if (LEVEL_NUM[level] < consoleLevel) return;

  const color = LEVEL_COLORS[level];
  const prefix =
    level === "info" ? "" : `${color}[${level.toUpperCase()}]${RESET} `;

  if (
    level === "error" ||
    level === "warn" ||
    level === "debug" ||
    level === "trace"
  ) {
    process.stderr.write(`${prefix}${sanitized}\n`);
  } else {
    process.stdout.write(`${prefix}${sanitized}\n`);
  }
}

export const log = {
  trace: (msg: string, meta?: LogMeta) => write("trace", msg, meta),
  debug: (msg: string, meta?: LogMeta) => write("debug", msg, meta),
  info: (msg: string, meta?: LogMeta) => write("info", msg, meta),
  warn: (msg: string, meta?: LogMeta) => write("warn", msg, meta),
  error: (msg: string, meta?: LogMeta) => write("error", msg, meta),
};
