#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Fix Audit Issues Script
# ============================================================================
# Loops through code quality issues from audit.db (populated by run-audit.sh),
# batches affected files by LOC, and uses Claude to fix each batch.
# Commits each successful fix to a dedicated branch.
#
# Usage:
#   ./run-fixes.sh [policy-name]
#   ./run-fixes.sh --dangerously-skip-commits [policy-name]
#   ./run-fixes.sh -h|--help
# ============================================================================

# Shared library + path initialization
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
init_paths

# Validate required variables from lib.sh (Issue 1: Input Validation)
if [[ -z "${MAX_FIX_LOC-}" ]]; then
    log_error "MAX_FIX_LOC not set by lib.sh"
    exit 1
fi

# Configuration
MAX_RETRIES=3
# MAX_FIX_LOC is set by lib.sh init_paths (default 2000, overridable via audit.conf)
FIX_BRANCH="fix/audit-improvements"

# ---------------------------------------------------------------------------
# Usage / help
# ---------------------------------------------------------------------------
show_help() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS] [policy-name]

Fix audit issues from audit.db by batching affected files by LOC and
using Claude to apply fixes. Commits each successful fix.

Options:
  --interactive                Open Claude interactively (no --print)
  --dangerously-skip-commits   Skip git commits (fixes remain uncommitted)
  -h, --help                   Show this help message and exit

Arguments:
  policy-name   Optional policy name to scope fixes to a single policy

Examples:
  $(basename "$0")                              # Fix all pending issues
  $(basename "$0") --interactive                # Fix interactively via Claude
  $(basename "$0") logging-strategy             # Fix issues for one policy
  $(basename "$0") --dangerously-skip-commits   # Fix without committing
EOF
    exit 0
}

# Parse arguments
SKIP_COMMITS=false
INTERACTIVE=false
POLICY_FILTER=""
for arg in "$@"; do
    case "$arg" in
        -h | --help)
            show_help
            ;;
        --interactive)
            INTERACTIVE=true
            ;;
        --dangerously-skip-commits)
            SKIP_COMMITS=true
            ;;
        -*)
            log_error "Unknown flag: $arg"
            exit 1
            ;;
        *)
            POLICY_FILTER="$arg"
            ;;
    esac
done

if [[ -n "$POLICY_FILTER" ]]; then
    if [[ ! -f "${POLICIES_DIR}/${POLICY_FILTER}/POLICY.md" ]]; then
        log_error "Policy not found: ${POLICY_FILTER}"
        exit 1
    fi
    log_info "Filtering fixes to policy: ${POLICY_FILTER}"
fi

if [[ "$SKIP_COMMITS" == "true" ]]; then
    log_warn "--dangerously-skip-commits is set. Fixes will not be committed."
fi

# ============================================================================
# Git Setup
# ============================================================================

setup_git() {
    local current_branch
    current_branch=$(git -C "$PROJECT_ROOT" branch --show-current)

    if [[ "$current_branch" == "$FIX_BRANCH" ]]; then
        printf '%s\n' "Already on ${FIX_BRANCH}"
        return
    fi

    # Check for clean working tree
    if ! git -C "$PROJECT_ROOT" diff --quiet || ! git -C "$PROJECT_ROOT" diff --cached --quiet; then
        log_error "Working tree is not clean. Commit or stash changes first."
        exit 1
    fi

    # Create or switch to fix branch
    if git -C "$PROJECT_ROOT" show-ref --verify --quiet "refs/heads/${FIX_BRANCH}"; then
        git -C "$PROJECT_ROOT" checkout "$FIX_BRANCH"
    else
        git -C "$PROJECT_ROOT" checkout -b "$FIX_BRANCH"
    fi
}

# ============================================================================
# Schema Extensions
# ============================================================================

