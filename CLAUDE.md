# CLAUDE.md - Sigma Ralph Grindset

This file provides guidance to Claude Code and other AI assistants working with this repository.

## Project Overview

**Sigma Ralph Grindset** is a portable, policy-based code auditing and remediation system. It analyzes any codebase against configurable coding policies and applies automated fixes in batches ("ralph-loops"). It works as a self-contained tool (self-audit mode) or when cloned into another project's subdirectory (portable mode).

- **Scalable**: Divides codebases into logical branches and batches
- **Autonomous**: Runs audit-fix cycles without manual intervention
- **Incremental**: Only re-audits changed code on subsequent runs
- **Policy-driven**: Rules defined in markdown files in `policies/`

## Policy System

Policies are auto-discovered from `policies/` (relative to the tool directory). Convention: `policies/<policy-name>/POLICY.md` — folder name is the identifier (kebab-case), no config/frontmatter needed.

**Active Policies** (in `policies/`, auto-discovered):

| Policy              | Description                   |
| ------------------- | ----------------------------- |
| `bash-best-practices` | Shell scripting standards   |
| `logging-strategy`    | Logging conventions         |
| `testing-philosophy`  | Testing approach guidelines |

**Portable Templates** (in `.policies/`, not auto-discovered): `convex-conventions`, `legend-state-conventions`, `vercel-composition-patterns`, `vercel-react-best-practices`. Copy into `policies/` of your target project to activate.

**Adding a Policy**: `mkdir policies/my-policy`, create `policies/my-policy/POLICY.md`, run `./run-audit.sh my-policy`.

## Commands

**Prerequisites**: `claude` CLI installed and authenticated.

```bash
# Generate branches for auditing
./generate-branches.sh              # Full generation -> branches.txt
./generate-branches.sh --changed    # Also write branches-changed.txt (filtered)

# Audit a specific policy (incremental — only changed branches)
./run-audit.sh <policy-name>

# Full audit (all branches, ignores checkpoint)
./run-audit.sh --all <policy-name>

# Combined audit (multiple policies in one system prompt)
./run-audit.sh policy1 policy2 policy3
./run-audit.sh --max-loc 2000 policy1 policy2 policy3

# List available policies
./run-audit.sh

# Full pipeline
./run-all.sh                    # incremental
./run-all.sh --all              # full audit
./run-all.sh --combined         # combined mode (fewer API calls, max-loc=2000)
./run-all.sh --all --combined   # full combined audit

# Fix issues
./run-fixes.sh                              # Fix all pending issues
./run-fixes.sh logging-strategy             # Fix single policy
./run-fixes.sh --interactive                # Interactive Claude session
./run-fixes.sh --dangerously-skip-commits   # Fix without committing

# Verify branch coverage
./verify-branches.sh
```

**Database Inspection**:

```bash
sqlite3 audit.db "SELECT status, COUNT(*) FROM scans GROUP BY status;"
sqlite3 audit.db "SELECT severity, COUNT(*) FROM issues GROUP BY severity;"
sqlite3 audit.db "SELECT s.policy, COUNT(i.id) FROM scans s LEFT JOIN issues i ON i.scan_id = s.id GROUP BY s.policy;"
sqlite3 audit.db "SELECT f.path, COUNT(*) as count FROM issue_files jf JOIN files f ON jf.file_id = f.id GROUP BY f.path ORDER BY count DESC LIMIT 20;"
sqlite3 audit.db "SELECT * FROM audit_checkpoints;"
```

## Architecture Overview

### Branch System

The codebase is divided into **branches** — logical sections that group related files for review, processed independently by Claude CLI.

- **Recursive branches**: `"src/components/bookshop"` — scans all files recursively
- **Flat branches**: `"src/components (flat)"` — scans only immediate files (maxdepth=1)

The `(flat)` suffix enables mutually exclusive coverage: flat branch captures root-level files while subdirectories get their own recursive branches.

