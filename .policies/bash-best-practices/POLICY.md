# Bash Best Practices Policy

Auditable rules for writing maintainable, safe, and readable Bash scripts.
Derived from the Google Shell Style Guide, community best practices, and POSIX conventions.

---

## 1. Safety Header

- Every script MUST begin with `set -o errexit`, `set -o nounset`, and `set -o pipefail` (or the equivalent `set -euo pipefail`) immediately after the shebang.
- Never remove or comment out these flags to work around a failing command. Instead, handle the specific failure explicitly (e.g., `command || true`, `if ! command; then ...`).

## 2. Shebang

- Every executable script MUST have `#!/usr/bin/env bash` as the first line.
- Library files that are only sourced (not executed directly) do not require a shebang but SHOULD include one for editor tooling.
- Never use `#!/bin/sh` when the script relies on Bash-specific features.

## 3. Quote All Variables

- Every variable expansion MUST be double-quoted: `"${var}"`, `"$1"`, `"$@"`.
- The only exceptions are inside `[[ ]]` on the left-hand side of `==`/`!=`, and inside `$(( ))` arithmetic.
- Use `"$@"` to forward arguments — never `$*` or unquoted `$@`.
- Unquoted expansions that undergo word splitting or globbing are bugs.

## 4. Use `[[ ]]` for Conditionals

- Always use `[[ ]]` instead of `[ ]` or `test`.
- `[[ ]]` prevents word splitting and pathname expansion, supports pattern matching (`==` with globs), and regex (`=~`).
- Use `-z` and `-n` for empty/non-empty string tests — never test against empty string literals.

## 5. Error Output to stderr

- All error, warning, and diagnostic messages MUST be written to stderr (`>&2`), not stdout.
- Define a reusable error function:
  ```bash
  err() { printf '%s\n' "$*" >&2; }
  ```
- stdout is reserved for program output and data that may be piped to other commands.

## 6. Use `local` in Functions

- Every variable declared inside a function MUST use `local`.
- Separate declaration from assignment when capturing command output to preserve the exit code:
  ```bash
  local output
  output="$(some_command)"
  ```
  Combining them (`local output="$(some_command)"`) silently discards the exit code of `some_command`.

## 7. Naming Conventions

- **Functions**: `lower_case_with_underscores`. Use verb_noun form (e.g., `parse_config`, `validate_input`).
- **Local variables**: `lower_case_with_underscores`.
- **Constants and environment variables**: `UPPER_CASE_WITH_UNDERSCORES`. Declare with `readonly` at the top of the script.
- **File names**: `lower-case-with-hyphens.sh` for executables, `lower_case_with_underscores.sh` for libraries.
- Never use camelCase or PascalCase for any identifier.

## 8. Use a `main` Function

- Scripts with more than one function MUST define a `main` function containing the top-level logic.
- The last line of the script MUST be `main "$@"`.
- This keeps the global scope clean, makes the entry point explicit, and ensures all variables inside `main` can be declared `local`.

## 9. Function Documentation

- Every function that is not both short (under ~5 lines) and immediately obvious MUST have a header comment documenting:
  - What the function does (one line).
  - Arguments it accepts.
  - Global variables it reads or modifies.
  - Output it produces (stdout, stderr, files).
  - Return/exit codes if non-standard.
- Library functions MUST always have documentation regardless of length.

## 10. File Header Comment

- Every script MUST begin (after the shebang) with a comment block describing:
  - What the script does (one or two sentences).
  - Usage synopsis (how to invoke it).
- Optional: author, dependencies, environment variable requirements.

## 11. Cleanup with `trap`

- Scripts that create temporary files, acquire locks, or start background processes MUST register a cleanup function via `trap`:
  ```bash
  trap cleanup EXIT
  ```
- The cleanup function should handle both success and failure paths.
- Use `trap cleanup EXIT` (not `EXIT ERR INT TERM` separately) — `EXIT` fires on all exit paths including signals.
- Create temporary files with `mktemp`, never with predictable names in `/tmp`.

## 12. Prefer `printf` Over `echo`

- Use `printf '%s\n' "$message"` instead of `echo "$message"`.
- `echo` behavior varies across platforms (handling of `-e`, `-n`, backslash interpretation). `printf` is consistent and portable.
- Exception: simple, unformatted messages where portability is not a concern may use `echo`.

## 13. Command Substitution

- Always use `$(command)` — never backticks `` `command` ``.
- `$()` is nestable, readable, and unambiguous. Backticks require escaping for nesting and are visually confusing.

## 14. Avoid `eval`

- Never use `eval`. It re-parses input in unpredictable ways and is a common source of injection vulnerabilities.
- If dynamic command construction is needed, use arrays to build argument lists:
  ```bash
  local -a cmd=(curl --silent --fail)
  [[ -n "${token-}" ]] && cmd+=(--header "Authorization: Bearer ${token}")
  "${cmd[@]}" "${url}"
  ```

## 15. Check Return Codes

- Every command whose failure matters MUST have its return code checked — either via `if`, `||`, explicit `$?` inspection, or pipeline position under `set -e`.
- Use `if ! command; then` rather than `command; if [[ $? -ne 0 ]]; then`.
- For pipelines, use `"${PIPESTATUS[@]}"` to inspect individual segment exit codes. Capture it immediately — it is overwritten by the next command.

