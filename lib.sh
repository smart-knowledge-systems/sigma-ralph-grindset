#!/usr/bin/env bash
# ============================================================================
# Shared Audit Library
# ============================================================================
# Common functions used by run-audit.sh, run-fixes.sh, and generate-branches.sh.
#
# Usage: source this file, then call init_paths.
#
#   source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
#   init_paths
#
# init_paths resolves AUDIT_DIR, PROJECT_ROOT, DB_PATH, BRANCHES_FILE,
# POLICIES_DIR, FILE_EXTENSIONS, and START_DIRS. It also sources
# ${AUDIT_DIR}/audit.conf if it exists.
#
# Portable mode detection:
#   1. SIGMA_PROJECT_ROOT env var → explicit override
#   2. Parent has .git → portable mode (PROJECT_ROOT = AUDIT_DIR/..)
#   3. AUDIT_DIR has .git → self-audit (PROJECT_ROOT = AUDIT_DIR)
#   4. Neither → portable mode fallback (AUDIT_DIR/..)
# Override: set SIGMA_PROJECT_ROOT env var before calling init_paths.
# ============================================================================

# ---------------------------------------------------------------------------
# Error output helper — low-level stderr writer. Prefer log_error/log_warn
# from logging.sh for new code (they add level filtering, color, timestamps).
# Usage: err "something went wrong"
# ---------------------------------------------------------------------------
err() { printf '%s\n' "$*" >&2; }

# Source logging library (provides log_debug, log_info, log_warn, log_error)
source "${BASH_SOURCE[0]%/*}/logging.sh"

# ---------------------------------------------------------------------------
# Path initialization — call once after sourcing
# ---------------------------------------------------------------------------
init_paths() {
    # AUDIT_DIR = directory containing this lib.sh (always correct)
    AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    # PROJECT_ROOT resolution:
    #   1. SIGMA_PROJECT_ROOT env var (explicit override)
    #   2. Parent has .git → portable mode (cloned into someone's project)
    #   3. AUDIT_DIR has .git → self-audit (standalone repo)
    #   4. Neither → portable mode fallback (AUDIT_DIR/..)
    local _sigma_mode=""
    if [[ -n "${SIGMA_PROJECT_ROOT:-}" ]]; then
        PROJECT_ROOT="$(cd "$SIGMA_PROJECT_ROOT" && pwd)"
        _sigma_mode="explicit"
    elif [[ -e "${AUDIT_DIR}/../.git" ]]; then
        # Parent has .git — we're inside someone else's repo (portable mode)
        PROJECT_ROOT="$(cd "${AUDIT_DIR}/.." && pwd)"
        _sigma_mode="portable"
    elif [[ -e "${AUDIT_DIR}/.git" ]]; then
        # Only our own .git exists — standalone self-audit
        PROJECT_ROOT="$AUDIT_DIR"
        _sigma_mode="self-audit"
    else
        PROJECT_ROOT="$(cd "${AUDIT_DIR}/.." && pwd)"
        _sigma_mode="portable-fallback"
    fi

    DB_PATH="${AUDIT_DIR}/audit.db"
    BRANCHES_FILE="${AUDIT_DIR}/branches.txt"
    POLICIES_DIR="${AUDIT_DIR}/policies"

    # Defaults (may be overridden by audit.conf)
    if [[ -z "${FILE_EXTENSIONS:-}" ]]; then
        FILE_EXTENSIONS="ts tsx"
    fi
    # LOC limits (overridable via audit.conf; run-audit.sh --max-loc still wins)
    : "${MAX_LOC:=3000}"
    : "${MAX_FIX_LOC:=2000}"
    # Claude model defaults (overridable via audit.conf)
    : "${AUDIT_MODEL:=haiku}"
    : "${FIX_MODEL:=sonnet}"
    : "${COMMIT_MODEL:=haiku}"
    # START_DIRS default is set after sourcing audit.conf (see below)

    # Source config from AUDIT_DIR (consumers configure where the tool lives)
    if [[ -f "${AUDIT_DIR}/audit.conf" ]]; then
        # shellcheck source=/dev/null
        source "${AUDIT_DIR}/audit.conf"
    fi

    # Default START_DIRS if not set by audit.conf or caller
    if [[ -z "${START_DIRS+x}" ]]; then
        START_DIRS=(
            "src/components"
            "src/app"
            "src/lib"
            "src/backend"
            "src/frontend"
            "src/providers"
        )
    fi

    export AUDIT_DIR PROJECT_ROOT DB_PATH BRANCHES_FILE POLICIES_DIR FILE_EXTENSIONS
    export MAX_LOC MAX_FIX_LOC AUDIT_MODEL FIX_MODEL COMMIT_MODEL

    log_debug "init_paths: mode=${_sigma_mode} PROJECT_ROOT=${PROJECT_ROOT} AUDIT_DIR=${AUDIT_DIR}"
}

