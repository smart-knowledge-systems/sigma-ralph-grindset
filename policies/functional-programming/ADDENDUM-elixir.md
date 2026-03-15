---
applies_when:
  file_extensions: [ex, exs]
---

# Elixir FP Addendum

Elixir-specific functional programming guidance, idioms, and anti-patterns.
This addendum extends `POLICY.md` with Elixir best practices derived from official documentation.

> Sources:
> - https://hexdocs.pm/elixir/code-anti-patterns.html
> - https://hexdocs.pm/elixir/design-anti-patterns.html
> - https://hexdocs.pm/elixir/process-anti-patterns.html
> - https://hexdocs.pm/elixir/macro-anti-patterns.html
> - https://hexdocs.pm/elixir/naming-conventions.html
> - https://hexdocs.pm/elixir/writing-documentation.html

---

## Code Practices

### 1. Use Self-Documenting Code Instead of Excessive Comments

DO NOT write comments that restate what code already says. Use descriptive function names, variable names, and module attributes.

**Incorrect:**

```elixir
# Returns the Unix timestamp of 5 minutes from the current time
defp unix_five_min_from_now do
  # Get the current time
  now = DateTime.utc_now()
  # Convert it to a Unix timestamp
  unix_now = DateTime.to_unix(now, :second)
  # Add five minutes in seconds
  unix_now + (60 * 5)
end
```

**Correct:**

```elixir
@five_min_in_seconds 60 * 5

defp unix_five_min_from_now do
  now = DateTime.utc_now()
  unix_now = DateTime.to_unix(now, :second)
  unix_now + @five_min_in_seconds
end
```

### 2. Normalize Errors in Dedicated Functions

DO NOT flatten all error handling into a single `else` block in `with` statements. Wrap each fallible step in a private function that normalizes its errors.

**Incorrect:**

```elixir
def open_decoded_file(path) do
  with {:ok, encoded} <- File.read(path),
       {:ok, decoded} <- Base.decode64(encoded) do
    {:ok, String.trim(decoded)}
  else
    {:error, _} -> {:error, :badfile}
    :error -> {:error, :badencoding}
  end
end
```

**Correct:**

```elixir
def open_decoded_file(path) do
  with {:ok, encoded} <- file_read(path),
       {:ok, decoded} <- base_decode64(encoded) do
    {:ok, String.trim(decoded)}
  end
end

defp file_read(path) do
  case File.read(path) do
    {:ok, contents} -> {:ok, contents}
    {:error, _} -> {:error, :badfile}
  end
end

defp base_decode64(contents) do
  case Base.decode64(contents) do
    {:ok, decoded} -> {:ok, decoded}
    :error -> {:error, :badencoding}
  end
end
```

### 3. Simplify Pattern Matching in Multi-Clause Functions

Extract only the values needed for pattern matching and guards in the function signature. Bind the full struct separately for use in the body.

**Incorrect:**

```elixir
def drive(%User{name: name, age: age}) when age >= 18 do
  "#{name} can drive"
end

def drive(%User{name: name, age: age}) when age < 18 do
  "#{name} cannot drive"
end
```

**Correct:**

```elixir
def drive(%User{age: age} = user) when age >= 18 do
  "#{user.name} can drive"
end

def drive(%User{age: age} = user) when age < 18 do
  "#{user.name} cannot drive"
end
```

### 4. Never Create Atoms Dynamically from Untrusted Input

Atoms are not garbage-collected and the VM limits them to ~1 million. Never use `String.to_atom/1` on user input. Use explicit mappings or `String.to_existing_atom/1`.

**Incorrect:**

```elixir
def parse(%{"status" => status, "message" => message}) do
  %{status: String.to_atom(status), message: message}
end
```

**Correct:**

```elixir
def parse(%{"status" => status, "message" => message}) do
  %{status: convert_status(status), message: message}
end

defp convert_status("ok"), do: :ok
defp convert_status("error"), do: :error
defp convert_status("redirect"), do: :redirect
```

### 5. Group Related Parameters into Maps or Structs

DO NOT write functions with long parameter lists. Group related arguments into maps or structs.

**Incorrect:**

```elixir
def loan(user_name, email, password, user_alias, book_title, book_ed) do
  ...
end
```

**Correct:**

```elixir
def loan(%{name: name, email: email, password: password, alias: user_alias},
         %{title: title, ed: ed}) do
  ...
end
```

### 6. Use Assertive Map Access for Required Keys

Use dot syntax (`map.key`) or pattern matching for keys that must exist. Reserve bracket syntax (`map[:key]`) for optional keys. This fails fast instead of propagating `nil`.

**Incorrect:**

```elixir
def plot(point) do
  {point[:x], point[:y], point[:z]}
end
```

**Correct:**

```elixir
def plot(point) do
  {point.x, point.y, point[:z]}
end

# Or pattern match:
def plot(%{x: x, y: y, z: z}), do: {x, y, z}
def plot(%{x: x, y: y}), do: {x, y}
```

