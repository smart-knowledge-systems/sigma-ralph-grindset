#!/usr/bin/env bats
# Unit tests for lib.sh pure functions

setup() {
    load 'test_helper/common-setup'
    _common_setup
}

# ============================================================================
# sql_escape — data boundary: prevents SQL injection
# ============================================================================

@test "sql_escape: escapes single quotes" {
    run sql_escape "O'Brien"
    assert_output "O''Brien"
}

@test "sql_escape: handles empty string" {
    run sql_escape ""
    assert_output ""
}

@test "sql_escape: handles multiple quotes" {
    run sql_escape "it's a 'test'"
    assert_output "it''s a ''test''"
}

@test "sql_escape: passthrough when no quotes" {
    run sql_escape "hello world"
    assert_output "hello world"
}

# ============================================================================
# truncate_for_db — data boundary: prevents DB storage issues
# ============================================================================

@test "truncate_for_db: short string passes through" {
    run truncate_for_db "hello"
    assert_output "hello"
}

@test "truncate_for_db: exact-length string passes through" {
    local str
    str=$(printf '%0.sa' $(seq 1 4000))
    run truncate_for_db "$str"
    assert_output "$str"
}

@test "truncate_for_db: over-length string gets truncated with suffix" {
    local str
    str=$(printf '%0.sa' $(seq 1 4010))
    run truncate_for_db "$str"
    # Output should be 4000 'a's + "... [truncated]"
    local expected
    expected="$(printf '%0.sa' $(seq 1 4000))... [truncated]"
    assert_output "$expected"
}

@test "truncate_for_db: custom max_chars parameter" {
    run truncate_for_db "abcdefghij" 5
    assert_output "abcde... [truncated]"
}

@test "truncate_for_db: empty string" {
    run truncate_for_db ""
    assert_output ""
}

# ============================================================================
# resolve_alias — string parsing: regex-based path resolution
# ============================================================================

@test "resolve_alias: @/convex/foo resolves to convex/foo" {
    run resolve_alias "@/convex/foo"
    assert_output "convex/foo"
}

@test "resolve_alias: @/components/bar resolves to src/components/bar" {
    run resolve_alias "@/components/bar"
    assert_output "src/components/bar"
}

@test "resolve_alias: relative path passes through" {
    run resolve_alias "./foo"
    assert_output "./foo"
}

@test "resolve_alias: external package returns empty" {
    run resolve_alias "react"
    assert_output ""
}

@test "resolve_alias: @/convex nested path" {
    run resolve_alias "@/convex/api/mutations"
    assert_output "convex/api/mutations"
}

# ============================================================================
# matches_extensions — pattern matching
# ============================================================================

@test "matches_extensions: foo.sh matches when FILE_EXTENSIONS=sh" {
    FILE_EXTENSIONS="sh"
    run matches_extensions "foo.sh"
    assert_success
}

@test "matches_extensions: foo.ts does NOT match when FILE_EXTENSIONS=sh" {
    FILE_EXTENSIONS="sh"
    run matches_extensions "foo.ts"
    assert_failure
}

@test "matches_extensions: multi-extension match" {
    FILE_EXTENSIONS="ts tsx"
    run matches_extensions "foo.tsx"
    assert_success
}

@test "matches_extensions: no extension doesn't match" {
    FILE_EXTENSIONS="sh"
    run matches_extensions "Makefile"
    assert_failure
}

@test "matches_extensions: path with directories" {
    FILE_EXTENSIONS="sh"
    run matches_extensions "src/lib/utils.sh"
    assert_success
}

# ============================================================================
# ext_to_lang — mapping correctness
# ============================================================================

@test "ext_to_lang: sh maps to bash" {
    FILE_EXTENSIONS="sh"
    run ext_to_lang
    assert_output "bash"
}

@test "ext_to_lang: ts maps to typescript" {
    FILE_EXTENSIONS="ts tsx"
    run ext_to_lang
    assert_output "typescript"
}

@test "ext_to_lang: py maps to python" {
    FILE_EXTENSIONS="py"
    run ext_to_lang
    assert_output "python"
}

@test "ext_to_lang: unknown extension passes through" {
    FILE_EXTENSIONS="zig"
    run ext_to_lang
    assert_output "zig"
}

@test "ext_to_lang: js maps to javascript" {
    FILE_EXTENSIONS="js jsx"
    run ext_to_lang
    assert_output "javascript"
}

# ============================================================================
# ext_display_label — formatting
# ============================================================================

@test "ext_display_label: single extension" {
    FILE_EXTENSIONS="sh"
    run ext_display_label
    assert_output ".sh"
}

@test "ext_display_label: multiple extensions" {
    FILE_EXTENSIONS="ts tsx"
    run ext_display_label
    assert_output ".ts/.tsx"
}