# ---------------------------------------------------------------------------
# File extension helpers
# ---------------------------------------------------------------------------

# Populate the global EXT_FIND_ARGS array with find-compatible extension args.
# Uses a global array for Bash 3.2 compatibility (no nameref support).
#
# Globals:
#   FILE_EXTENSIONS — space-separated list of extensions (read)
#   EXT_FIND_ARGS   — populated with find arguments (written)
#
# Usage:
#   build_find_ext_array
#   find "$dir" "${EXT_FIND_ARGS[@]}" -type f
EXT_FIND_ARGS=()
build_find_ext_array() {
    EXT_FIND_ARGS=("(")
    local first=1
    for ext in $FILE_EXTENSIONS; do
        if [[ $first -eq 1 ]]; then
            EXT_FIND_ARGS+=(-name "*.${ext}")
            first=0
        else
            EXT_FIND_ARGS+=(-o -name "*.${ext}")
        fi
    done
    EXT_FIND_ARGS+=(")")
}

# Check if a filename matches FILE_EXTENSIONS.
# Usage: if matches_extensions "foo.ts"; then ...
matches_extensions() {
    local filename="$1"
    for ext in $FILE_EXTENSIONS; do
        if [[ "$filename" == *".${ext}" ]]; then
            return 0
        fi
    done
    return 1
}

# Map the first file extension to a code fence language tag.
# Usage: lang=$(ext_to_lang)
ext_to_lang() {
    local first_ext="${FILE_EXTENSIONS%% *}"
    case "$first_ext" in
        ts | tsx) printf '%s\n' "typescript" ;;
        js | jsx) printf '%s\n' "javascript" ;;
        sh) printf '%s\n' "bash" ;;
        py) printf '%s\n' "python" ;;
        rb) printf '%s\n' "ruby" ;;
        go) printf '%s\n' "go" ;;
        rs) printf '%s\n' "rust" ;;
        *) printf '%s\n' "$first_ext" ;;
    esac
}

# Human-readable label for the configured extensions (e.g., ".ts/.tsx").
# Usage: ext_label=$(ext_display_label)
ext_display_label() {
    local label=""
    for ext in $FILE_EXTENSIONS; do
        if [[ -n "$label" ]]; then
            label="${label}/.${ext}"
        else
            label=".${ext}"
        fi
    done
    printf '%s\n' "$label"
}

# SQLite wrapper — sets a busy timeout so concurrent writers queue instead
# of failing with "database is locked". WAL mode is set once in init_database().
# .timeout is a dot-command that produces no output, safe for captured queries.
db() {
    sqlite3 -cmd ".timeout 5000" "$DB_PATH" "$@"
}

# Escape single quotes for SQL
sql_escape() {
    printf '%s\n' "$1" | sed "s/'/''/g"
}

