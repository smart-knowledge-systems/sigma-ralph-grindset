# Sigma Ralph Grindset

**S**ystematic **I**ssue **G**athering & **M**anagement **A**pproach — a portable, policy-based code auditing and remediation system that runs autonomous fix cycles ("ralph-loops") against any codebase.

## Quick Start

```bash
# Install dependencies
bun install

# Configure your project (interactive wizard)
bun config

# Generate branch map of your codebase
bun branches

# Audit against all active policies (uses Batch API by default)
bun audit

# Audit a specific policy
bun audit convex-conventions

# Apply fixes
bun fix

# Or run the full pipeline (generate + audit all policies + fix)
bun all
```

## Running from Your Project Root

When SIGMA is cloned into a subdirectory (e.g., `audit/`), run commands from the parent project:

```bash
# All commands work with --cwd pointing to the audit directory
bun --cwd audit install
bun --cwd audit config
bun --cwd audit branches
bun --cwd audit audit
bun --cwd audit fix
bun --cwd audit all

# Or cd into the directory
cd audit && bun audit && cd ..
```

SIGMA auto-detects portable mode: when the parent directory has `.git`, `PROJECT_ROOT` resolves to the parent project. Override with `SIGMA_PROJECT_ROOT` env var.

## Commands

| Command | Description |
|---|---|
| `bun audit [policies...]` | Run code quality audit |
| `bun fix [policy]` | Apply fixes from audit.db |
| `bun all` | Full pipeline: branches + audit + fix + checkpoint |
| `bun branches` | Generate branches.txt |
| `bun config` | Edit audit.conf interactively (terminal wizard) |
| `bun config --ui` | Edit audit.conf in the browser |

### Audit Options

| Flag | Description |
|---|---|
| `--cli` | Use Claude CLI (`claude -p`) instead of Batch API |
| `--diff [ref]` | Audit only changed files |
| `--all` | Full audit (ignore checkpoints) |
| `--model <name>` | Override audit model |
| `--dry-run` | Show cost estimate, don't execute |
| `--max-loc <n>` | Override MAX_LOC |
| `--stdout` | Terminal-only output (no browser UI) |

### Fix Options

| Flag | Description |
|---|---|
| `--interactive` | Open Claude interactively |
| `--dangerously-skip-commits` | Skip git commits |

### API vs CLI Mode

By default, `bun audit` uses the **Batch API** (50% cheaper, requires `ANTHROPIC_API_KEY`). To use the Claude CLI instead:

```bash
# API mode (default) — requires ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY=sk-ant-...
bun audit

# CLI mode — requires `claude` CLI installed
bun audit --cli
```

Set `DEFAULT_MODE="cli"` in `audit.conf` (or via `bun config`) to make CLI the default.

## Configuration

Configuration uses two files:
- **`audit.conf.default`** — ships with the repo, do not edit
- **`audit.conf`** — your overrides (gitignored), created by `bun config`

Delete `audit.conf` to restore defaults. Run `bun config` for an interactive wizard:

```bash
# Key settings (in audit.conf.default, override via bun config)
PROJECT_ROOT=""              # empty = auto-detect (portable mode)
START_DIRS=("src")           # directories to scan
FILE_EXTENSIONS="ts tsx"     # file types to audit
MAX_LOC=3000                 # branch splitting threshold
AUDIT_MODEL="haiku"          # model for code review
DEFAULT_MODE="api"           # "api" or "cli"
DEFAULT_DIFF=false           # --diff by default
```

All CLI flags have corresponding `DEFAULT_*` config overrides so you don't have to type flags every time. CLI flags always take precedence over config defaults.

## Project Structure

```
.
├── src/                    # TypeScript source
│   ├── index.ts            # CLI entry point
│   ├── config.ts           # Config loader (audit.conf.default + audit.conf)
│   ├── config/             # Config editor (CLI wizard + browser UI)
│   ├── audit/              # Audit pipeline (CLI + API backends)
│   ├── fixes/              # Fix pipeline (batching, execution)
│   ├── branches/           # Branch scanning and generation
│   ├── pipeline/           # Full pipeline orchestrator
│   ├── ui/                 # React progress + config UIs
│   ├── db.ts               # SQLite wrapper
│   ├── logging.ts          # Dual-output logger
│   ├── pricing.ts          # Cost estimation
│   └── server.ts           # Progress UI server (SSE)
├── legacy/                 # Original Bash implementation
├── policies/               # Active policies (auto-discovered)
├── .policies/              # Inactive policies (copy to policies/ to activate)
├── audit.conf.default      # Default configuration (do not edit)
├── audit.conf              # User overrides (gitignored, created by bun config)
├── audit.db                # SQLite database (scans, issues, fixes)
└── CLAUDE.md               # Full architecture reference
```

## Policies

The pipeline auto-discovers and runs **only** policies in `policies/` (active). Inactive policies live in `.policies/` and are ignored until moved.

To add a new policy: `mkdir policies/my-policy`, write `POLICY.md`, run `bun audit my-policy`.

## Using on Your Own Codebase

1. **Clone into a subdirectory** of your project:
   ```bash
   git clone <repo-url> audit/
   cd audit && bun install
   ```
2. **Configure** your project:
   ```bash
   bun config
   # or edit audit.conf directly
   ```
3. **Add or customize policies** in `policies/` (or copy from `.policies/`)
4. **Run** from your project root:
   ```bash
   bun --cwd audit all
   ```
5. **Review** the git diff and commit

## Development

```bash
bun check       # TypeScript type check + lint
bun test        # Run all tests
bun test:unit   # Run unit tests only
```

See `CLAUDE.md` for full architecture documentation, database schema, and implementation details.

---

_"Me fail English? That's unpossible."_ — Ralph Wiggum