## 16. Use Arrays for Lists

- Represent lists of items (file paths, arguments, flags) as Bash arrays, not space-delimited strings.
- Iterate with `for item in "${array[@]}"` — always quoted.
- Build command-line arguments in arrays to avoid quoting hazards with spaces and special characters.
- Note: associative arrays (`declare -A`) require Bash 4+. If targeting Bash 3.2 (macOS default), avoid them.

## 17. Avoid Parsing `ls`

- Never parse the output of `ls`. It is not designed for programmatic consumption and breaks on filenames with spaces, newlines, or special characters.
- Use globs (`for file in ./*.txt`) or `find` with `-print0` piped to `while IFS= read -r -d ''`.

## 18. Use `readonly` for Constants

- Values that should never change after initialization MUST be declared `readonly`:
  ```bash
  readonly CONFIG_DIR="/etc/myapp"
  readonly VERSION="1.2.3"
  ```
- This catches accidental reassignment and communicates intent.

## 19. Prefer Long Flags

- When invoking external commands, prefer long option names over short ones for readability:
  ```bash
  # Good
  grep --recursive --ignore-case "pattern" src/
  # Avoid
  grep -ri "pattern" src/
  ```
- Exception: universally understood short flags (`-n`, `-r`, `-f`) in simple, short commands where verbosity hurts readability.

## 20. Input Validation

- Scripts that accept arguments MUST validate them before proceeding.
- Check required arguments are present. Print a usage message and exit non-zero if they are missing.
- Validate that file arguments exist and are readable before operating on them.
- Use `[[ $# -lt N ]]` to check argument count — never silently use empty/default values for required inputs.

## 21. Help Flag

- Every user-facing script MUST respond to `-h` and `--help` by printing a usage synopsis to stdout and exiting 0.
- The usage message should include: script name, purpose, argument list, option descriptions, and at least one example.

## 22. Indentation and Formatting

- Use 2-space indentation. Never use tabs.
- Maximum line length: 80 characters. Break long lines with `\` continuation or restructure the logic.
- Place `; then` and `; do` on the same line as `if`/`for`/`while`:
  ```bash
  if [[ -f "${file}" ]]; then
    process "${file}"
  fi
  ```
- Use blank lines to separate logical sections within functions.

## 23. Pipelines

- If a pipeline fits on one line and is readable, keep it on one line.
- For multi-segment pipelines, place each segment on its own line with the pipe `|` at the beginning of the continuation line:
  ```bash
  command1 \
    | command2 \
    | command3
  ```
- Avoid deeply nested pipelines (4+ stages). Extract intermediate steps into variables or functions.

## 24. No Implicit `cd` Without Subshells

- Never `cd` into a directory and rely on returning later. Use a subshell to scope directory changes:
  ```bash
  (
    cd "${build_dir}"
    make
  )
  ```
- Alternatively, use `pushd`/`popd` if multiple directory changes are needed in sequence.
- Prefer absolute paths over `cd` when possible.

## 25. Meaningful Exit Codes

- Use `exit 0` for success, `exit 1` for general errors, `exit 2` for usage errors (wrong arguments).
- For scripts that distinguish multiple failure modes, document the exit codes in the file header or help output.
- Never `exit` without a code in error paths — the implicit exit code of the last command may not be what you intend.

## 26. Avoid Global State

- Minimize the number of global variables. Pass data through function arguments and stdout.
- If a global is necessary, declare it `readonly` if it doesn't change, or document it clearly if it's mutable shared state.
- Never modify global state as a side effect of a function without documenting it.

## 27. ShellCheck Compliance

- All scripts MUST pass ShellCheck with zero warnings.
- Do not blanket-disable ShellCheck directives (`# shellcheck disable=...`) without a comment explaining why the specific warning is a false positive.
- Run ShellCheck as part of CI or pre-commit hooks.

## 28. Portable Bash

- Target the lowest Bash version in your environment. On macOS, the system default is Bash 3.2.
- Features requiring Bash 4+ (associative arrays, `readarray`/`mapfile`, `|&`, `${var,,}` case conversion, negative array indices) MUST NOT be used unless the minimum Bash version is explicitly documented and enforced.
- Use `printf -v var` instead of `readarray` for capturing output into variables portably.
- Test scripts on the target Bash version — not just the latest.

## 29. Temporary Files

- Always create temporary files with `mktemp`:
  ```bash
  local tmpfile
  tmpfile="$(mktemp)"
  ```
- Never hardcode temporary file paths (e.g., `/tmp/myscript.tmp`) — this creates race conditions and security issues.
- Always clean up temporary files via a `trap EXIT` handler.

## 30. Limit Script Scope

- If a script exceeds ~200 lines of logic (excluding comments and whitespace), consider whether parts should be extracted into separate scripts or rewritten in a more structured language (Python, etc.).
- Bash is appropriate for glue code, wrappers, and automation. It is not appropriate for complex data processing, string manipulation, or business logic.
- Prefer calling well-tested external tools over reimplementing their functionality in Bash.
