#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Generate Optimal BRANCHES Array
# ============================================================================
# Recursively scans directories and splits them until each branch is under
# the MAX_LOC limit. Outputs a BRANCHES array ready to paste into run-audit.sh
#
# Usage:
#   ./generate-branches.sh              # Full generation
#   ./generate-branches.sh --changed    # Also write branches-changed.txt
#   ./generate-branches.sh -h|--help    # Show usage
# ============================================================================

# Shared library + path initialization (resolves PROJECT_ROOT, AUDIT_DIR,
# DB_PATH, BRANCHES_FILE, FILE_EXTENSIONS, START_DIRS via audit.conf)
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
init_paths

# MAX_LOC is set by lib.sh init_paths (default 3000, overridable via audit.conf)

# ---------------------------------------------------------------------------
# Usage / help
# ---------------------------------------------------------------------------
show_help() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Recursively scans directories and generates an optimal branch list for
auditing, with each branch kept under MAX_LOC ($MAX_LOC) lines.

Options:
  --changed    Also write branches-changed.txt filtered to branches
               with files changed since the oldest audit checkpoint
  -h, --help   Show this help message and exit

Output:
  branches.txt           Canonical full branch list (always written)
  branches-changed.txt   Filtered subset (only with --changed)

Examples:
  $(basename "$0")              # Full generation
  $(basename "$0") --changed    # Also write changed-branches filter
EOF
    exit 0
}

# Count flat LOC (files in directory only, not subdirectories).
# Args: $1 — directory path
# Output: line count to stdout
count_flat_loc() {
    local dir="$1"
    build_find_ext_array
    find "$dir" -maxdepth 1 "${EXT_FIND_ARGS[@]}" -type f -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print $1}' || printf '%s\n' "0"
}

# Check if directory has subdirectories with matching source files.
# Args: $1 — directory path
# Returns: 0 if subdirs with source files exist, 1 otherwise
has_ts_subdirs() {
    local dir="$1"
    build_find_ext_array
    find "$dir" -mindepth 2 -maxdepth 2 "${EXT_FIND_ARGS[@]}" -type f 2>/dev/null | head -1 | grep -q . && return 0 || return 1
}

# Get immediate subdirectories that contain matching source files.
# Args: $1 — directory path
# Output: one subdirectory path per line to stdout
get_ts_subdirs() {
    local dir="$1"
    local subdirs=()
    build_find_ext_array

    # Find all immediate subdirectories
    while IFS= read -r subdir; do
        if find "$subdir" "${EXT_FIND_ARGS[@]}" -type f 2>/dev/null | head -1 | grep -q .; then
            subdirs+=("$subdir")
        fi
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

    printf '%s\n' "${subdirs[@]}"
}

# Recursively process a directory, appending to the BRANCHES array.
# Args: $1 — absolute directory path
# Globals: reads PROJECT_ROOT, MAX_LOC; modifies BRANCHES
process_dir() {
    local dir="$1"
    local rel_path="${dir#"${PROJECT_ROOT}"/}"

    # Skip excluded directories
    if is_excluded_path "$rel_path"; then
        return
    fi

    # Skip if directory doesn't exist
    [[ ! -d "$dir" ]] && return

    # Count flat LOC
    local flat_loc
    flat_loc=$(count_flat_loc "$dir")

    # Check for subdirectories with matching source files
    local has_subdirs=false
    has_ts_subdirs "$dir" && has_subdirs=true

    if [[ "$has_subdirs" == "true" ]]; then
        # Has subdirectories - add flat-only entry if needed
        if [[ $flat_loc -gt 0 ]] && [[ $flat_loc -le $MAX_LOC ]]; then
            BRANCHES+=("${rel_path} (flat)")
            printf '%s\n' "  ${rel_path} (flat) (flat: $flat_loc LOC) - flat files only"
        elif [[ $flat_loc -gt $MAX_LOC ]]; then
            BRANCHES+=("${rel_path} (flat)")
            printf '%s\n' "  ${rel_path} (flat) (flat: $flat_loc LOC) - will batch at runtime"
        fi

        # Recurse into subdirectories
        printf '%s\n' "  ${rel_path} - recursing into subdirectories"
        while IFS= read -r subdir; do
            process_dir "$subdir"
        done < <(get_ts_subdirs "$dir")
    else
        # Leaf directory - include if has files
        if [[ $flat_loc -gt 0 ]]; then
            BRANCHES+=("$rel_path")
            if [[ $flat_loc -le $MAX_LOC ]]; then
                printf '%s\n' "  $rel_path (flat: $flat_loc LOC) - leaf directory"
            else
                printf '%s\n' "  $rel_path (flat: $flat_loc LOC) - leaf directory, will batch at runtime"
            fi
        fi
    fi
}

# ============================================================================
# Main
# ============================================================================

