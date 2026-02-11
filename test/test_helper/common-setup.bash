#!/usr/bin/env bash
# Common test setup — sourced by all .bats files via: load 'test_helper/common-setup'

_common_setup() {
    load "${BATS_TEST_DIRNAME}/test_helper/bats-support/load.bash"
    load "${BATS_TEST_DIRNAME}/test_helper/bats-assert/load.bash"
    load "${BATS_TEST_DIRNAME}/test_helper/bats-file/load.bash"

    PROJECT_DIR="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"

    # Pre-set globals so lib.sh functions work without calling init_paths()
    export FILE_EXTENSIONS="sh"
    export AUDIT_DIR="$BATS_TEST_TMPDIR"
    export PROJECT_ROOT="$BATS_TEST_TMPDIR"
    export DB_PATH="$BATS_TEST_TMPDIR/test.db"
    export BRANCHES_FILE="$BATS_TEST_TMPDIR/branches.txt"
    export POLICIES_DIR="$BATS_TEST_TMPDIR/policies"
    export MAX_LOC=3000
    export MAX_FIX_LOC=2000
    export NO_COLOR=1
    export LOG_LEVEL="error"

    # Reset cached log level so logging.sh re-evaluates
    _LOG_LEVEL_NUM=""

    # Source lib.sh (also sources logging.sh)
    source "$PROJECT_DIR/lib.sh"
}
