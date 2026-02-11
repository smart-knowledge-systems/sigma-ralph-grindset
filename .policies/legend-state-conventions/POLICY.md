# Legend State Conventions Policy

Auditable rules extracted from the Legend State (v3) usage patterns documented in `src/frontend/observable/stores.ts`.
Use these rules to evaluate whether code follows proper Legend State reactive state management conventions.

**References:**

- https://legendapp.com/open-source/state/v3/react/react-api/
- https://legendapp.com/open-source/state/v3/react/fine-grained-reactivity/
- https://legendapp.com/open-source/state/v3/guides/patterns/

---

## 1. State Organization Pattern

- This codebase uses the **"Multiple Individual Atoms"** pattern with domain-separated stores.
- Each store is a standalone observable defined in `src/frontend/observable/stores.ts`:
  - `readingSessionStore$` - Reading progress, page state, WPM
  - `uiStateStore$` - Highlighting, engagement, playback
  - `exerciseStore$` - Vocabulary exercises, choices
  - `appStore$` - Session ID, fluency cache, learning records
  - `vocabularyExerciseStore$` - Word list exercises
  - `orientationStore$` - Zoom orientation session state
- Import stores directly where needed: `import { readingSessionStore$ } from "@/frontend/observable/stores"`
- Do NOT create local observables in components unless they are truly component-local state.

## 2. Reading State: useValue() Hook

- **Primary hook for reactive rendering** - component re-renders when the observed value changes.
- Syntax: `const value = useValue(store$.property)`
- Example: `const page = useValue(readingSessionStore$.currentPage)`
- Supports suspense mode: `useValue(store$.data, { suspense: true })`
- Use `useValue()` when:
  - You need the value in the component's render output
  - The component should re-render when the value changes
  - You're reading a store value that affects what the component displays

## 3. Reading State: observer() Wrapper

- Wrap components with `observer()` to auto-track all observable access inside the component.
- Reduces hook overhead compared to multiple `useValue()` calls.
- Syntax: `export const MyComponent = observer(() => { ... })`
- **IMPORTANT**: `.get()` is NOT supported in observer components (as of v3.0.0-beta.20+). Use direct property access instead.
- Example:

  ```tsx
  export const Counter = observer(() => {
    // ✅ Correct - direct access
    return <div>{appStore$.sessionId}</div>;

    // ❌ Wrong - .get() not supported
    return <div>{appStore$.sessionId.get()}</div>;
  });
  ```

- Use `observer()` when:
  - A component reads multiple observable properties
  - You want automatic tracking without explicit `useValue()` calls
  - The component needs to re-render based on observable changes

## 4. Reading State: peek() Method

- **Non-reactive snapshot read** - does NOT create a subscription, does NOT trigger re-renders.
- Syntax: `const value = store$.property.peek()`
- Example: `const current = exerciseStore$.choices.peek()`
- Use `peek()` in:
  - `useCallback` hooks
  - Event handlers (onClick, onChange, etc.)
  - Utility functions that shouldn't trigger re-renders
  - Conditional logic where you need current value but don't want reactivity
- Do NOT use `peek()` if you need the component to re-render when the value changes.

## 5. Reactive Side Effects: useObserve()

- Runs side effects **DURING render** (not after mount).
- Call `.get()` on observables inside the selector to subscribe to changes.
- Use **two-callback pattern** for side effects:
  ```tsx
  useObserve(
    () => store$.value.get(), // selector (tracks dependencies)
    ({ value }) => doSideEffect(value) // reaction (runs on change)
  );
  ```
- The selector function establishes what to observe.
- The reaction function executes when observed values change.
- Do NOT perform side effects directly in the selector - move them to the reaction callback.

## 6. Reactive Side Effects: useObserveEffect()

- Same as `useObserve()` but runs **AFTER component mount** (like `useEffect`).
- Preferred for:
  - DOM manipulation
  - Focus management
  - Animations
  - Most side effect use cases
- Example:
  ```tsx
  useObserveEffect(
    () => uiStateStore$.isDrawerOpen.get(),
    ({ value: isOpen }) => {
      if (isOpen) focusDrawerInput();
    }
  );
  ```

