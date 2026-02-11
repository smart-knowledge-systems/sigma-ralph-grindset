#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Full Audit Pipeline
# ============================================================================
# 1. Generate branches (writes branches.txt)
# 2. Run audit for each policy (incremental by default, --all for full)
# 3. Run fixes (reads audit.db, applies fixes, commits)
# 4. Record checkpoints for each policy
#
# Usage:
#   ./run-all.sh                  # Incremental audit + fix
#   ./run-all.sh --all            # Full audit (all branches) + fix
#   ./run-all.sh --combined       # Combined multi-policy mode
#   ./run-all.sh --all --combined # Full combined audit
#   ./run-all.sh -h|--help        # Show usage
# ============================================================================

# Shared library (db, sql_escape, etc.) + path initialization
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
init_paths

# ---------------------------------------------------------------------------
# Usage / help
# ---------------------------------------------------------------------------
show_help() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Run the full audit pipeline: generate branches, audit all policies,
fix issues, and record checkpoints.

Options:
  --all        Full audit (all branches, ignores checkpoints)
  --combined   Combined multi-policy mode (6x fewer API calls)
  -h, --help   Show this help message and exit

Examples:
  $(basename "$0")                  # Incremental audit
  $(basename "$0") --all            # Full audit (all branches)
  $(basename "$0") --combined       # Combined mode (fewer API calls)
  $(basename "$0") --all --combined # Full combined audit
EOF
    exit 0
}

# ============================================================================
# Main
# ============================================================================

main() {
    # Argument parsing: optional --all and --combined flags
    local -a audit_flags=()
    local combined_mode=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h | --help) show_help ;;
            --all)
                audit_flags+=("--all")
                shift
                ;;
            --combined)
                combined_mode=1
                shift
                ;;
            -*)
                log_error "Unknown flag: $1"
                exit 1
                ;;
            *)
                log_error "Unknown argument: $1"
                exit 1
                ;;
        esac
    done

    # Progress footer
    source "${AUDIT_DIR}/progress.sh"

    printf '%s\n' "=== Full Audit Pipeline ==="
    if [[ ${#audit_flags[@]} -gt 0 ]]; then
        printf '%s\n' "Mode: full audit (--all)"
    fi
    printf '%s\n' ""

    # Count policies for progress total
    local policy_count=0
    for pd in "${POLICIES_DIR}"/*/; do
        [[ -d "$pd" ]] && [[ -f "${pd}POLICY.md" ]] && ((policy_count++))
    done

    # Init progress: generate branches + N policies (or 1 combined) + fix + record checkpoints
    progress_init
    if [[ -n "$combined_mode" ]]; then
        progress_total $((1 + 1 + 1 + 1)) # generate + 1 combined audit + fix + checkpoints
    else
        progress_total $((1 + policy_count + 1 + 1))
    fi
    trap 'progress_cleanup' EXIT INT TERM

    # Step 1: Generate branches
    progress_title "Pipeline: Generate branches"
    progress_step "Generate branches"
    log_info "--- Step 1: Generate branches ---"
    bash "${AUDIT_DIR}/generate-branches.sh"
    printf '%s\n' ""

    # Capture HEAD commit for checkpoint recording (before any audits/fixes)
    local checkpoint_commit
    checkpoint_commit=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || true)

    # Step 2: Run audit for all policies (either combined or per-policy)
    if [[ -n "$combined_mode" ]]; then
        # Collect all policy names
        local -a all_policies=()
        for policy_dir in "${POLICIES_DIR}"/*/; do
            [[ ! -d "$policy_dir" ]] && continue
            local policy_name
            policy_name=$(basename "$policy_dir")
            [[ ! -f "${policy_dir}POLICY.md" ]] && continue
            all_policies+=("$policy_name")
        done

        progress_title "Pipeline: Audit combined (${#all_policies[@]} policies)"
        progress_step "Audit: combined"
        log_info "--- Step 2: Audit combined (${#all_policies[@]} policies) ---"
        if [[ ${#audit_flags[@]} -gt 0 ]]; then
            bash "${AUDIT_DIR}/run-audit.sh" "${audit_flags[@]}" --max-loc 2000 "${all_policies[@]}"
        else
            bash "${AUDIT_DIR}/run-audit.sh" --max-loc 2000 "${all_policies[@]}"
        fi
        printf '%s\n' ""
    else
        # Per-policy loop (existing behavior)
        local policy_idx=0
        for policy_dir in "${POLICIES_DIR}"/*/; do
            [[ ! -d "$policy_dir" ]] && continue
            local policy_name
            policy_name=$(basename "$policy_dir")
            [[ ! -f "${policy_dir}POLICY.md" ]] && continue

            ((policy_idx++))
            progress_title "Pipeline: Audit ${policy_name} (${policy_idx}/${policy_count})"
            progress_step "Audit: ${policy_name} (${policy_idx}/${policy_count})"
            log_info "--- Step 2: Audit policy: ${policy_name} (${policy_idx}/${policy_count}) ---"
            if [[ ${#audit_flags[@]} -gt 0 ]]; then
                bash "${AUDIT_DIR}/run-audit.sh" "${audit_flags[@]}" "$policy_name"
            else
                bash "${AUDIT_DIR}/run-audit.sh" "$policy_name"
            fi
            printf '%s\n' ""
        done
    fi

    # Step 3: Run fixes
    progress_title "Pipeline: Fix issues"
    progress_step "Fix issues"
    log_info "--- Step 3: Run fixes ---"
    bash "${AUDIT_DIR}/run-fixes.sh"
    printf '%s\n' ""

    # Step 4: Record checkpoints for each policy
    progress_title "Pipeline: Record checkpoints"
    progress_step "Record checkpoints"
    log_info "--- Step 4: Record audit checkpoints ---"

    # Ensure DB and checkpoint table exist (run-audit.sh init_database creates it,
    # but guard against edge cases where all policies were skipped)
    if [[ -z "$checkpoint_commit" ]]; then
        printf '%s\n' "  No git history — skipping checkpoint recording"
    elif [[ -f "$DB_PATH" ]]; then
        # Ensure the table exists
        db "CREATE TABLE IF NOT EXISTS audit_checkpoints (
            policy TEXT PRIMARY KEY,
            git_commit TEXT NOT NULL,
            completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );"

        for policy_dir in "${POLICIES_DIR}"/*/; do
            [[ ! -d "$policy_dir" ]] && continue
            local policy_name
            policy_name=$(basename "$policy_dir")
            [[ ! -f "${policy_dir}POLICY.md" ]] && continue

            db "INSERT OR REPLACE INTO audit_checkpoints (policy, git_commit, completed_at)
                VALUES ('$(sql_escape "$policy_name")', '${checkpoint_commit}', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));"
            printf '%s\n' "  Checkpoint: ${policy_name} → ${checkpoint_commit:0:8}"
        done
    else
        printf '%s\n' "  No audit.db found — skipping checkpoint recording"
    fi
    printf '%s\n' ""

    printf '%s\n' "=== Pipeline complete ==="
}

main "$@"
