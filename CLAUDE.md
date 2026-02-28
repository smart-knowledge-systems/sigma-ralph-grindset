# CLAUDE.md

Policy-based code auditing and remediation system. TypeScript on Bun, uses Anthropic API (batch + single) and Claude CLI.

## Commands

```bash
bun check          # typecheck + lint
bun test           # all tests
bun format         # prettier
```

## Rules

- Do not read `.env` files
- `audit.conf.default` is the shipped config — never edit it. User overrides go in `audit.conf` (gitignored)
- `legacy/` is frozen Bash 3.2 code — do not modify unless explicitly asked
- Policies in `policies/` are auto-discovered; templates in `.policies/` are inactive until copied
- Portable mode: when this directory lacks `.git`, `PROJECT_ROOT` resolves to the parent. Override with `SIGMA_PROJECT_ROOT` env var
- Database is SQLite with WAL mode (`audit.db`). Schema is in `src/db.ts`

## Non-Obvious Architecture

- **Two audit backends**: `src/audit/cli-backend.ts` (spawns `claude --print`) and `src/audit/api-backend.ts` (Anthropic SDK with batch support). Config `DEFAULT_MODE` selects which
- **Structured output**: API backend uses `output_config.format` with JSON Schema (defined in `src/audit/schema.ts`). CLI backend passes the same schema via `--json-schema` flag but with an added `name` property at the top level
- **Branch splitting**: Large directories are recursively split until each "branch" is under `MAX_LOC` tokens. This happens before audit, not during
- **Fix executor**: `src/fixes/executor.ts` spawns Claude CLI in agentic mode (not `--print`) with file editing permissions and retry logic
