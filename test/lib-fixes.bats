#!/usr/bin/env bats
# Unit tests for lib-fixes.sh batching algorithm

setup() {
    load 'test_helper/common-setup'
    _common_setup
    source "$PROJECT_DIR/lib-fixes.sh"
}

# ============================================================================
# batch_files_by_loc — greedy batching with LOC thresholds
# ============================================================================

@test "batch_files_by_loc: single file under limit goes to batch 1" {
    MAX_FIX_LOC=2000
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=2000 && echo "src/foo.ts|100" | batch_files_by_loc'
    assert_output "1|src/foo.ts"
}

@test "batch_files_by_loc: multiple files under limit stay in same batch" {
    MAX_FIX_LOC=2000
    local input="src/a.ts|500
src/b.ts|500
src/c.ts|500"
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=2000 && printf "%s\n" "src/a.ts|500" "src/b.ts|500" "src/c.ts|500" | batch_files_by_loc'
    assert_line --index 0 "1|src/a.ts"
    assert_line --index 1 "1|src/b.ts"
    assert_line --index 2 "1|src/c.ts"
}

@test "batch_files_by_loc: files exceeding limit split into batches" {
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=1000 && printf "%s\n" "src/a.ts|600" "src/b.ts|600" "src/c.ts|600" | batch_files_by_loc'
    assert_line --index 0 "1|src/a.ts"
    assert_line --index 1 "2|src/b.ts"
    assert_line --index 2 "3|src/c.ts"
}

@test "batch_files_by_loc: single large file still gets batch 1" {
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=100 && echo "src/big.ts|5000" | batch_files_by_loc'
    assert_output "1|src/big.ts"
}

@test "batch_files_by_loc: empty input produces no output" {
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=2000 && echo -n "" | batch_files_by_loc'
    assert_output ""
}

@test "batch_files_by_loc: boundary — files exactly at limit stay together" {
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=1000 && printf "%s\n" "src/a.ts|500" "src/b.ts|500" | batch_files_by_loc'
    assert_line --index 0 "1|src/a.ts"
    assert_line --index 1 "1|src/b.ts"
}

@test "batch_files_by_loc: boundary — one over limit triggers new batch" {
    run bash -c 'source "'"$PROJECT_DIR"'/lib.sh" && source "'"$PROJECT_DIR"'/lib-fixes.sh" && MAX_FIX_LOC=1000 && printf "%s\n" "src/a.ts|500" "src/b.ts|501" | batch_files_by_loc'
    assert_line --index 0 "1|src/a.ts"
    assert_line --index 1 "2|src/b.ts"
}
