# Sigma Ralph Grindset

**S**ystematic **I**ssue **G**athering & **M**anagement **A**pproach — a portable, policy-based code auditing and remediation system that runs autonomous fix cycles ("ralph-loops") against any codebase.

## Quick Start

```bash
# Generate branch map of your codebase
./generate-branches.sh

# Audit against a policy
./run-audit.sh <policy-name>

# Apply fixes
./run-fixes.sh

# Or run the full pipeline (generate + audit all policies + fix)
./run-all.sh
```

Requires the `claude` CLI to be installed and authenticated.

## Project Structure

```
.
├── run-all.sh              # Full pipeline: generate + audit + fix
├── run-audit.sh            # Policy-based code auditing (read-only)
├── run-fixes.sh            # Automated fix application + commits
├── generate-branches.sh    # Divide codebase into auditable branches
├── verify-branches.sh      # Check branch coverage (no gaps/duplicates)
├── lib.sh                  # Shared library (paths, DB, extensions)
├── progress.sh             # Terminal progress bar with scroll regions
├── audit.conf              # Per-project config (START_DIRS, FILE_EXTENSIONS)
├── policies/               # Active policies (auto-discovered by pipeline)
├── .policies/              # Inactive policies (move to policies/ to activate)
├── audit.db                # SQLite database of scans, issues, fixes
└── CLAUDE.md               # Full architecture reference for AI assistants
```

## Policies

The pipeline auto-discovers and runs **only** policies in `policies/` (active). Inactive policies live in `.policies/` and are ignored until moved. Move policies between the two folders to activate or deactivate them.

**Active** (`policies/`):

- **`bash-best-practices`** — Shell scripting standards
- **`logging-strategy`** — Logging conventions
- **`testing-philosophy`** — Testing approach guidelines

**Inactive** (`.policies/` — move to `policies/` to activate):

- `convex-conventions`, `legend-state-conventions`, `vercel-composition-patterns`, `vercel-react-best-practices`

To add a new policy: `mkdir policies/my-policy`, write `POLICY.md`, run `./run-audit.sh my-policy`.

## Using on Your Own Codebase

1. **Clone into a subdirectory** of your project:
   ```bash
   git clone <repo-url> audit/
   ```
2. **Edit `audit/audit.conf`** to configure your project:
   ```bash
   START_DIRS=("src/components" "src/app" "src/lib")
   FILE_EXTENSIONS="ts tsx"
   ```
3. **Add or customize policies** in `audit/policies/` (or copy from `audit/.policies/`)
4. **Run**:
   ```bash
   ./audit/run-all.sh
   ```
5. **Review** the git diff and commit

The tool auto-detects portable mode by checking if the **parent directory** contains `.git`. When it does (i.e., `audit/` lives inside your repo), `PROJECT_ROOT` resolves to the parent project. When only `audit/.git` exists (standalone), it runs in self-audit mode. Override with `SIGMA_PROJECT_ROOT` env var for edge cases.

## About the Name

A system named after an incompetent character that actually embodies sophisticated, autonomous, sigma-energy self-improvement.

## Development

See `CLAUDE.md` for full architecture documentation, database schema, and implementation details.

---

_"Me fail English? That's unpossible."_ — Ralph Wiggum
