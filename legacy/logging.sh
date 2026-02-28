#!/usr/bin/env bash
# ============================================================================
# Logging Library
# ============================================================================
# Structured logging with levels, optional color, and optional timestamps.
#
# Functions:
#   log_debug "msg"   — stderr, shown only when LOG_LEVEL=debug
#   log_info  "msg"   — stdout, shown when LOG_LEVEL <= info (default)
#   log_warn  "msg"   — stderr, shown when LOG_LEVEL <= warn
#   log_error "msg"   — stderr, always shown
#
# Environment:
#   LOG_LEVEL       — debug | info (default) | warn | error
#   LOG_TIMESTAMPS  — set to 1 for ISO 8601 UTC prefix
#   NO_COLOR        — set to disable color (https://no-color.org/)
# ============================================================================

# Numeric level mapping: debug=0, info=1, warn=2, error=3
_log_level_num() {
    case "${1:-info}" in
        debug) printf '%s' "0" ;;
        info) printf '%s' "1" ;;
        warn) printf '%s' "2" ;;
        error) printf '%s' "3" ;;
        *) printf '%s' "1" ;;
    esac
}

# Resolve the effective log level once (re-evaluated if LOG_LEVEL changes)
_LOG_LEVEL_NUM=""
_log_effective_level() {
    if [[ -z "$_LOG_LEVEL_NUM" ]] || [[ "${_LOG_LEVEL_CACHED:-}" != "${LOG_LEVEL:-info}" ]]; then
        _LOG_LEVEL_NUM=$(_log_level_num "${LOG_LEVEL:-info}")
        _LOG_LEVEL_CACHED="${LOG_LEVEL:-info}"
    fi
    printf '%s' "$_LOG_LEVEL_NUM"
}

# Color codes (empty when NO_COLOR is set or output is not a TTY)
_LOG_COLOR_RED=""
_LOG_COLOR_YELLOW=""
_LOG_COLOR_DIM=""
_LOG_COLOR_RESET=""

_log_init_colors() {
    if [[ -n "${NO_COLOR:-}" ]]; then
        return
    fi
    # stderr colors (for error, warn, debug)
    if [[ -t 2 ]]; then
        _LOG_COLOR_RED=$'\033[31m'
        _LOG_COLOR_YELLOW=$'\033[33m'
        _LOG_COLOR_DIM=$'\033[2m'
        _LOG_COLOR_RESET=$'\033[0m'
    fi
}
_log_init_colors

# Format optional timestamp prefix
_log_timestamp() {
    if [[ "${LOG_TIMESTAMPS:-}" == "1" ]]; then
        printf '[%s] ' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    fi
}

# ---------------------------------------------------------------------------
# File logging — always writes debug-level to disk (./logs/.tmp/)
# ---------------------------------------------------------------------------
_LOG_FILE_FD=""
_LOG_FILE_PATH=""
_LOG_TMP_DIR=""

# Initialize file logging. Call once at pipeline start.
# Creates ./logs/.tmp/ and opens a log file for the run.
# Args: $1 — base directory (typically AUDIT_DIR)
log_init_file() {
    local base_dir="${1:-.}"
    _LOG_TMP_DIR="${base_dir}/logs/.tmp"
    mkdir -p "$_LOG_TMP_DIR"
    _LOG_FILE_PATH="${_LOG_TMP_DIR}/run-$(date +%Y%m%dT%H%M%S).log"
    # Open file descriptor 7 for log writing
    exec 7>>"$_LOG_FILE_PATH"
    _LOG_FILE_FD=7
}

# Write a line to the log file (always at debug level, regardless of LOG_LEVEL).
_log_to_file() {
    local level_tag="$1"
    shift
    if [[ -n "$_LOG_FILE_FD" ]]; then
        printf '[%s] %s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$level_tag" "$*" >&7
    fi
}

# Clean up log directory based on pipeline outcome.
# Args: $1 — "success" or "failure", $2 — base directory (typically AUDIT_DIR)
log_cleanup() {
    local status="${1:-failure}"
    local base_dir="${2:-.}"

    # Close file descriptor
    if [[ -n "$_LOG_FILE_FD" ]]; then
        exec 7>&- 2>/dev/null || true
        _LOG_FILE_FD=""
    fi

    if [[ "$status" == "success" ]]; then
        rm -rf "${base_dir}/logs/.tmp" 2>/dev/null || true
    else
        if [[ -d "${base_dir}/logs/.tmp" ]]; then
            local failed_dir="${base_dir}/logs/failed-$(date +%Y%m%dT%H%M%S)"
            mv "${base_dir}/logs/.tmp" "$failed_dir" 2>/dev/null || true
            # Use stderr directly to avoid recursion
            printf '[WARNING] Debug logs preserved at: %s\n' "$failed_dir" >&2
        fi
    fi
}

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

log_debug() {
    _log_to_file "[DEBUG]" "$*"
    local level
    level=$(_log_effective_level)
    [[ "$level" -gt 0 ]] && return
    printf '%s%s%s[DEBUG]%s %s\n' "$(_log_timestamp)" "$_LOG_COLOR_DIM" "" "$_LOG_COLOR_RESET" "$*" >&2
}

log_info() {
    _log_to_file "[INFO]" "$*"
    local level
    level=$(_log_effective_level)
    [[ "$level" -gt 1 ]] && return
    printf '%s%s\n' "$(_log_timestamp)" "$*"
}

log_warn() {
    _log_to_file "[WARNING]" "$*"
    local level
    level=$(_log_effective_level)
    [[ "$level" -gt 2 ]] && return
    printf '%s%s[WARNING]%s %s\n' "$(_log_timestamp)" "$_LOG_COLOR_YELLOW" "$_LOG_COLOR_RESET" "$*" >&2
}

log_error() {
    _log_to_file "[ERROR]" "$*"
    printf '%s%s[ERROR]%s %s\n' "$(_log_timestamp)" "$_LOG_COLOR_RED" "$_LOG_COLOR_RESET" "$*" >&2
}
