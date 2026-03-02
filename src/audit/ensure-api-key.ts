// ============================================================================
// Ensure ANTHROPIC_API_KEY is available — prompts via CLI or browser UI
// ============================================================================

import { randomUUID } from "crypto";
import { log } from "../logging";
import { events } from "../events";

/**
 * In-memory ephemeral API key. Never written to process.env or disk.
 * Cleared after each audit via `clearEphemeralApiKey()`.
 */
let ephemeralKey: string | null = null;

/**
 * Return the active API key: environment variable first, then ephemeral.
 */
export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || ephemeralKey || undefined;
}

/**
 * Clear an ephemeral API key from memory.
 * Call this after the audit step completes so the key does not leak
 * into later pipeline stages or subsequent runs within the same process.
 */
export function clearEphemeralApiKey(): void {
  ephemeralKey = null;
}

/**
 * Check that an API key is available. If not, prompt the user to enter one
 * ephemerally (held in memory only — never set on process.env or written to disk).
 *
 * Dual input path: accepts a key via stdin (CLI) or via the event bus (browser
 * UI posting to `/api/apikey`). Mirrors the `waitForConfirmation()` pattern.
 *
 * Returns `true` if a key is now available, `false` if the user cancelled.
 */
export async function ensureApiKey(): Promise<boolean> {
  if (getApiKey()) return true;

  const requestId = randomUUID();

  log.warn("ANTHROPIC_API_KEY is not set.");
  log.warn("");
  log.warn(
    "  You can enter a key now (it will only be used for this session).",
  );
  log.warn("  Or set it in your environment:");
  log.warn("    export ANTHROPIC_API_KEY=<your-api-key>");
  log.warn("");

  events.emit({
    type: "infra.apikey.request",
    requestId,
    message:
      "ANTHROPIC_API_KEY is not set. Enter a key to continue (session-only, never written to disk).",
  });

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
    };

    // Browser path: listen for event bus response
    const unsub = events.on("infra.apikey.response", (e) => {
      if (e.requestId !== requestId) return;
      cleanup();
      unsub();
      try {
        process.stdin.removeAllListeners("data");
        process.stdin.pause();
      } catch {
        // ignore
      }
      if (e.apiKey) {
        ephemeralKey = e.apiKey;
        log.info("API key set for this session.");
        resolve(true);
      } else {
        log.info("API key entry cancelled.");
        resolve(false);
      }
    });

    // CLI path: prompt stdin
    process.stdout.write("API Key: ");
    const onData = (data: Buffer) => {
      if (resolved) return;
      const input = data.toString().trim();
      cleanup();
      unsub();
      try {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
      } catch {
        // ignore
      }

      if (!input || input.toLowerCase() === "cancel") {
        events.emit({
          type: "infra.apikey.response",
          requestId,
          apiKey: null,
        });
        log.info("API key entry cancelled.");
        resolve(false);
      } else {
        ephemeralKey = input;
        events.emit({
          type: "infra.apikey.response",
          requestId,
          apiKey: input,
        });
        log.info("API key set for this session.");
        resolve(true);
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
