#!/usr/bin/env bats
# Integration tests for init_database + queries

setup() {
    load 'test_helper/common-setup'
    _common_setup
    # Each test gets a fresh DB via BATS_TEST_TMPDIR
    export DB_PATH="$BATS_TEST_TMPDIR/test-${BATS_TEST_NUMBER}.db"
}

teardown() {
    rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm" "${DB_PATH}.init.lock"
}

# ============================================================================
# init_database — schema creation and idempotency
# ============================================================================

@test "init_database: creates all expected tables" {
    init_database

    run db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    assert_output --partial "audit_checkpoints"
    assert_output --partial "files"
    assert_output --partial "issue_files"
    assert_output --partial "issues"
    assert_output --partial "scans"
}

@test "init_database: idempotent — running twice doesn't error" {
    init_database
    run init_database
    assert_success
}

@test "init_database: WAL mode is enabled" {
    init_database

    run db "PRAGMA journal_mode;"
    assert_output "wal"
}

@test "init_database: issues table has fix_status column" {
    init_database

    run db "SELECT fix_status FROM issues LIMIT 0;"
    assert_success
}

@test "init_database: issues table has policy column" {
    init_database

    run db "SELECT policy FROM issues LIMIT 0;"
    assert_success
}

@test "init_database: issues table has fixed_at column" {
    init_database

    run db "SELECT fixed_at FROM issues LIMIT 0;"
    assert_success
}

# ============================================================================
# db() wrapper — basic operations
# ============================================================================

@test "db: can insert and query scans" {
    init_database

    db "INSERT INTO scans (branch_path, policy, file_count, total_loc) VALUES ('src/lib', 'test-policy', 5, 200);"
    run db "SELECT branch_path, policy, file_count FROM scans WHERE branch_path = 'src/lib';"
    assert_output "src/lib|test-policy|5"
}

@test "db: sql_escape works with db for values containing quotes" {
    init_database

    local escaped
    escaped=$(sql_escape "it's a test")
    db "INSERT INTO files (path) VALUES ('$escaped');"
    run db "SELECT path FROM files WHERE id = 1;"
    assert_output "it's a test"
}

@test "db: audit_checkpoints can store and retrieve" {
    init_database

    db "INSERT INTO audit_checkpoints (policy, git_commit) VALUES ('bash-best-practices', 'abc123');"
    run db "SELECT policy, git_commit FROM audit_checkpoints;"
    assert_output "bash-best-practices|abc123"
}

@test "db: issue severity constraint enforced" {
    init_database

    db "INSERT INTO scans (branch_path, policy) VALUES ('test', 'p');"
    run db "INSERT INTO issues (scan_id, description, rule, severity) VALUES (1, 'desc', 'rule', 'critical');"
    assert_failure
}