main() {
    # Argument parsing
    local changed_mode=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h | --help) show_help ;;
            --changed)
                changed_mode=1
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

    # Output array
    declare -a BRANCHES

    printf '%s\n' "Generating optimal BRANCHES array (MAX_LOC=$MAX_LOC)"
    printf '%s\n' "=========================================="
    printf '%s\n' ""

    # Process each starting directory
    for start_dir in "${START_DIRS[@]}"; do
        local full_path="${PROJECT_ROOT}/${start_dir}"
        if [[ -d "$full_path" ]]; then
            printf '%s\n' "Processing: $start_dir"
            process_dir "$full_path"
            printf '%s\n' ""
        else
            printf '%s\n' "Skipping: $start_dir (not found)"
            printf '%s\n' ""
        fi
    done

    # Guard: if no branches were found, provide diagnostic info and exit
    if [[ ${#BRANCHES[@]} -eq 0 ]]; then
        log_error "No branches generated — no source files found."
        log_error "  PROJECT_ROOT: ${PROJECT_ROOT}"
        log_error "  START_DIRS:   ${START_DIRS[*]}"
        log_error "  FILE_EXTENSIONS: ${FILE_EXTENSIONS}"
        log_error "  Mode: $(if [[ -e "${AUDIT_DIR}/../.git" ]]; then printf 'portable'; elif [[ -e "${AUDIT_DIR}/.git" ]]; then printf 'self-audit'; else printf 'portable-fallback'; fi)"
        log_error "Check that START_DIRS in audit.conf point to directories that exist under PROJECT_ROOT."
        exit 1
    fi

    # Write full branch list atomically (temp file + mv prevents partial output on failure)
    local tmp_branches
    tmp_branches=$(mktemp)
    trap 'rm -f "$tmp_branches"' EXIT
    printf '%s\n' "${BRANCHES[@]}" >"$tmp_branches"
    mv "$tmp_branches" "$BRANCHES_FILE"
    trap - EXIT

    printf '%s\n' ""
    printf '%s\n' "=========================================="
    printf '%s\n' "Generated ${#BRANCHES[@]} branches -> $(basename "$BRANCHES_FILE")"
    printf '%s\n' "=========================================="
    printf '%s\n' ""
    for branch in "${BRANCHES[@]}"; do
        printf '%s\n' "  $branch"
    done
    printf '%s\n' ""
    printf '%s\n' "Wrote to: $BRANCHES_FILE"

    # --changed: filter to branches with files changed since oldest checkpoint
    if [[ -n "$changed_mode" ]]; then
        printf '%s\n' ""
        printf '%s\n' "=========================================="
        printf '%s\n' "Filtering to changed branches..."
        printf '%s\n' "=========================================="

        local changed_file="${AUDIT_DIR}/branches-changed.txt"

        # Load branch definitions for file→branch mapping
        load_branches_for_matching

        # Find the oldest checkpoint commit across all policies (most conservative)
        local oldest_commit=""
        if [[ -f "$DB_PATH" ]]; then
            oldest_commit=$(db "
                SELECT git_commit FROM audit_checkpoints
                ORDER BY completed_at ASC LIMIT 1;
            " 2>/dev/null || true)
        fi

        if [[ -z "$oldest_commit" ]]; then
            printf '%s\n' "No checkpoint found -- all branches included"
            printf '%s\n' "${BRANCHES[@]}" >"$changed_file"
            printf '%s\n' "Wrote ${#BRANCHES[@]} branches to $(basename "$changed_file")"
        else
            # Verify commit exists
            if ! git -C "$PROJECT_ROOT" cat-file -t "$oldest_commit" &>/dev/null; then
                printf '%s\n' "Checkpoint commit ${oldest_commit:0:8} no longer in history -- all branches included"
                printf '%s\n' "${BRANCHES[@]}" >"$changed_file"
                printf '%s\n' "Wrote ${#BRANCHES[@]} branches to $(basename "$changed_file")"
            else
                # Get changed source files since oldest checkpoint
                local changed_files
                changed_files=$(git -C "$PROJECT_ROOT" diff --name-only "${oldest_commit}...HEAD" 2>/dev/null || true)

                # Map changed files to branches (bash 3.2 compatible)
                local changed_branches_list=""
                if [[ -n "$changed_files" ]]; then
                    while IFS= read -r file; do
                        if ! matches_extensions "$file"; then
                            continue
                        fi
                        if is_excluded_path "$file"; then
                            continue
                        fi
                        local branch
                        branch=$(file_to_branch "$file")
                        if [[ -n "$branch" ]]; then
                            changed_branches_list="${changed_branches_list}${branch}"$'\n'
                        fi
                    done <<<"$changed_files"
                fi
                changed_branches_list=$(printf '%s' "$changed_branches_list" | sort -u | sed '/^$/d')

                # Filter BRANCHES to only changed ones
                local -a changed_branches=()
                for branch in "${BRANCHES[@]}"; do
                    local clean_branch="$branch"
                    if [[ "$branch" =~ ^(.*)[[:space:]]\(flat\)$ ]]; then
                        clean_branch="${BASH_REMATCH[1]}"
                    fi
                    if printf '%s\n' "$changed_branches_list" | grep -qxF "$clean_branch"; then
                        changed_branches+=("$branch")
                    fi
                done

                printf '%s\n' "${changed_branches[@]}" >"$changed_file"

                local commit_short="${oldest_commit:0:8}"
                printf '%s\n' "${#changed_branches[@]} of ${#BRANCHES[@]} branches changed since ${commit_short}"
                printf '%s\n' ""
                for branch in "${changed_branches[@]}"; do
                    printf '%s\n' "  $branch"
                done
                printf '%s\n' ""
                printf '%s\n' "Wrote to: $changed_file"
            fi
        fi
    fi
}

main "$@"
