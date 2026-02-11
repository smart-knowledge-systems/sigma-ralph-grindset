# Shell Logging Strategy Policy

Auditable rules for structured, consistent logging in bash scripts.
Adapted from the project's logging strategy for the shell scripting context.

---

## 1. Use `log_*` Functions for Leveled Output

- **Preferred API**: Use `log_error`, `log_warn`, `log_info`, and `log_debug` from `logging.sh` (auto-sourced by `lib.sh`).
  - `log_error "msg"` — stderr, always shown, prefixed `[ERROR]`
  - `log_warn "msg"` — stderr, prefixed `[WARNING]`, hidden at `LOG_LEVEL=error`
  - `log_info "msg"` — stdout, no prefix (clean interactive output), hidden at `LOG_LEVEL=warn+`
  - `log_debug "msg"` — stderr, prefixed `[DEBUG]`, shown only at `LOG_LEVEL=debug`
- The low-level `err()` helper (stderr writer) remains available but `log_error`/`log_warn` are preferred for new code — they add level filtering, color, and optional timestamps.
- Never use bare `echo "ERROR: ..."` or `printf ... >&2` directly — use `log_error` or `err`.

## 2. Use `printf '%s\n'` for Standard Output

- All informational/progress output MUST use `printf '%s\n' "message"` — never bare `echo`.
- `printf` is POSIX-portable and avoids `echo` pitfalls (flag interpretation, backslash handling).
- For formatted output, use `printf` format strings: `printf '%-20s %d\n' "$label" "$count"`.

## 3. Separate stdout and stderr

- **stdout**: Operator-facing progress, summaries, and data output (consumed by pipes or humans).
- **stderr**: Errors, warnings, and diagnostic messages (via `err`).
- Never mix channels — a downstream consumer piping stdout should not receive error noise.

## 4. Structured Data Goes Through SQLite or JSON

- Metrics, audit results, and machine-readable output MUST go through SQLite (`db()`) or JSON (`jq`).
- Do NOT invent ad-hoc CSV/TSV formats or parse unstructured `printf` output for data interchange.
- Use `db -json` or `db -column -header` for structured query results.

## 5. Prefix Messages with Context

- Error messages MUST include enough context to identify the source: file path, branch name, policy, or operation.
- Good: `err "ERROR: policy file not found: ${policy_dir}/POLICY.md"`
- Bad: `err "file not found"`
- For multi-step operations, prefix with indentation or step labels to show nesting.

## 6. Use Consistent Severity Prefixes

- `log_error` and `log_warn` add `[ERROR]` and `[WARNING]` prefixes automatically — do not duplicate them in the message string.
- `log_info` has no prefix — context is clear from the output flow.
- `log_debug` adds `[DEBUG]` automatically.
- Do NOT invent other prefixes (e.g., `FATAL:`, `CRITICAL:`, `NOTICE:`).

## 7. Never Log Secrets or PII

- Never log API keys, tokens, passwords, or personally identifiable information.
- Never log full environment dumps (`env`, `printenv`, `set`) — they may contain secrets.
- Never log raw HTTP headers or full URLs with query parameters (may contain tokens).
- When logging file paths, ensure they don't leak user home directory structures unnecessarily.

## 8. Report Duration in Milliseconds or Seconds

- Timing measurements SHOULD use seconds for human-facing output and milliseconds for machine-readable data.
- Always include the unit: `elapsed: 42s`, `duration_ms: 42000`.
- Use `date +%s` (epoch seconds) for elapsed-time calculations; avoid `SECONDS` for cross-shell portability.

## 9. One Summary Per Operation

- At the end of a script or major phase, emit a single structured summary block — not scattered status lines.
- Summaries SHOULD include: operation name, counts (processed, succeeded, failed), and duration.
- Use section headers (`===`, `---`) to visually separate summaries from streaming output.

## 10. Progress Reporting for Long Operations

- Operations processing multiple items MUST report progress (e.g., `[3/10] Processing branch...`).
- Use `progress.sh` functions (`progress_step`, `progress_substep`) when available.
- When `progress.sh` is not sourced, fall back to inline `printf` with step counts.
- Progress output MUST degrade gracefully when stdout is not a TTY (no ANSI escape codes).

## 11. Exit Codes Reflect Outcome

- Exit `0` for success, non-zero for failure — no exceptions.
- Use distinct exit codes when a script has multiple failure modes (e.g., `1` for usage error, `2` for runtime failure).
- Never `exit 0` after logging an error — the exit code and the message must agree.

## 12. Trap Handlers Must Clean Up Quietly

- `trap` handlers for EXIT/INT/TERM SHOULD clean up resources (temp files, progress state, locks).
- Trap handlers SHOULD NOT emit noisy output on normal exit — only on unexpected termination.
- Always pair resource creation with a corresponding trap cleanup.