```
src/components/
├── layout.tsx          # "src/components (flat)"
├── bookshop/
│   └── catalog.tsx     # "src/components/bookshop"
└── ear-reader/
    └── reader.tsx      # "src/components/ear-reader"
```

Branches exceeding **MAX_LOC** (default 3000) are automatically split into batches (`[batch 1]`, `[batch 2]`, etc.), each processed separately.

### Shared Library (`lib.sh`)

Central library sourced by all scripts via `source "$(cd "$(dirname "$0")" && pwd)/lib.sh" && init_paths`.

**`init_paths()`** resolves paths and loads config:
- `AUDIT_DIR` — directory containing `lib.sh`
- `PROJECT_ROOT` — resolved via: (1) `SIGMA_PROJECT_ROOT` env var, (2) self-audit detection (`.git` in `AUDIT_DIR`), (3) default `AUDIT_DIR/..`
- `DB_PATH`, `BRANCHES_FILE`, `POLICIES_DIR` — derived from `AUDIT_DIR`
- `FILE_EXTENSIONS`, `START_DIRS` — defaults or loaded from `audit.conf`

**File extension helpers**:
- `build_find_ext_array()` — populates global `EXT_FIND_ARGS` array with find-compatible extension args
- `matches_extensions()` — checks if a filename matches `FILE_EXTENSIONS`
- `ext_to_lang()` — maps first extension to code fence language tag
- `ext_display_label()` — human-readable label (e.g., `.ts/.tsx`)

**Data helpers**:
- `db()` — SQLite wrapper with 5000ms busy timeout
- `sql_escape()` — escape single quotes for SQL
- `load_branches_for_matching()` / `file_to_branch()` — parse `branches.txt` and map files to branches via longest-prefix match

### Progress System (`progress.sh`)

Terminal progress tracking with ANSI scroll regions, background spinner, and nested process support. Sourced by `run-all.sh`, `run-audit.sh`, `run-fixes.sh`. Key functions: `progress_init`, `progress_total`, `progress_step`, `progress_set`, `progress_substep`, `progress_cleanup`. Becomes no-ops when stdout is not a TTY.

### Database Schema

SQLite with WAL mode for concurrent access. Init uses atomic `mkdir` lock for safety.

**`scans`**: One record per branch/batch/policy.
- `id`, `branch_path`, `policy`, `started_at`, `completed_at`, `status` (running/completed/failed/skipped), `file_count`, `total_loc`, `error_message`, `issue_count`
- In combined mode, `policy` stores pipe-separated label (e.g., `"policy1|policy2|policy3"`)

**`issues`**: Individual code quality issues.
- `id`, `scan_id` (FK → scans), `description`, `rule`, `severity` (high/medium/low), `suggestion`, `policy`, `created_at`, `fix_status` (pending/in_progress/fixed/failed/skipped), `fixed_at`
- `policy` stores the individual policy name per issue (critical for fix scoping, even in combined mode)

**`files`**: Unique file paths (`id`, `path`).

**`issue_files`**: Junction table (`issue_id`, `file_id`).

**`audit_checkpoints`**: Incremental audit tracking (`policy` PK, `git_commit`, `completed_at`).

**`fix_attempts`**: Fix batch tracking.
- `id`, `branch_path` (human-readable batch label), `attempt_number`, `started_at`, `completed_at`, `status` (running/success/check_failed/failed), `check_output`, `error_message`, `claude_output`

### Workflow

1. **Branch Generation** (`generate-branches.sh`):
   - Scans `START_DIRS`, splits directories until under MAX_LOC, outputs `branches.txt`
   - `--changed`: also writes `branches-changed.txt` filtered to branches with changes since oldest audit checkpoint

