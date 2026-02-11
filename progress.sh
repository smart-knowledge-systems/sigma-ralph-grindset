#!/usr/bin/env bash
# ============================================================================
# Audit Progress Footer
# ============================================================================
# Shared library that pins a 2-line status bar to the bottom of the terminal
# using ANSI scroll regions. Sourced by run-all.sh, run-audit.sh, run-fixes.sh.
#
# Usage:
#   source "${AUDIT_DIR}/progress.sh"
#   progress_init                          # Set up scroll region + timer
#   progress_total N                       # Set total step count
#   progress_step "label"                  # Advance to next step (auto-increment)
#   progress_set N "label"                 # Set step to explicit value (for counters)
#   progress_substep X Y "label"           # Set substep within current step
#   progress_title "label"                 # Set persistent title on separator line
#   progress_unit "LOC"                    # Set unit label (e.g., "LOC", "issues")
#   progress_pause                         # Suppress rendering (for bulk output)
#   progress_resume                        # Re-enable rendering after pause
#   progress_is_owner                      # Returns 0 if this process owns footer
#   progress_cleanup                       # Restore terminal (idempotent)
# ============================================================================

# Braille spinner frames (cycled at 1Hz by the background timer)
_PROGRESS_SPINNER_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

# ── TTY detection ──────────────────────────────────────────────────────────
# All functions become no-ops when stdout is not a terminal.
_PROGRESS_IS_TTY=""
if [[ -t 1 ]] && [[ -e /dev/tty ]]; then
    _PROGRESS_IS_TTY=1
fi

# ── State ──────────────────────────────────────────────────────────────────
_PROGRESS_STATE_FILE=""
_PROGRESS_TIMER_PID=""
_PROGRESS_OWNER=""      # "1" if this process owns the footer
_PROGRESS_CLEANED_UP="" # prevent double-cleanup

# ============================================================================
# progress_init — set up scroll region and background timer (owner only)
# ============================================================================
progress_init() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0

    # Nesting detection: if a parent already owns the footer, become a child
    if [[ "${AUDIT_PROGRESS_ACTIVE:-}" == "1" ]]; then
        _PROGRESS_OWNER=""
        # Inherit state file path from parent
        _PROGRESS_STATE_FILE="${AUDIT_PROGRESS_STATE_FILE:-}"
        return 0
    fi

    _PROGRESS_OWNER=1
    _PROGRESS_STATE_FILE="/tmp/audit-progress-$$"

    # Export env vars so child scripts detect the active footer
    export AUDIT_PROGRESS_ACTIVE=1
    export AUDIT_PROGRESS_STATE_FILE="$_PROGRESS_STATE_FILE"

    # Initialize state file (string values MUST be single-quoted for safe sourcing
    # under set -e; bash 3.2 doesn't suppress errexit inside source ... || ...)
    cat >"$_PROGRESS_STATE_FILE" <<EOF
STEP=0
TOTAL=0
LABEL='Initializing'
SUBSTEP=0
SUBSTEP_TOTAL=0
SUBSTEP_LABEL=''
START_EPOCH=$(date +%s)
PAUSED=0
TITLE=''
UNIT=''
EOF

    # Clear the screen before setting up the footer
    printf '\033[2J\033[H' >/dev/tty

    # Set up scroll region (reserve bottom 2 lines)
    local lines
    lines=$(tput lines 2>/dev/tty)
    printf '\033[1;%dr' "$((lines - 2))" >/dev/tty
    # Move cursor to top of scroll region
    printf '\033[%d;1H' 1 >/dev/tty

    # Trap SIGWINCH to resize scroll region
    trap '_progress_resize' WINCH

    # Start background timer (renders footer every second)
    _progress_start_timer
}

# ============================================================================
# progress_total — set total step count
# ============================================================================
progress_total() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0

    local total="$1"
    _progress_update_field "TOTAL" "$total"
}

