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
├── policies/               # Active policies (auto-discovered)
├── .policies/              # Portable policy templates (copy to activate)
├── audit.db                # SQLite database of scans, issues, fixes
└── CLAUDE.md               # Full architecture reference for AI assistants
```

## Policies

Policies live in `policies/<name>/POLICY.md`. Active policies for this repo:

- **`bash-best-practices`** — Shell scripting standards
- **`logging-strategy`** — Logging conventions
- **`testing-philosophy`** — Testing approach guidelines

Portable templates in `.policies/` (copy into `policies/` to use): `convex-conventions`, `legend-state-conventions`, `vercel-composition-patterns`, `vercel-react-best-practices`.

To add a policy: `mkdir policies/my-policy`, write `POLICY.md`, run `./run-audit.sh my-policy`.

## Using on Your Own Codebase

1. **Clone into a subdirectory** of your project:
   ```bash
   git clone <repo-url> audit/
   ```
2. **Create `audit.conf`** in your project root:
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

The tool auto-detects portable mode by checking for `.git` in its own directory. Override with `SIGMA_PROJECT_ROOT` env var if needed.

## About the Name

A system named after an incompetent character that actually embodies sophisticated, autonomous, sigma-energy self-improvement.

## Development

See `CLAUDE.md` for full architecture documentation, database schema, and implementation details.

---

*"Me fail English? That's unpossible."* — Ralph Wiggum