@test "ext_display_label: three extensions" {
    FILE_EXTENSIONS="js jsx mjs"
    run ext_display_label
    assert_output ".js/.jsx/.mjs"
}

# ============================================================================
# build_find_ext_array — array construction
# ============================================================================

@test "build_find_ext_array: single extension builds correct find args" {
    FILE_EXTENSIONS="sh"
    build_find_ext_array
    # Expected: ( -name *.sh )
    assert_equal "${EXT_FIND_ARGS[0]}" "("
    assert_equal "${EXT_FIND_ARGS[1]}" "-name"
    assert_equal "${EXT_FIND_ARGS[2]}" "*.sh"
    assert_equal "${EXT_FIND_ARGS[3]}" ")"
    assert_equal "${#EXT_FIND_ARGS[@]}" 4
}

@test "build_find_ext_array: multiple extensions include -o separators" {
    FILE_EXTENSIONS="ts tsx"
    build_find_ext_array
    # Expected: ( -name *.ts -o -name *.tsx )
    assert_equal "${EXT_FIND_ARGS[0]}" "("
    assert_equal "${EXT_FIND_ARGS[1]}" "-name"
    assert_equal "${EXT_FIND_ARGS[2]}" "*.ts"
    assert_equal "${EXT_FIND_ARGS[3]}" "-o"
    assert_equal "${EXT_FIND_ARGS[4]}" "-name"
    assert_equal "${EXT_FIND_ARGS[5]}" "*.tsx"
    assert_equal "${EXT_FIND_ARGS[6]}" ")"
    assert_equal "${#EXT_FIND_ARGS[@]}" 7
}

# ============================================================================
# file_to_branch + load_branches_for_matching — complex domain logic
# ============================================================================

@test "file_to_branch: direct child of flat branch matches" {
    cp "$PROJECT_DIR/test/fixtures/branches.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    run file_to_branch "src/components/layout.tsx"
    assert_output "src/components"
}

@test "file_to_branch: nested file in flat branch does NOT match flat branch" {
    cp "$PROJECT_DIR/test/fixtures/branches.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    # src/components/bookshop/catalog.tsx should match "src/components/bookshop"
    # NOT "src/components (flat)"
    run file_to_branch "src/components/bookshop/catalog.tsx"
    assert_output "src/components/bookshop"
}

@test "file_to_branch: nested file matches recursive branch" {
    cp "$PROJECT_DIR/test/fixtures/branches.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    run file_to_branch "src/lib/utils.ts"
    assert_output "src/lib"
}

@test "file_to_branch: deeply nested file matches recursive branch" {
    cp "$PROJECT_DIR/test/fixtures/branches.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    run file_to_branch "src/components/dashboard/widgets/chart.tsx"
    assert_output "src/components/dashboard"
}

@test "file_to_branch: file with no matching branch returns empty" {
    cp "$PROJECT_DIR/test/fixtures/branches.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    run file_to_branch "other/random/file.ts"
    assert_output ""
}

@test "file_to_branch: longest prefix wins with nested branches" {
    cp "$PROJECT_DIR/test/fixtures/branches-nested.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    # Should match src/components/bookshop/catalog (longest prefix)
    # not src/components/bookshop
    run file_to_branch "src/components/bookshop/catalog/item.tsx"
    assert_output "src/components/bookshop/catalog"
}

@test "file_to_branch: flat branch at src level" {
    cp "$PROJECT_DIR/test/fixtures/branches-nested.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    run file_to_branch "src/index.ts"
    assert_output "src"
}

@test "file_to_branch: nested file skips flat src branch" {
    cp "$PROJECT_DIR/test/fixtures/branches-nested.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    # src/lib/utils/format.ts should match "src/lib/utils" (longest recursive)
    # NOT "src (flat)"
    run file_to_branch "src/lib/utils/format.ts"
    assert_output "src/lib/utils"
}

@test "load_branches_for_matching: parses flat suffix correctly" {
    cp "$PROJECT_DIR/test/fixtures/branches.txt" "$BRANCHES_FILE"
    LIB_BRANCH_ENTRIES=()
    LIB_BRANCH_PATHS=()
    LIB_BRANCH_IS_FLAT=()
    load_branches_for_matching

    # First entry is "src/components (flat)"
    assert_equal "${LIB_BRANCH_PATHS[0]}" "src/components"
    assert_equal "${LIB_BRANCH_IS_FLAT[0]}" "1"

    # Second entry is "src/components/bookshop" (recursive)
    assert_equal "${LIB_BRANCH_PATHS[1]}" "src/components/bookshop"
    assert_equal "${LIB_BRANCH_IS_FLAT[1]}" ""
}
