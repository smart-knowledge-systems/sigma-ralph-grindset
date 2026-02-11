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
# Public API
# ---------------------------------------------------------------------------

log_debug() {
    local level
    level=$(_log_effective_level)
    [[ "$level" -gt 0 ]] && return
    printf '%s%s%s[DEBUG]%s %s\n' "$(_log_timestamp)" "$_LOG_COLOR_DIM" "" "$_LOG_COLOR_RESET" "$*" >&2
}

log_info() {
    local level
    level=$(_log_effective_level)
    [[ "$level" -gt 1 ]] && return
    printf '%s%s\n' "$(_log_timestamp)" "$*"
}

log_warn() {
    local level
    level=$(_log_effective_level)
    [[ "$level" -gt 2 ]] && return
    printf '%s%s[WARNING]%s %s\n' "$(_log_timestamp)" "$_LOG_COLOR_YELLOW" "$_LOG_COLOR_RESET" "$*" >&2
}

log_error() {
    printf '%s%s[ERROR]%s %s\n' "$(_log_timestamp)" "$_LOG_COLOR_RED" "$_LOG_COLOR_RESET" "$*" >&2
}