## 7. Fine-Grained Reactivity: <Memo>

- Creates a **self-updating island** that re-renders independently from its parent.
- Syntax: `<Memo>{() => <div>{store$.value.get()}</div>}</Memo>`
- Parent component does NOT re-render when the value inside `<Memo>` changes.
- Use `<Memo>` to:
  - Isolate frequently-updating values from parent re-renders
  - Optimize performance for expensive parent components
  - Create reactive sections within non-reactive components
- `<Memo>` only tracks `.get()` calls on observables inside its render function.
- **Do NOT use** `<Memo>` for components that receive props from parent - it will break prop updates.

## 8. Setter Pattern

- **Direct value replacement**: `store$.property.set(value)`
- Example: `readingSessionStore$.currentPage.set(3)`
- For **complex types** (Map, Array, Set):

  ```tsx
  // ✅ Correct - immutable update pattern
  const current = store$.map.peek();
  const updated = new Map(current);
  updated.set(key, value);
  store$.map.set(updated);

  // ❌ Wrong - mutating the current value
  const current = store$.map.peek();
  current.set(key, value);
  store$.map.set(current);
  ```

- Always create a new instance when updating complex types to ensure reactivity works correctly.

## 9. <Memo> Component Tracking Rules

- `<Memo>` only tracks `.get()` calls on observables inside its render function.
- Components that receive props from a parent should NOT be wrapped in `<Memo>`.
- Wrapping prop-receiving components in `<Memo>` breaks prop updates because `<Memo>` only tracks observables, not props.
- Example:

  ```tsx
  // ✅ Correct - <Memo> wraps self-contained observable access
  <Memo>{() => <div>{store$.count.get()}</div>}</Memo>

  // ❌ Wrong - component receives props, don't use <Memo>
  <Memo>{() => <ChildComponent value={propValue} />}</Memo>
  ```

## 10. Anti-Patterns

### ❌ Using .get() in Component Render Body

- **Problem**: `store$.property.get()` in render body does not create reactivity.
- **Why it's wrong**: The component won't re-render when the value changes.
- **Fix**: Use `useValue(store$.property)` or wrap component with `observer()`.
- Example:

  ```tsx
  // ❌ Wrong - no reactivity
  const MyComponent = () => {
    const page = readingSessionStore$.currentPage.get();
    return <div>{page}</div>;
  };

  // ✅ Correct - use useValue()
  const MyComponent = () => {
    const page = useValue(readingSessionStore$.currentPage);
    return <div>{page}</div>;
  };

  // ✅ Also correct - use observer()
  const MyComponent = observer(() => {
    return <div>{readingSessionStore$.currentPage}</div>;
  });
  ```

### ❌ Using useObserve() Without Reaction Callback

- **Problem**: `useObserve(() => store$.x.get())` with no second argument.
- **Why it's wrong**: If you just need reactivity for rendering, `useValue()` is the right tool. `useObserve()` is for side effects.
- **Fix**: Use `useValue()` for rendering, or add a reaction callback for actual side effects.
- Example:

  ```tsx
  // ❌ Wrong - useObserve without reaction
  useObserve(() => store$.page.get());

  // ✅ Correct - use useValue for rendering
  const page = useValue(store$.page);

  // ✅ Also correct - useObserve with reaction for side effects
  useObserve(
    () => store$.page.get(),
    ({ value }) => logPageView(value)
  );
  ```

### ❌ Side Effects Directly in useObserve Selector

- **Problem**: Performing side effects (logging, API calls, state updates) inside the selector function.
- **Why it's wrong**: The selector should only read values and establish dependencies. Side effects belong in the reaction callback.
- **Fix**: Move side effects to the second callback (reaction).
- Example:

  ```tsx
  // ❌ Wrong - side effect in selector
  useObserve(() => {
    const page = store$.page.get();
    logPageView(page); // ❌ Side effect in selector
  });

  // ✅ Correct - side effect in reaction
  useObserve(
    () => store$.page.get(),
    ({ value }) => logPageView(value) // ✅ Side effect in reaction
  );
  ```
