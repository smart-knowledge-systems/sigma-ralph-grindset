#!/usr/bin/env bats
# Unit tests for logging.sh

setup() {
    load 'test_helper/common-setup'
    _common_setup
    # Reset cached level for each test
    _LOG_LEVEL_NUM=""
    _LOG_LEVEL_CACHED=""
}

# ============================================================================
# _log_level_num — mapping
# ============================================================================

@test "_log_level_num: debug maps to 0" {
    run _log_level_num "debug"
    assert_output "0"
}

@test "_log_level_num: info maps to 1" {
    run _log_level_num "info"
    assert_output "1"
}

@test "_log_level_num: warn maps to 2" {
    run _log_level_num "warn"
    assert_output "2"
}

@test "_log_level_num: error maps to 3" {
    run _log_level_num "error"
    assert_output "3"
}

@test "_log_level_num: empty defaults to info (1)" {
    run _log_level_num ""
    assert_output "1"
}

@test "_log_level_num: unknown defaults to info (1)" {
    run _log_level_num "banana"
    assert_output "1"
}

# ============================================================================
# Log level filtering
# ============================================================================

@test "log_debug: suppressed at info level" {
    LOG_LEVEL="info"
    _LOG_LEVEL_NUM=""
    run log_debug "should not appear"
    assert_output ""
}

@test "log_debug: shown at debug level" {
    LOG_LEVEL="debug"
    _LOG_LEVEL_NUM=""
    NO_COLOR=1
    run log_debug "debug message"
    assert_output --partial "debug message"
    assert_output --partial "[DEBUG]"
}

@test "log_info: shown at info level" {
    LOG_LEVEL="info"
    _LOG_LEVEL_NUM=""
    run log_info "info message"
    assert_output "info message"
}

@test "log_info: suppressed at warn level" {
    LOG_LEVEL="warn"
    _LOG_LEVEL_NUM=""
    run log_info "should not appear"
    assert_output ""
}

@test "log_warn: shown at warn level" {
    LOG_LEVEL="warn"
    _LOG_LEVEL_NUM=""
    NO_COLOR=1
    run log_warn "warning message"
    assert_output --partial "warning message"
    assert_output --partial "[WARNING]"
}

@test "log_warn: suppressed at error level" {
    LOG_LEVEL="error"
    _LOG_LEVEL_NUM=""
    run log_warn "should not appear"
    assert_output ""
}

@test "log_error: always shown even at error level" {
    LOG_LEVEL="error"
    _LOG_LEVEL_NUM=""
    NO_COLOR=1
    run log_error "error message"
    assert_output --partial "error message"
    assert_output --partial "[ERROR]"
}
