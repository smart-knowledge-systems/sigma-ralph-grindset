#!/usr/bin/env bash
# ============================================================================
# Fix Helpers Library (lib-fixes.sh)
# ============================================================================
# Shared helper functions for run-fixes.sh: file/LOC batching, issue querying,
# and prompt construction. Extracted to keep run-fixes.sh under ~200 lines of
# core logic (bash best practices rule 30).
#
# Usage:
#   source "${AUDIT_DIR}/lib-fixes.sh"
#
# Requires: lib.sh sourced first (provides db, sql_escape, PROJECT_ROOT).
# ============================================================================

# Get distinct file paths from all pending issues, with LOC counts.
#
# Args:
#   $1 — SQL filter clause for optional policy scoping
#        (e.g., "AND s.policy = 'foo'"), or empty string for no filter
# Globals read: PROJECT_ROOT
# Output: "file_path|loc" per line, sorted by path.
get_fix_files_with_loc() {
    local policy_sql_filter="${1:-}"
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
            printf '%s\n' "${file_path}|0"
        fi
    done <<<"$file_paths"
}

# Greedily batch files by LOC. Files are already sorted by path (keeps
# related directories together).
#
# Input (stdin): "file_path|loc" per line
# Globals read: MAX_FIX_LOC
# Output: "batch_number|file_path" per line.
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
#
# Args:
#   $1 — newline-separated list of file paths
# Output: JSON array with fields: id, description, rule, severity,
#         suggestion, file_paths (pipe-separated).
get_issues_for_files() {
    local file_list="$1"

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

# Build the user prompt for a fix batch.
#
# Args:
#   $1 — newline-separated file paths
#   $2 — JSON array of issues (from get_issues_for_files)
# Output: the full prompt string to stdout.
build_fix_prompt() {
    local batch_files="$1"
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