# ============================================================================
# progress_step — advance to next step (increments counter, clears substep)
# ============================================================================
progress_step() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0

    local label="$1"

    # Read current step and increment
    local current_step=0
    if [[ -f "$_PROGRESS_STATE_FILE" ]]; then
        current_step=$(grep '^STEP=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
    fi
    local next_step=$((current_step + 1))

    # Atomic write: update step, label, and clear substep
    local tmp="${_PROGRESS_STATE_FILE}.tmp"
    if [[ -f "$_PROGRESS_STATE_FILE" ]]; then
        # Preserve TOTAL, START_EPOCH, PAUSED, TITLE, UNIT — update everything else
        local total start_epoch paused title unit
        total=$(grep '^TOTAL=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        start_epoch=$(grep '^START_EPOCH=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        paused=$(grep '^PAUSED=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        title=$(grep '^TITLE=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        title=${title#\'}
        title=${title%\'}
        unit=$(grep '^UNIT=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        unit=${unit#\'}
        unit=${unit%\'}
        cat >"$tmp" <<EOF
STEP=${next_step}
TOTAL=${total}
LABEL='${label}'
SUBSTEP=0
SUBSTEP_TOTAL=0
SUBSTEP_LABEL=''
START_EPOCH=${start_epoch}
PAUSED=${paused:-0}
TITLE='${title:-}'
UNIT='${unit:-}'
EOF
        mv "$tmp" "$_PROGRESS_STATE_FILE"
    fi
}

# ============================================================================
# progress_substep — set substep within current step
# ============================================================================
progress_substep() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0

    local substep="$1"
    local substep_total="$2"
    local label="$3"

    # Atomic write: preserve everything except substep fields
    local tmp="${_PROGRESS_STATE_FILE}.tmp"
    if [[ -f "$_PROGRESS_STATE_FILE" ]]; then
        local step total main_label start_epoch paused title unit
        step=$(grep '^STEP=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        total=$(grep '^TOTAL=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        main_label=$(grep '^LABEL=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        main_label=${main_label#\'}
        main_label=${main_label%\'}
        start_epoch=$(grep '^START_EPOCH=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        paused=$(grep '^PAUSED=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        title=$(grep '^TITLE=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        title=${title#\'}
        title=${title%\'}
        unit=$(grep '^UNIT=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        unit=${unit#\'}
        unit=${unit%\'}
        cat >"$tmp" <<EOF
STEP=${step}
TOTAL=${total}
LABEL='${main_label}'
SUBSTEP=${substep}
SUBSTEP_TOTAL=${substep_total}
SUBSTEP_LABEL='${label}'
START_EPOCH=${start_epoch}
PAUSED=${paused:-0}
TITLE='${title:-}'
UNIT='${unit:-}'
EOF
        mv "$tmp" "$_PROGRESS_STATE_FILE"
    fi
}

# ============================================================================
# progress_is_owner — returns 0 if this process owns the footer
# ============================================================================
progress_is_owner() {
    [[ -n "$_PROGRESS_OWNER" ]]
}

# ============================================================================
# progress_pause — suppress footer rendering (protects bulk stdout writes)
# ============================================================================
progress_pause() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0
    _progress_update_field "PAUSED" "1"
}

# ============================================================================
# progress_resume — re-enable footer rendering after a pause
# ============================================================================
progress_resume() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0
    _progress_update_field "PAUSED" "0"
    _progress_render
}

# ============================================================================
# progress_title — set a persistent label shown on the separator line
# ============================================================================
progress_title() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0
    _progress_update_field "TITLE" "$1"
    _progress_render
}

# ============================================================================
# progress_unit — set the unit label (e.g., "LOC", "issues")
# ============================================================================
progress_unit() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0
    _progress_update_field "UNIT" "$1"
}

# ============================================================================
# progress_set — set step to an explicit value (for accumulated counters)
# ============================================================================
progress_set() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ -z "$_PROGRESS_STATE_FILE" ]] && return 0

    local step_value="$1"
    local label="$2"

    # Atomic write: preserve all fields, update STEP and LABEL
    local tmp="${_PROGRESS_STATE_FILE}.tmp"
    if [[ -f "$_PROGRESS_STATE_FILE" ]]; then
        local total start_epoch paused title unit
        total=$(grep '^TOTAL=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        start_epoch=$(grep '^START_EPOCH=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        paused=$(grep '^PAUSED=' "$_PROGRESS_STATE_FILE" | cut -d= -f2)
        title=$(grep '^TITLE=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        title=${title#\'}
        title=${title%\'}
        unit=$(grep '^UNIT=' "$_PROGRESS_STATE_FILE" | cut -d= -f2-)
        unit=${unit#\'}
        unit=${unit%\'}
        cat >"$tmp" <<EOF
STEP=${step_value}
TOTAL=${total}
LABEL='${label}'
SUBSTEP=0
SUBSTEP_TOTAL=0
SUBSTEP_LABEL=''
START_EPOCH=${start_epoch}
PAUSED=${paused:-0}
TITLE='${title:-}'
UNIT='${unit:-}'
EOF
        mv "$tmp" "$_PROGRESS_STATE_FILE"
    fi
}

# ============================================================================
# progress_cleanup — restore terminal (idempotent, owner only)
# ============================================================================
progress_cleanup() {
    # Idempotent guard
    [[ -n "$_PROGRESS_CLEANED_UP" ]] && return 0
    _PROGRESS_CLEANED_UP=1

    # Only the owner cleans up
    [[ -z "$_PROGRESS_OWNER" ]] && return 0
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0

    # Kill background timer
    if [[ -n "$_PROGRESS_TIMER_PID" ]]; then
        kill "$_PROGRESS_TIMER_PID" 2>/dev/null || true
        wait "$_PROGRESS_TIMER_PID" 2>/dev/null || true
        _PROGRESS_TIMER_PID=""
    fi

    # Reset scroll region to full terminal
    local lines
    lines=$(tput lines 2>/dev/tty || echo 24)
    printf '\033[1;%dr' "$lines" >/dev/tty

    # Clear the footer lines
    printf '\033[%d;1H\033[K' "$((lines - 1))" >/dev/tty
    printf '\033[%d;1H\033[K' "$lines" >/dev/tty

    # Move cursor back to scroll area
    printf '\033[%d;1H' "$((lines - 2))" >/dev/tty

    # Remove state file
    rm -f "$_PROGRESS_STATE_FILE" "${_PROGRESS_STATE_FILE}.tmp"

    # Unset env vars
    unset AUDIT_PROGRESS_ACTIVE
    unset AUDIT_PROGRESS_STATE_FILE

    # Remove WINCH trap
    trap - WINCH 2>/dev/null || true
}

# ============================================================================
# Internal helpers
# ============================================================================

# Resize scroll region on terminal size change (SIGWINCH handler).
# Recalculates terminal height and re-renders the footer.
_progress_resize() {
    [[ -z "$_PROGRESS_OWNER" ]] && return 0
    local lines
    lines=$(tput lines 2>/dev/tty || echo 24)
    printf '\033[1;%dr' "$((lines - 2))" >/dev/tty
    _progress_render
}

# Format elapsed time as "Xm Ys"
_progress_elapsed() {
    local start_epoch="$1"
    local now
    now=$(date +%s)
    local elapsed=$((now - start_epoch))
    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    printf '%dm %02ds' "$mins" "$secs"
}

# Render the 2-line footer (separator + status) to /dev/tty.
# Reads state from the shared state file, builds the display lines,
# and draws them at the bottom of the terminal using ANSI escape sequences.
# No-op when paused or when the state file is missing.
_progress_render() {
    [[ -z "$_PROGRESS_IS_TTY" ]] && return 0
    [[ ! -f "$_PROGRESS_STATE_FILE" ]] && return 0

    # Read state (source is fast — ~1 fork vs ~14 for individual greps)
    local STEP=0 TOTAL=0 LABEL="" SUBSTEP=0 SUBSTEP_TOTAL=0 SUBSTEP_LABEL="" START_EPOCH=0 PAUSED=0 TITLE="" UNIT=""
    # shellcheck source=/dev/null
    source "$_PROGRESS_STATE_FILE" 2>/dev/null || return 0

    # Skip rendering while paused (protects bulk stdout writes from cursor interference)
    [[ "${PAUSED:-0}" == "1" ]] && return 0

    local lines cols
    lines=$(tput lines 2>/dev/tty || echo 24)
    cols=$(tput cols 2>/dev/tty || echo 80)

    # Spinner frame
    local frame_idx=$((($(date +%s) - START_EPOCH) % ${#_PROGRESS_SPINNER_FRAMES[@]}))
    local spinner="${_PROGRESS_SPINNER_FRAMES[$frame_idx]}"

    # Elapsed time
    local elapsed
    elapsed=$(_progress_elapsed "$START_EPOCH")

    # Remaining count and unit suffix
    local remaining=$((TOTAL - STEP))
    [[ $remaining -lt 0 ]] && remaining=0
    local unit_suffix=""
    [[ -n "${UNIT:-}" ]] && unit_suffix=" ${UNIT}"

    # Build status line
    local status_line
    if [[ -n "$SUBSTEP_LABEL" ]] && [[ "$SUBSTEP_TOTAL" -gt 0 ]]; then
        # When substep is active, omit "remaining" tail (substep progress is more meaningful)
        status_line="${spinner} [${STEP}/${TOTAL}${unit_suffix}] ${LABEL} — ${SUBSTEP_LABEL} ${SUBSTEP}/${SUBSTEP_TOTAL} │ ${elapsed}"
    else
        status_line="${spinner} [${STEP}/${TOTAL}${unit_suffix}] ${LABEL} │ ${elapsed} │ ${remaining}${unit_suffix} remaining"
    fi

    # Truncate to terminal width
    if [[ ${#status_line} -gt $cols ]]; then
        status_line="${status_line:0:$((cols - 1))}…"
    fi

    # Build separator line (full width, with optional title)
    local separator
    if [[ -n "${TITLE:-}" ]]; then
        local title_part="── ${TITLE} "
        local remaining_width=$((cols - ${#title_part}))
        if [[ $remaining_width -lt 1 ]]; then
            remaining_width=1
        fi
        local filler
        filler=$(printf '─%.0s' $(seq 1 "$remaining_width"))
        separator="${title_part}${filler}"
    else
        separator=$(printf '─%.0s' $(seq 1 "$cols"))
    fi

    # Save cursor, draw footer, restore cursor
    printf '\0337' >/dev/tty
    printf '\033[%d;1H\033[K%s' "$((lines - 1))" "$separator" >/dev/tty
    printf '\033[%d;1H\033[K%s' "$lines" "$status_line" >/dev/tty
    printf '\0338' >/dev/tty
}

# Spawn a background subshell that re-renders the footer every second.
# Stores the PID in _PROGRESS_TIMER_PID for cleanup.
_progress_start_timer() {
    (
        while true; do
            _progress_render
            sleep 1
        done
    ) &
    _PROGRESS_TIMER_PID=$!
    # Suppress job control messages
    disown "$_PROGRESS_TIMER_PID" 2>/dev/null || true
}

# Update a single field in the state file atomically.
# Reads all lines, replaces the matching field, and writes back.
# Avoids sed interpolation issues with special characters in value.
#
# Args:
#   $1 — field name (e.g., "PAUSED", "TITLE")
#   $2 — new value
_progress_update_field() {
    local field="$1"
    local value="$2"
    [[ ! -f "$_PROGRESS_STATE_FILE" ]] && return 0

    local tmp="${_PROGRESS_STATE_FILE}.tmp"
    # Read all lines, replace the matching field using awk for safe value handling
    awk -v fld="$field" -v val="$value" '
        BEGIN { FS="="; OFS="=" }
        $1 == fld { print fld "=\047" val "\047"; next }
        { print }
    ' "$_PROGRESS_STATE_FILE" >"$tmp"
    mv "$tmp" "$_PROGRESS_STATE_FILE"
}
