# Logging Strategy Policy

Auditable rules extracted from the project's logging strategy (`docs/logging-strategy.md`).
Use these rules to evaluate whether code follows the structured "wide events" logging pattern.

---

## 1. Use the Logging Library

- **Client-side**: Use `useLogger()` from `@/lib/logging` — never raw `console.log/warn/error`.
- **Server-side**: Use `createServerLogger()` from `@/lib/logging/server`.
- Exception: Convex server functions may use `console.log(JSON.stringify({...}))` when the logging library is unavailable.

## 2. Event Naming Format

- Event names MUST use `domain.action` format (e.g., `reading.word.engagement`, `cdn.audio.fetch`).
- Valid domains: `reading`, `sync`, `orientation`, `cdn`, `auth`, `infra`, `web`.
- Sub-actions use dots: `orientation.connection.join`, `sync.learning.complete`.

## 3. Correlation IDs

- Every log event MUST include `readerId` and `sessionId` for correlation.
- Pass these through the logger constructor: `useLogger({ readerId })` or `createServerLogger({ readerId, sessionId })`.
- Never emit events without correlation context.

## 4. Never Log PII

- Never log emails, names, passwords, JWT tokens, API keys, credit card numbers, or SSNs.
- Use opaque IDs (`readerId`, `userId`, `sessionId`) instead of personally identifiable data.
- For content that may contain PII (e.g., audio text), log a hash instead: `text_hash` (first 16 chars of SHA-256).

## 5. Hash Sensitive Content

- When logging data derived from user content (audio text, reader input), use a truncated hash.
- Log `text_hash` and `text_length` instead of raw text.

## 6. Duration Fields

- All timing measurements MUST use `duration_ms` (milliseconds, numeric).
- Never log durations as strings or in other units.
- Related fields: `time_on_page_ms`, `response_time_ms`, `total_duration_ms`.

## 7. Wide Events Pattern

- Emit one rich event per operation with all relevant context attached.
- Do NOT scatter multiple `console.log` calls across an operation — gather context and emit a single structured event.
- Include both success and failure data in the same event schema.

## 8. Reliable Delivery for Session-End Events

- Use `navigator.sendBeacon('/api/log', payload)` for events that must be sent when the page closes.
- Applies to: `reading.session.end`, `orientation.session.end`.

## 9. Avoid High-Volume, Low-Value Events

- Do NOT log: every mouse move, every keystroke, heartbeat pings, successful health checks.
- Only log failures for health checks.
- Use metrics (not logs) for high-frequency signals.

## 10. Error Logging Structure

- When logging errors, use structured error fields: `error.type`, `error.message`, `error.code`.
- Include `error.retriable` (boolean) when applicable.
- Include stack traces only for unexpected errors.

## 11. Watch for Accidental PII Leaks

- Never log entire user objects (`console.log("User:", user)`).
- Never log raw request URLs (may contain tokens).
- Never log raw headers (contain auth tokens).
- Log only specific, sanitized fields.