extend_schema() {
    # Add fix-tracking columns (idempotent — errors ignored if columns exist)
    db "ALTER TABLE issues ADD COLUMN fix_status TEXT DEFAULT 'pending' CHECK (fix_status IN ('pending', 'in_progress', 'fixed', 'failed', 'skipped'));" 2>/dev/null || true
    db "ALTER TABLE issues ADD COLUMN fixed_at TEXT;" 2>/dev/null || true

    # Track fix attempts per batch
    db <<'SQL'
CREATE TABLE IF NOT EXISTS fix_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_path TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'success', 'check_failed', 'failed')),
    check_output TEXT,
    error_message TEXT
);
SQL

    # Add claude_output column (idempotent — error ignored if column exists)
    db "ALTER TABLE fix_attempts ADD COLUMN claude_output TEXT;" 2>/dev/null || true
}

# ============================================================================
# LOC-Based Batching
# ============================================================================

# Get distinct file paths from all pending issues, with LOC counts.
# Arguments:
#   $1 - policy_sql_filter: SQL WHERE clause fragment for policy filtering (e.g., "AND s.policy = 'foo'")
# Output:
#   "file_path|loc" per line, sorted by path.
get_fix_files_with_loc() {
    local policy_sql_filter="$1"
    local file_paths
    file_paths=$(db "
        SELECT DISTINCT f.path
        FROM issues i
        JOIN issue_files jf ON jf.issue_id = i.id
        JOIN files f ON jf.file_id = f.id
        JOIN scans s ON i.scan_id = s.id
        WHERE i.fix_status = 'pending'
        ${policy_sql_filter}
        ORDER BY f.path;
    ")

    if [[ -z "$file_paths" ]]; then
        return
    fi

    while IFS= read -r file_path; do
        local full_path="${PROJECT_ROOT}/${file_path}"
        if [[ -f "$full_path" ]]; then
            local loc
            loc=$(wc -l <"$full_path" 2>/dev/null | tr -d ' ')
            printf '%s\n' "${file_path}|${loc}"
        else
            # File no longer exists — include with 0 LOC so issues still get processed
            log_warn "File no longer exists: ${file_path}"
            printf '%s\n' "${file_path}|0"
        fi
    done <<<"$file_paths"
}

# Greedily batch files by LOC. Files are already sorted by path (keeps
# related directories together). Output: "batch_number|file_path" per line.
batch_files_by_loc() {
    local batch_num=1
    local batch_loc=0

    while IFS='|' read -r file_path loc; do
        # Start a new batch if adding this file would exceed the limit
        # (but always put at least one file in a batch)
        if [[ $((batch_loc + loc)) -gt $MAX_FIX_LOC ]] && [[ $batch_loc -gt 0 ]]; then
            ((batch_num++))
            batch_loc=0
        fi
        printf '%s\n' "${batch_num}|${file_path}"
        batch_loc=$((batch_loc + loc))
    done
}

# Get pending issues that reference ANY of the given files.
# Arguments:
#   $1 - file_list: newline-separated list of file paths
#   $2 - policy_sql_filter: SQL WHERE clause fragment for policy filtering (e.g., "AND s.policy = 'foo'")
# Output:
#   JSON array to stdout with schema:
#   [{ id, description, rule, severity, suggestion, file_paths }, ...]
#   where file_paths is a pipe-separated string of file paths
get_issues_for_files() {
    local file_list="$1"
    local policy_sql_filter="$2"

    # Build SQL IN clause from file paths
    local in_clause=""
    while IFS= read -r fp; do
        [[ -z "$fp" ]] && continue
        if [[ -n "$in_clause" ]]; then
            in_clause="${in_clause},'$(sql_escape "$fp")'"
        else
            in_clause="'$(sql_escape "$fp")'"
        fi
    done <<<"$file_list"

    if [[ -z "$in_clause" ]]; then
        printf '%s\n' "[]"
        return
    fi

    # Find issue IDs that reference any of these files and are still pending
    local issue_ids
    issue_ids=$(db "
        SELECT DISTINCT i.id
        FROM issues i
        JOIN issue_files jf ON jf.issue_id = i.id
        JOIN files f ON jf.file_id = f.id
        WHERE i.fix_status = 'pending'
          AND f.path IN (${in_clause})
        ORDER BY i.id;
    " | paste -s -d, -)

    if [[ -z "$issue_ids" ]]; then
        printf '%s\n' "[]"
        return
    fi

    db -json "
        SELECT
            i.id,
            i.description,
            i.rule,
            i.severity,
            i.suggestion,
            GROUP_CONCAT(f.path, '|') as file_paths
        FROM issues i
        JOIN issue_files jf ON jf.issue_id = i.id
        JOIN files f ON jf.file_id = f.id
        WHERE i.id IN (${issue_ids})
          AND i.fix_status = 'pending'
        GROUP BY i.id
        ORDER BY
            CASE i.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
            i.id;
    "
}

# ============================================================================
# System Prompt
# ============================================================================

build_system_prompt() {
    local policies=("$@")
    SYSTEM_PROMPT_FILE=$(mktemp)

    cat >"$SYSTEM_PROMPT_FILE" <<'PROMPT'
You are refactoring React/Next.js components for readability and maintainability.
These components were built ad hoc, and need to be organized so a new team member
can quickly get up to speed.

RULES:
- Keep functionality identical — this is a readability refactor only
- Lean toward readability over cleverness
- Follow the coding guidelines below
- After making changes, use /check-and-fix to verify lint and type checks pass
PROMPT

    local policy_name
    local policy_file
    local policies_loaded=0
    for policy_name in "${policies[@]}"; do
        policy_file="${POLICIES_DIR}/${policy_name}/POLICY.md"
        if [[ ! -f "$policy_file" ]]; then
            log_warn "Policy file not found: ${policy_file}, skipping"
            continue
        fi
        if [[ ! -r "$policy_file" ]]; then
            log_warn "Policy file not readable: ${policy_file}, skipping"
            continue
        fi
        if [[ ! -s "$policy_file" ]]; then
            log_warn "Policy file is empty: ${policy_file}, skipping"
            continue
        fi
        printf '\n--- %s ---\n\n' "$policy_name" >>"$SYSTEM_PROMPT_FILE"
        cat "$policy_file" >>"$SYSTEM_PROMPT_FILE"
        ((policies_loaded++)) || true
    done

    if [[ $policies_loaded -eq 0 ]]; then
        log_error "No valid policy files loaded in build_system_prompt"
        rm -f "$SYSTEM_PROMPT_FILE"
        return 1
    fi
}

# Query distinct policies for a set of issue IDs (comma-separated)
get_policies_for_issues() {
    local issue_ids="$1"
    db "
        SELECT DISTINCT i.policy
        FROM issues i
        WHERE i.id IN (${issue_ids})
          AND i.policy != '';
    "
}

# ============================================================================
# Build Fix Prompt
# ============================================================================

# Constructs a formatted prompt string for Claude to fix code quality issues.
# Arguments:
#   $1 - batch_files: newline-separated file paths
#   $2 - issues_json: JSON array with schema [{ id, description, rule, severity,
#        suggestion, file_paths }, ...] where file_paths is pipe-separated
# Output:
#   Formatted prompt string to stdout (contains embedded newlines via printf %b)
build_fix_prompt() {
    local batch_files="$1" # newline-separated file paths
    local issues_json="$2"

    local prompt="I need you to fix the following code quality issues in these files:\n\n"
    prompt+="## Affected Files\n\n"

    while IFS= read -r fp; do
        [[ -z "$fp" ]] && continue
        prompt+="- \`${fp}\`\n"
    done <<<"$batch_files"

    prompt+="\n## Issues to Address\n\n"

    local issue_num=0
    while IFS= read -r issue; do
        ((issue_num++)) || true
        local description severity rule suggestion file_paths
        description=$(printf '%s\n' "$issue" | jq -r '.description')
        severity=$(printf '%s\n' "$issue" | jq -r '.severity')
        rule=$(printf '%s\n' "$issue" | jq -r '.rule')
        suggestion=$(printf '%s\n' "$issue" | jq -r '.suggestion')
        file_paths=$(printf '%s\n' "$issue" | jq -r '.file_paths' | tr '|' '\n' | sort -u | sed 's/^/- /')

        prompt+="### Issue ${issue_num} (${severity}) — rule: ${rule}\n"
        prompt+="**Files:**\n${file_paths}\n"
        prompt+="**Problem:** ${description}\n"
        prompt+="**Suggestion:** ${suggestion}\n\n"
    done < <(printf '%s\n' "$issues_json" | jq -c '.[]')

    prompt+="## Instructions\n\n"
    prompt+="1. Read each affected file\n"
    prompt+="2. Fix the issues listed above\n"
    prompt+="3. Keep all existing functionality — this is a readability/maintainability refactor\n"
    prompt+="4. Organize code so a new team member can quickly understand it\n"
    prompt+="5. After all edits use /check-and-fix, then run \`bun format\`\n"

    printf '%b' "$prompt"
}

# ============================================================================
# Fix Batch
# ============================================================================

fix_batch() {
    local batch_label="$1"
    local prompt="$2"
    local issue_ids="$3" # comma-separated list
    local file_count="$4"
    local issue_count="$5"

    for attempt in $(seq 1 "$MAX_RETRIES"); do
        printf '%s\n' "  Attempt ${attempt}/${MAX_RETRIES}..."

        # Log attempt
        local attempt_id
        attempt_id=$(db "
            INSERT INTO fix_attempts (branch_path, attempt_number)
            VALUES ('$(sql_escape "$batch_label")', ${attempt});
            SELECT last_insert_rowid();
        ")

        # Mark issues as in_progress
        db "
            UPDATE issues SET fix_status = 'in_progress'
            WHERE id IN (${issue_ids});
        "

        # Run Claude fix agent
        local claude_output=""
        local claude_exit_code=0
        local claude_args=(
            --model "$FIX_MODEL"
            --permission-mode bypassPermissions
            --append-system-prompt "$(cat "$SYSTEM_PROMPT_FILE")"
        )
        if [[ "$INTERACTIVE" == "true" ]]; then
            # Interactive mode: run Claude directly (no --print, no capture)
            if ! printf '%s\n' "$prompt" | claude "${claude_args[@]}"; then
                claude_exit_code=$?
                log_error "Claude CLI failed for ${batch_label}: exit code ${claude_exit_code}"
            fi
        else
            # Print mode: capture output for DB storage
            claude_args+=(--print --no-session-persistence)
            if ! claude_output=$(printf '%s\n' "$prompt" | claude "${claude_args[@]}" 2>&1); then
                claude_exit_code=$?
                log_error "Claude CLI failed for ${batch_label}: exit code ${claude_exit_code}"
            fi
        fi

        # Store truncated Claude output in the database (empty in interactive mode).
        # Raw output may contain source code or PII from the audited codebase,
        # so we truncate to limit exposure. audit.db should be treated as confidential.
        local truncated_claude_output
        truncated_claude_output=$(truncate_for_db "$claude_output" 4000)
        db "
            UPDATE fix_attempts SET claude_output = '$(sql_escape "$truncated_claude_output")'
            WHERE id = ${attempt_id};
        "

        # Run bun check (Issue 3: Explicit return code checks)
        local check_output
        local check_exit=0
        if ! check_output=$(cd "$PROJECT_ROOT" && bun check 2>&1); then
            check_exit=$?
        fi

        if [[ "$check_exit" -eq 0 ]]; then
            printf '%s\n' "  bun check passed"

            # Format (Issue 3: Explicit return code checks)
            if ! (cd "$PROJECT_ROOT" && bun format); then
                log_error "bun format failed for ${batch_label}"
                return 1
            fi

            # Commit via Claude (skip when --dangerously-skip-commits is set)
            if [[ "$SKIP_COMMITS" != "true" ]]; then
                printf '%s\n' "Commit the staged and unstaged changes. These are fixes for audit issues: \
${batch_label} (${file_count} files, ${issue_count} issues) based on project coding guidelines. \
Use /git-commit-manager" | claude \
                    --print \
                    --no-session-persistence \
                    --model "$COMMIT_MODEL" \
                    --permission-mode bypassPermissions
            else
                printf '%s\n' "  Skipping commit (--dangerously-skip-commits)"
            fi

            # Mark issues as fixed
            db "
                UPDATE issues SET fix_status = 'fixed',
                    fixed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id IN (${issue_ids});
            "

            # Log success
            db "
                UPDATE fix_attempts SET status = 'success',
                    completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ${attempt_id};
            "
            return 0
        else
            # Issue 7: Log diagnostic output for bun check failures
            log_warn "bun check failed (attempt ${attempt}/${MAX_RETRIES}):"
            printf '%s\n' "$check_output" >&2

            # Log failure with truncated output (build tool output may leak
            # env vars or infrastructure paths, so limit what we persist)
            local truncated_check_output
            truncated_check_output=$(truncate_for_db "$check_output" 4000)
            local escaped_output
            escaped_output=$(sql_escape "$truncated_check_output")
            db "
                UPDATE fix_attempts SET status = 'check_failed',
                    completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    check_output = '${escaped_output}'
                WHERE id = ${attempt_id};
            "

            # On last attempt, revert and mark failed
            if [[ "$attempt" -eq "$MAX_RETRIES" ]]; then
                if [[ "$SKIP_COMMITS" != "true" ]]; then
                    log_error "All retries exhausted. Reverting changes for ${batch_label}."
                    git -C "$PROJECT_ROOT" checkout -- .
                else
                    log_error "All retries exhausted. Skipping revert (--dangerously-skip-commits). Failed changes remain in working tree."
                fi
                db "
                    UPDATE issues SET fix_status = 'failed'
                    WHERE id IN (${issue_ids});
                "
                return 1
            fi
            # Otherwise loop continues — next Claude call sees current file state
        fi
    done
}

# ============================================================================
# Summary
# ============================================================================

print_summary() {
    local fixed="$1"
    local failed="$2"

    printf '%s\n' "=== FIX SUMMARY ==="
    printf '%s\n' "Batches fixed: ${fixed}"
    printf '%s\n' "Batches failed: ${failed}"
    printf '%s\n' ""

    db -header -column "
        SELECT fix_status, COUNT(*) as count
        FROM issues
        GROUP BY fix_status;
    "

    printf '%s\n' ""
    printf '%s\n' "Fix attempts:"
    db -header -column "
        SELECT branch_path, attempt_number, status
        FROM fix_attempts
        ORDER BY id;
    "
}

# ============================================================================
# Main
# ============================================================================

main() {
    printf '%s\n' "=== Fix Audit Issues ==="
    printf '%s\n' ""

    # Preflight checks
    if [[ ! -f "$DB_PATH" ]]; then
        log_error "audit.db not found. Run run-audit.sh first."
        exit 1
    fi

    if ! command -v claude &>/dev/null; then
        log_error "claude CLI not found. Install and authenticate first."
        exit 1
    fi

    # Git setup (skip when --dangerously-skip-commits is set)
    if [[ "$SKIP_COMMITS" != "true" ]]; then
        setup_git
    fi

    # Extend DB schema for fix tracking
    extend_schema

    # Load branch definitions (needed by lib.sh for file_to_branch, unused here
    # but required by the shared library contract)
    load_branches_for_matching

    # Progress footer
    source "${AUDIT_DIR}/progress.sh"
    progress_init

    # SYSTEM_PROMPT_FILE is set per-batch in the loop below
    SYSTEM_PROMPT_FILE=""
    if progress_is_owner; then
        trap 'progress_cleanup; rm -f "$SYSTEM_PROMPT_FILE"' EXIT INT TERM
    else
        trap 'rm -f "$SYSTEM_PROMPT_FILE"' EXIT
    fi

    # Build SQL filter clause for optional policy scoping (used by get_fix_files_with_loc
    # and get_issues_for_files). Declared here to avoid global state.
    local POLICY_SQL_FILTER=""
    if [[ -n "$POLICY_FILTER" ]]; then
        POLICY_SQL_FILTER="AND s.policy = '$(sql_escape "$POLICY_FILTER")'"
    fi

    # --- Build LOC-based batches from pending issue files ---
    local files_with_loc
    files_with_loc=$(get_fix_files_with_loc "$POLICY_SQL_FILTER")

    if [[ -z "$files_with_loc" ]]; then
        printf '%s\n' "No pending issues to fix."
        exit 0
    fi

    # Build batch assignments: "batch_number|file_path" per line
    local batch_assignments
    batch_assignments=$(printf '%s\n' "$files_with_loc" | batch_files_by_loc)

    # Determine total number of batches
    local total_batches
    total_batches=$(printf '%s\n' "$batch_assignments" | cut -d'|' -f1 | sort -un | tail -1)

    # Count total pending issues
    local total_pending_issues
    total_pending_issues=$(db "
        SELECT COUNT(*)
        FROM issues i
        JOIN scans s ON i.scan_id = s.id
        WHERE i.fix_status = 'pending'
        ${POLICY_SQL_FILTER};
    ")

    printf '%s\n' "Batches to fix: ${total_batches} (${total_pending_issues} issues, MAX_FIX_LOC=${MAX_FIX_LOC})"
    printf '%s\n' ""

    if progress_is_owner; then
        progress_total "$total_pending_issues"
        progress_unit "issues"
    fi

    local fixed=0
    local failed=0
    local issues_done=0

    for batch_num in $(seq 1 "$total_batches"); do
        # Collect files for this batch
        local batch_files=""
        local batch_file_count=0
        while IFS='|' read -r bnum file_path; do
            if [[ "$bnum" -eq "$batch_num" ]]; then
                if [[ -n "$batch_files" ]]; then
                    batch_files="${batch_files}"$'\n'"${file_path}"
                else
                    batch_files="${file_path}"
                fi
                ((batch_file_count++))
            fi
        done <<<"$batch_assignments"

        # Summarize directories for label
        local dir_summary
        dir_summary=$(printf '%s\n' "$batch_files" | sed 's|/[^/]*$||' | sort -u | head -3 | paste -s -d', ' -)
        local batch_label="batch ${batch_num}/${total_batches} (${dir_summary})"

        # Update progress footer
        if progress_is_owner; then
            progress_set "$issues_done" "Fixing: ${batch_label}"
        else
            progress_substep "$issues_done" "$total_pending_issues" "${batch_label}"
        fi
        printf '%s\n' "--------------------------------------"
        printf '%s\n' "Fixing: ${batch_label}"
        printf '%s\n' "  Files: ${batch_file_count}"

        # Get issues for the files in this batch (only still-pending ones)
        local issues_json
        issues_json=$(get_issues_for_files "$batch_files" "$POLICY_SQL_FILTER")

        local issue_ids
        issue_ids=$(printf '%s\n' "$issues_json" | jq -r '.[].id' 2>/dev/null | paste -s -d, -)

        if [[ -z "$issue_ids" ]]; then
            printf '%s\n' "  No pending issues remain for this batch (already processed). Skipping."
            printf '%s\n' ""
            continue
        fi

        local issue_count
        issue_count=$(printf '%s\n' "$issues_json" | jq length)
        printf '%s\n' "  Issues: ${issue_count}"

        # Query which policies these issues came from (deduplicated)
        local policies=()
        while IFS= read -r p; do
            [[ -n "$p" ]] && policies+=("$p")
        done < <(get_policies_for_issues "$issue_ids")

        if [[ ${#policies[@]} -gt 0 ]]; then
            printf '%s\n' "  Policies: ${policies[*]}"
        fi

        # Build system prompt scoped to relevant policies only.
        # build_system_prompt creates a new temp file via mktemp,
        # so we don't need to manually delete the old one here —
        # the EXIT trap handles cleanup.
        build_system_prompt "${policies[@]}"

        local prompt
        prompt=$(build_fix_prompt "$batch_files" "$issues_json")

        if fix_batch "$batch_label" "$prompt" "$issue_ids" "$batch_file_count" "$issue_count"; then
            fixed=$((fixed + 1))
        else
            failed=$((failed + 1))
        fi

        # Accumulate processed issues (both fixed and failed count as done)
        issues_done=$((issues_done + issue_count))
        if progress_is_owner; then
            progress_set "$issues_done" "Fixing: ${batch_label}"
        else
            progress_substep "$issues_done" "$total_pending_issues" "${batch_label}"
        fi

        printf '%s\n' ""
    done

    print_summary "$fixed" "$failed"
}

# Run main
main "$@"