2. **Audit Execution** (`run-audit.sh`):
   - **Single-policy mode** (default MAX_LOC=3000): audits against one policy
   - **Combined mode** (multiple policy args): merges all policies into one system prompt; `--max-loc` overrides default (recommended 2000); Claude tags each issue with specific policy; `scans.policy` stores pipe-separated label, `issues.policy` stores individual name
   - **Incremental** (default): uses `audit_checkpoints` to find changed branches; **Full** (`--all`): audits all branches
   - Per branch: finds files, counts LOC, batches if needed, extracts imports, resolves path aliases, calls Claude CLI (model: Opus, max-turns: 100), validates JSON, inserts to DB
   - Supersedes stale pending issues before re-auditing each branch+policy

3. **Fix Execution** (`run-fixes.sh`):
   - Batches pending issue files under `MAX_FIX_LOC` (2000 lines), sorted by path
   - Per batch: queries `issues.policy` to scope system prompt to relevant policies only
   - Calls Claude (model: Opus 4.6) to fix; runs `bun check` + `bun format`; commits via Claude (model: Haiku)
   - `--dangerously-skip-commits`: apply fixes without committing
   - `--interactive`: opens Claude session without `--print`

4. **Full Pipeline** (`run-all.sh`):
   - Generates branches, runs audits (per-policy or `--combined`), runs fixes, records checkpoints

5. **Verification** (`verify-branches.sh`):
   - Checks every file appears in exactly one branch; reports duplicates and gaps

## Key Implementation Details

### Path Alias Resolution

The audit tool resolves TypeScript path aliases when extracting imports (hardcoded in `run-audit.sh:164-169` — edit for your project):

- `@/ear-reader/*` → `src/components/ear-reader/*`
- `@/convex/*` → `convex/*`
- `@/*` → `src/*`

### Claude CLI Integration

**Output Format**: JSON with strict schema validation:

```json
{
  "issues": [
    {
      "description": "String describing the problem",
      "rule": "Name of the violated rule",
      "severity": "high|medium|low",
      "suggestion": "Concrete fix suggestion",
      "policy": "policy-name",
      "files": ["path/to/file.tsx"]
    }
  ]
}
```

### Severity Mapping

- **high**: Performance problems, bugs, patterns that could break functionality
- **medium**: Maintainability issues, code smells, suboptimal patterns
- **low**: Style improvements, minor optimizations

## Configuration

### `audit.conf`

Optional file in the **project root**. Sourced by `init_paths()`:

```bash
START_DIRS=("src/components" "src/app" "src/lib")
FILE_EXTENSIONS="ts tsx"  # space-separated
```

Defaults: `FILE_EXTENSIONS="ts tsx"`, `START_DIRS` = common `src/` subdirectories.
This repo's `audit.conf`: `START_DIRS=(".")`, `FILE_EXTENSIONS="sh"`.

### Environment Variables

- `SIGMA_PROJECT_ROOT` — override auto-detected project root

### Constants

- `MAX_LOC=3000` in `run-audit.sh` (override with `--max-loc`; `--combined` auto-sets 2000)
- `MAX_FIX_LOC=2000` in `run-fixes.sh`

## Troubleshooting

### Branch Coverage Issues

Run `./generate-branches.sh` then `./verify-branches.sh` to confirm coverage.

### Claude CLI Errors

- **Authentication**: `claude login`
- **Rate limits**: Add sleep delays in `process_branch()`
- **JSON parse errors**: Check policy `POLICY.md` files exist

### Database Reset

```bash
rm audit.db && ./run-audit.sh <policy-name>  # Reinitializes schema
```

## Important Notes

- **Portable**: Configure `audit.conf` with `START_DIRS`/`FILE_EXTENSIONS`, or use TypeScript defaults
- **`run-audit.sh` is read-only** — never modifies source files
- **`run-fixes.sh` modifies source files** — use with version control
- `branches.txt` is the canonical full branch list; `branches-changed.txt` is the filtered subset
- `fix_attempts.branch_path` stores batch labels for display, not for joins