# Truncate a string to a maximum character length for safe DB storage.
# Appends "... [truncated]" when the input exceeds the limit.
# Usage: truncate_for_db "$value" [max_chars]   (default: 4000)
truncate_for_db() {
    local value="$1"
    local max_chars="${2:-4000}"
    local len=${#value}
    if [[ $len -le $max_chars ]]; then
        printf '%s' "$value"
    else
        printf '%s' "${value:0:$max_chars}... [truncated]"
    fi
}

# ---------------------------------------------------------------------------
# Database initialization — creates schema and runs migrations (idempotent)
# ---------------------------------------------------------------------------

# Initialize the audit database schema.
# Creates tables: scans, files, issues, issue_files, audit_checkpoints.
# Runs idempotent migrations for fix tracking and policy columns.
# Uses a mkdir-based lock to serialize concurrent initialization.
#
# Globals:
#   DB_PATH — path to SQLite database (read)
init_database() {
    # Serialize init across concurrent processes using mkdir as an atomic lock
    local lockdir="${DB_PATH}.init.lock"
    local got_lock=""
    for _ in $(seq 1 100); do
        if mkdir "$lockdir" 2>/dev/null; then
            got_lock=1
            break
        fi
        sleep 0.1
    done
    if [[ -z "$got_lock" ]]; then
        log_warn "Could not acquire init lock after 10s, proceeding anyway"
    fi

    # Enable WAL mode once (persists across connections) for concurrent access
    sqlite3 -cmd ".timeout 5000" "$DB_PATH" "PRAGMA journal_mode=WAL;" >/dev/null

    db <<SQL
CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_path TEXT NOT NULL,
    policy TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
    file_count INTEGER,
    total_loc INTEGER,
    error_message TEXT,
    issue_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL REFERENCES scans(id),
    description TEXT NOT NULL,
    rule TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
    suggestion TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS issue_files (
    issue_id INTEGER NOT NULL REFERENCES issues(id),
    file_id INTEGER NOT NULL REFERENCES files(id),
    PRIMARY KEY (issue_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_issues_scan_id ON issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(rule);
CREATE INDEX IF NOT EXISTS idx_issue_files_file_id ON issue_files(file_id);

CREATE TABLE IF NOT EXISTS audit_checkpoints (
    policy TEXT PRIMARY KEY,
    git_commit TEXT NOT NULL,
    completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
SQL

    # Idempotent migration: add policy column if missing (for existing databases)
    db "ALTER TABLE scans ADD COLUMN policy TEXT NOT NULL DEFAULT '';" 2>/dev/null || true

    # Create index after migration ensures column exists
    db "CREATE INDEX IF NOT EXISTS idx_scans_policy ON scans(policy);"

    # Idempotent migration: add fix tracking columns (used by run-fixes.sh)
    db "ALTER TABLE issues ADD COLUMN fix_status TEXT DEFAULT 'pending';" 2>/dev/null || true
    db "ALTER TABLE issues ADD COLUMN fixed_at TEXT;" 2>/dev/null || true

    # Idempotent migration: add policy column to issues (for combined mode per-issue tracking)
    db "ALTER TABLE issues ADD COLUMN policy TEXT DEFAULT '';" 2>/dev/null || true

    # Release lock
    [[ -n "$got_lock" ]] && rmdir "$lockdir" 2>/dev/null
}

# ---------------------------------------------------------------------------
# File analysis helpers
# ---------------------------------------------------------------------------

# Count total LOC across one or more files.
# Args: file paths as positional arguments
# Output: line count to stdout
count_loc() {
    local files=("$@")
    if [[ ${#files[@]} -eq 0 ]]; then
        printf '%s\n' "0"
        return
    fi
    wc -l "${files[@]}" 2>/dev/null | tail -1 | awk '{print $1}'
}

# Find source files in a directory (respects FILE_EXTENSIONS).
# Args: $1 — directory path, $2 — "flat" for maxdepth 1 (optional)
# Output: one file path per line to stdout
find_source_files() {
    local dir="$1"
    local is_flat="${2:-}"
    build_find_ext_array

    if [[ "$is_flat" == "flat" ]]; then
        find "$dir" -maxdepth 1 "${EXT_FIND_ARGS[@]}" -type f 2>/dev/null || true
    else
        find "$dir" "${EXT_FIND_ARGS[@]}" -type f 2>/dev/null || true
    fi
}

# Resolve TypeScript import path aliases to real paths.
# Handles @/convex/*, @/* aliases.
# Args: $1 — import path
# Output: resolved path to stdout (empty if external package)
resolve_alias() {
    local import_path="$1"

    # Skip external packages
    if [[ ! "$import_path" =~ ^[@./] ]]; then
        printf '%s\n' ""
        return
    fi

    # Resolve path aliases
    if [[ "$import_path" =~ ^@/convex/ ]]; then
        printf '%s\n' "${import_path/@\/convex/convex}"
    elif [[ "$import_path" =~ ^@/ ]]; then
        printf '%s\n' "${import_path/@\//src/}"
    else
        printf '%s\n' "$import_path"
    fi
}

# Extract and resolve import paths from a source file.
# Args: $1 — file path
# Output: deduplicated resolved import paths, one per line to stdout
extract_imports() {
    local file="$1"
    local imports=()

    while IFS= read -r line; do
        # Extract the "from 'path'" part
        if [[ "$line" =~ from[[:space:]]+[\'\"]([@./][^\'\"]+) ]]; then
            local import_path="${BASH_REMATCH[1]}"
            local resolved
            resolved=$(resolve_alias "$import_path")
            if [[ -n "$resolved" ]]; then
                imports+=("$resolved")
            fi
        fi
    done < <(grep -E '^\s*(import|export)\s.*\sfrom\s' "$file" 2>/dev/null || true)

    # Deduplicate
    if [[ ${#imports[@]} -gt 0 ]]; then
        printf '%s\n' "${imports[@]}" | sort -u
    fi
}

# ---------------------------------------------------------------------------
# Branch loading — populates parallel arrays from branches.txt
# ---------------------------------------------------------------------------
declare -a LIB_BRANCH_ENTRIES=() # raw entries (e.g., "src/components (flat)")
declare -a LIB_BRANCH_PATHS=()   # cleaned paths (e.g., "src/components")
declare -a LIB_BRANCH_IS_FLAT=() # "1" if flat, "" otherwise

load_branches_for_matching() {
    if [[ ! -f "$BRANCHES_FILE" ]]; then
        log_error "${BRANCHES_FILE} not found. Run generate-branches.sh first."
        exit 1
    fi
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        LIB_BRANCH_ENTRIES+=("$line")
        if [[ "$line" =~ ^(.*)[[:space:]]\(flat\)$ ]]; then
            LIB_BRANCH_PATHS+=("${BASH_REMATCH[1]}")
            LIB_BRANCH_IS_FLAT+=("1")
        else
            LIB_BRANCH_PATHS+=("$line")
            LIB_BRANCH_IS_FLAT+=("")
        fi
    done <"$BRANCHES_FILE"
}

# ---------------------------------------------------------------------------
# Map a file path to its home branch (cleaned path, no "(flat)" suffix).
# Uses longest-prefix match. Respects flat vs recursive semantics.
# ---------------------------------------------------------------------------
file_to_branch() {
    local file_path="$1"
    local best_match=""
    local best_len=0

    for i in "${!LIB_BRANCH_PATHS[@]}"; do
        local bp="${LIB_BRANCH_PATHS[$i]}"
        local is_flat="${LIB_BRANCH_IS_FLAT[$i]}"

        if [[ "$bp" == "." ]]; then
            # Root branch: all files live under "."
            if [[ -n "$is_flat" ]] && [[ "$file_path" == *"/"* ]]; then
                continue
            fi
            # "." (length 1) loses to any longer prefix match
            if ((1 > best_len)); then
                best_match="."
                best_len=1
            fi
            continue
        fi

        # File must start with branch path + /
        if [[ "$file_path" != "${bp}/"* ]]; then
            continue
        fi

        # For flat branches, file must be directly in the directory (no extra /)
        if [[ -n "$is_flat" ]]; then
            local remainder="${file_path#"${bp}"/}"
            if [[ "$remainder" == *"/"* ]]; then
                continue
            fi
        fi

        # Longest prefix match wins (most specific branch)
        if [[ ${#bp} -gt $best_len ]]; then
            best_match="$bp"
            best_len=${#bp}
        fi
    done

    printf '%s\n' "$best_match"
}