### 7. Use Assertive Pattern Matching

DO NOT write defensive code that returns plausible but incorrect values. Use pattern matching to enforce expected structure and fail immediately on unexpected input.

**Incorrect:**

```elixir
def get_value(string, desired_key) do
  parts = String.split(string, "&")
  Enum.find_value(parts, fn pair ->
    key_value = String.split(pair, "=")
    Enum.at(key_value, 0) == desired_key && Enum.at(key_value, 1)
  end)
end
```

**Correct:**

```elixir
def get_value(string, desired_key) do
  parts = String.split(string, "&")
  Enum.find_value(parts, fn pair ->
    [key, value] = String.split(pair, "=")
    key == desired_key && value
  end)
end
```

### 8. Use Strict Boolean Operators When Operands Are Booleans

When all operands are guaranteed to be booleans, use `and`/`or`/`not` instead of `&&`/`||`/`!`. The strict operators communicate intent more clearly.

**Incorrect:**

```elixir
if is_binary(name) && is_integer(age) do
  ...
end
```

**Correct:**

```elixir
if is_binary(name) and is_integer(age) do
  ...
end
```

### 9. Keep Structs Under 32 Fields

Structs with 32+ fields change from flat maps to hash maps in the Erlang VM, increasing memory usage and losing compile-time optimizations. Group related or optional fields into nested structs or maps.

---

## Design Practices

### 10. Create Separate Functions Instead of Option-Controlled Return Types

DO NOT use options that drastically change a function's return type. Create separate, explicitly-named functions for each behavior.

**Incorrect:**

```elixir
@spec parse(String.t(), keyword()) :: integer() | {integer(), String.t()} | :error
def parse(string, options \\ []) do
  if Keyword.get(options, :discard_rest, false) do
    case Integer.parse(string) do
      {int, _rest} -> int
      :error -> :error
    end
  else
    Integer.parse(string)
  end
end
```

**Correct:**

```elixir
@spec parse(String.t()) :: {integer(), String.t()} | :error
def parse(string), do: Integer.parse(string)

@spec parse_discard_rest(String.t()) :: integer() | :error
def parse_discard_rest(string) do
  case Integer.parse(string) do
    {int, _rest} -> int
    :error -> :error
  end
end
```

### 11. Use Atoms or Enums Instead of Overlapping Booleans

DO NOT use multiple booleans with overlapping or mutually exclusive states. Use a single atom value representing the distinct state.

**Incorrect:**

```elixir
def process(invoice, options \\ []) do
  cond do
    options[:admin] -> ...
    options[:editor] -> ...
    true -> ...
  end
end
```

**Correct:**

```elixir
def process(invoice, options \\ []) do
  case Keyword.get(options, :role, :default) do
    :admin -> ...
    :editor -> ...
    :default -> ...
  end
end
```

### 12. Use Pattern Matching on Return Values, Not Exceptions

Reserve `try/rescue` for truly exceptional, unexpected failures. Use functions that return `{:ok, result}` / `{:error, reason}` tuples for predictable error cases.

**Incorrect:**

```elixir
def print_file(file) do
  try do
    IO.puts(File.read!(file))
  rescue
    e -> IO.puts(:stderr, Exception.message(e))
  end
end
```

**Correct:**

```elixir
def print_file(file) do
  case File.read(file) do
    {:ok, binary} -> IO.puts(binary)
    {:error, reason} -> IO.puts(:stderr, "could not read file #{file}: #{reason}")
  end
end
```

### 13. Model Domain Concepts with Structs, Not Primitives

DO NOT use raw strings or integers to represent domain concepts. Create structs that encapsulate domain logic and provide conversion functions from primitives.

**Incorrect:**

```elixir
def extract_postal_code(address) when is_binary(address) do
  ...
end
```

**Correct:**

```elixir
defmodule Address do
  defstruct [:street, :city, :state, :postal_code, :country]
end

def parse(address) when is_binary(address) do
  # Returns %Address{}
end

def extract_postal_code(%Address{} = address) do
  ...
end
```

### 14. Split Unrelated Multi-Clause Functions

DO NOT group unrelated business logic into a single multi-clause function. If clauses handle completely different types/concerns, create distinct functions.

**Incorrect:**

```elixir
def update(%Product{} = product), do: ...
def update(%Animal{} = animal), do: ...
```

**Correct:**

```elixir
def update_product(%Product{} = product), do: ...
def update_animal(%Animal{} = animal), do: ...
```

### 15. Pass Configuration as Parameters in Libraries

Library functions should accept configuration as arguments, not read from global `Application` environment. This allows multiple consumers to use different configs.

**Incorrect:**

```elixir
def split(string) when is_binary(string) do
  parts = Application.fetch_env!(:app_config, :parts)
  String.split(string, "-", parts: parts)
end
```

**Correct:**

```elixir
def split(string, opts \\ []) when is_binary(string) and is_list(opts) do
  parts = Keyword.get(opts, :parts, 2)
  String.split(string, "-", parts: parts)
end
```

