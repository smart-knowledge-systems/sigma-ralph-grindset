# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Sigma Ralph Grindset (SIGMA) is a portable, policy-based code auditing and remediation system. It runs autonomous fix cycles ("ralph-loops") against any codebase using the `claude` CLI. The tool itself is a Bash-only codebase that audits shell scripts (or any configured file type) against policy documents, stores findings in SQLite, and applies fixes via Claude.

## Commands

```bash
# Lint (shellcheck)
bun check

# Format (shfmt, 4-space indent)
bun format

# Run all tests
bun test

# Run unit tests only
bun test:unit

# Run integration tests only (requires sqlite3)
bun test:integration

# Run a single test file
bats test/lib.bats

# Run a single test by name
bats test/lib.bats --filter "sql_escape"

# Full pipeline (generate branches → audit all policies → fix → checkpoint)
./run-all.sh

# Audit a single policy
./run-audit.sh bash-best-practices

# Audit multiple policies in one pass (fewer API calls)
./run-audit.sh bash-best-practices logging-strategy testing-philosophy

# Apply fixes from audit.db
./run-fixes.sh
```

## Architecture

### Pipeline Flow

`run-all.sh` orchestrates the full pipeline:
1. `generate-branches.sh` — scans `START_DIRS`, recursively splits directories until each "branch" is under `MAX_LOC`, writes `branches.txt`
2. `run-audit.sh <policy>` — for each branch, feeds file contents + policy to Claude via `--print` mode, parses structured JSON output, stores issues in `audit.db`
3. `run-fixes.sh` — batches pending issues by LOC, invokes Claude in agentic mode (`--permission-mode bypassPermissions`) to edit files, commits each batch
4. Records git commit checkpoints per policy for incremental mode

### Library Layering

- **`lib.sh`** — core shared library. Call `source lib.sh` then `init_paths` in every script. Provides: path resolution (`AUDIT_DIR`, `PROJECT_ROOT`), SQLite wrapper (`db`), file extension helpers, branch loading/matching, `sql_escape`, `truncate_for_db`, `count_loc`, `find_source_files`
- **`logging.sh`** — sourced automatically by `lib.sh`. Provides `log_debug`, `log_info`, `log_warn`, `log_error` with level filtering (`LOG_LEVEL` env var), color, optional timestamps
- **`lib-fixes.sh`** — extracted helpers for `run-fixes.sh`: file/LOC batching, issue querying, prompt construction
- **`progress.sh`** — ANSI scroll-region progress footer. Supports owner/child nesting (parent `run-all.sh` owns footer, child scripts use `progress_substep`)

### Configuration

`audit.conf` (sourced by `init_paths`) controls:
- `START_DIRS` — directories to scan
- `FILE_EXTENSIONS` — file types to audit (e.g., `"sh"`, `"ts tsx"`)
- `MAX_LOC` / `MAX_FIX_LOC` — LOC limits for branch splitting and fix batching
- `AUDIT_MODEL` / `FIX_MODEL` / `COMMIT_MODEL` — Claude model per stage

### Database Schema (audit.db, SQLite with WAL mode)

- **`scans`** — one row per branch+policy audit run (status, LOC, timestamps)
- **`files`** — unique file path registry
- **`issues`** — audit findings with severity, rule, suggestion, fix_status
- **`issue_files`** — many-to-many join (issue ↔ file)
- **`audit_checkpoints`** — per-policy git commit for incremental mode
- **`fix_attempts`** — tracks each fix batch attempt (created by `run-fixes.sh`)

### Policies

Active policies in `policies/<name>/POLICY.md` — auto-discovered by the pipeline. Portable templates in `.policies/` can be copied into `policies/` to activate.

### Portable Mode

When cloned into a subdirectory of another project, SIGMA detects that its own directory lacks `.git` and sets `PROJECT_ROOT` to the parent. Override with `SIGMA_PROJECT_ROOT` env var.

## Testing

Tests use [BATS](https://bats-core.readthedocs.io/) (Bash Automated Testing System) with bats-support, bats-assert, and bats-file helpers (cloned into `test/test_helper/`). Common setup in `test/test_helper/common-setup.bash` pre-sets globals and sources `lib.sh` so functions can be tested without calling `init_paths`.

- Unit tests (`test/lib.bats`, `test/lib-fixes.bats`, `test/logging.bats`) — test pure functions in isolation
- Integration tests (`test/database.bats`) — test SQLite schema creation and queries using temp databases

## Shell Scripting Conventions

This codebase targets **Bash 3.2** (macOS default). Key constraints:
- No associative arrays, `readarray`/`mapfile`, `${var,,}`, or negative array indices
- Use `printf '%s\n'` over `echo`; `[[ ]]` over `[ ]`
- All variables quoted; `local` in every function
- `shfmt` enforces 4-space indentation with `-ci` flag
- All scripts must pass `shellcheck` with zero warnings