---

## Process Practices

### 16. Use Processes for Runtime Properties, Not Code Organization

DO NOT use GenServer or Agent simply to organize code. Processes model concurrency, state, and fault tolerance. Use plain modules and functions for code organization.

A GenServer wrapping pure computation creates an unnecessary bottleneck. Only introduce processes when you need concurrency, mutable state, or supervision.

### 17. Centralize Process Interaction in a Single Module

DO NOT scatter direct process calls (`Agent.get`, `Agent.update`, `GenServer.call`) across multiple modules. Wrap all process interaction in a dedicated module to enforce consistent data formats.

**Incorrect:**

```elixir
# Module A
Agent.update(pid, fn state -> Map.put(state, key, value) end)

# Module B
Agent.update(pid, fn state -> [{key, value} | state] end)  # Different format!
```

**Correct:**

```elixir
defmodule MyApp.Bucket do
  def put(pid, key, value) do
    Agent.update(pid, &Map.put(&1, key, value))
  end

  def get(pid, key) do
    Agent.get(pid, &Map.get(&1, key))
  end
end
```

### 18. Extract Only Needed Data Before Sending to Processes

Erlang processes share nothing — data is fully copied when sent between processes. Extract only the fields you need before spawning or sending messages.

**Incorrect:**

```elixir
# Copies the entire conn struct including request body
spawn(fn -> log_request_ip(conn) end)
```

**Correct:**

```elixir
ip_address = conn.remote_ip
spawn(fn -> log_request_ip(ip_address) end)
```

### 19. Always Supervise Long-Running Processes

DO NOT spawn long-running processes outside supervision trees. Supervised processes have deterministic startup/shutdown order, configurable failure strategies, and are observable.

**Incorrect:**

```elixir
{:ok, pid} = Agent.start_link(fn -> 0 end)
```

**Correct:**

```elixir
children = [
  {Agent, fn -> 0 end}
]

Supervisor.start_link(children, strategy: :one_for_one)
```

---

## Macro / Meta-programming Practices

### 20. Avoid Unnecessary Compile-Time Dependencies in Macros

When macros receive module names as arguments, those modules can become compile-time dependencies, causing unnecessary recompilation cascades. Use `Macro.expand_literals/2` to convert them to runtime dependencies.

### 21. Keep Macros Minimal — Delegate to Functions

DO NOT generate large amounts of code in macros. Keep the macro as a thin wrapper that delegates to regular functions for validation and heavy logic.

### 22. Use Functions Instead of Macros When Possible

DO NOT use macros for operations that regular functions can handle. Macros add compile-time complexity and reduce readability.

### 23. Prefer `import` Over `use` When Not Needed

`use` injects arbitrary code via `__using__/1` and can propagate hidden dependencies. Prefer explicit `import` or `alias` directives for transparency.

### 24. Use Explicit Module References for Trackable Dependencies

DO NOT construct module names dynamically at compile time (via `Module.concat` or atom strings). The compiler cannot track these dependencies, leading to stale builds.

---

## Naming Conventions

### 25. Casing Rules

- **Variables, functions, module attributes**: `snake_case`
- **Modules / aliases**: `CamelCase`. Keep acronyms uppercase: `ExUnit.CaptureIO`, `Mix.SCM`.
- **Atoms**: prefer `:snake_case`.
- **Filenames**: `snake_case.ex` matching their module (`MyApp` -> `my_app.ex`).

### 26. Trailing Bang (`!`) and Question Mark (`?`)

- Functions ending in `!` raise an exception on failure. They pair with non-bang variants that return `{:ok, result}` / `{:error, reason}`.
- Functions returning booleans use `?` suffix: `Keyword.keyword?/1`.
- Type checks allowed in guards use `is_` prefix: `is_list/1`, `is_binary/1`.

### 27. Semantic Naming Patterns

- **size vs length**: `size` = O(1) operation; `length` = O(n) traversal.
- **get / fetch / fetch!**: `get` returns a default; `fetch` returns `{:ok, value}` or `:error`; `fetch!` returns the value or raises.
- **compare/2**: returns `:lt`, `:eq`, or `:gt`.

---

## Documentation

### 28. Document Public APIs

- `@moduledoc` — document the module's purpose and behavior.
- `@doc` — document each public function before its definition.
- `@typedoc` — document types defined in typespecs.
- Keep the first paragraph concise (one line). Documentation tools extract it for summaries.
- For multi-clause functions, place `@doc` before the first clause only.

### 29. Use Doctests as Executable Examples

Include executable examples under `## Examples` sections, prefixed with `iex>`. ExUnit validates these, keeping docs and code in sync.

```elixir
@doc """
Adds two numbers.

## Examples

    iex> MyMath.add(1, 2)
    3

"""
def add(a, b), do: a + b
```

### 30. Hide Internal Modules and Functions

- `@moduledoc false` — exclude a module from generated docs.
- `@doc false` — exclude a function from generated docs.
- These do NOT make code private — functions remain callable and importable.
