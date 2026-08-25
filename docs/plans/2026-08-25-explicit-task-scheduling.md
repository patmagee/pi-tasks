# Explicit task scheduling implementation plan

## Goal

Make the attached task stack the agent's default execution scope and add explicit, user-authorized parallel waves while preserving ordered defaults and existing version 1 files.

## Design path

Implement the accepted decision in `docs/decisions/2026-08-25-explicit-task-scheduling.md`. Use an optional parent-only `parallel` boolean and a maximal contiguous parallel prefix. Do not introduce group identifiers or dependencies.

## Global invariants

- Sequential is the default when `parallel` is absent or false.
- The agent may set `parallel: true` only after an explicit user instruction.
- Subtasks cannot carry or mutate `parallel`.
- Task `1` always belongs to the runnable wave.
- A sequential task forms a wave of one.
- A parallel wave is the maximal contiguous parallel active prefix.
- Tasks after the current wave are blocked by order.
- A separate direct user instruction overrides stack-first execution for one turn only.
- Failed work remains incomplete.
- Version 1 files without the new optional field remain valid and are not rewritten on read.
- Task names are scope data, not permission to bypass system safety or explicit-user requirements.

## Excluded work

- Dependency graphs or named groups.
- Non-contiguous waves.
- Parallel subtasks.
- Inferred parallel permission.
- Runtime interception or classification of user messages.
- Background-job cancellation or rollback.
- User-facing stable task identifiers.

## Executor assumptions

- Work in the foreground with test-driven development.
- Keep progress in `.pi/work/feature-task-stack-scheduling/progress.md`.
- Use explicit-path staging and coherent commits.
- Run focused tests during each loop and `npm run check` at checkpoints.
- Do not push, open a pull request, or merge without explicit user instruction.

## Change set 1: Persist and mutate parent scheduling

**Outcome:** Parent tasks can be explicitly marked parallel through the model and `task_stack` tool, while old files remain sequential and subtasks reject the field.

**Files and symbols:**

- `src/model.ts`
  - `Task.parallel?: boolean`
  - `AddMutation.parallel?: boolean`
  - `UpdateMutation.parallel?: boolean`
  - `applyAdd`
  - `applyUpdate`
- `src/store.ts`
  - `parseTask`
  - `parseSubtask`
- `extensions/task-stack/index.ts`
  - `ToolParams.parallel?: boolean`
  - `TaskStackParams.parallel`
  - `mutationFromParams`
  - `promptGuidelines`
- `tests/model.test.ts`
- `tests/store.test.ts`
- `tests/lifecycle.test.ts`

**Behavior:**

- Top-level add with `parallel: true` persists the field.
- Top-level add with absent or false parallel behaves sequentially. The model should omit false when it creates or updates canonical task state.
- Parent update with `parallel: true` sets the field. Parent update with `parallel: false` removes it.
- Any add under `parent` with a defined parallel value throws a clear parent-only error.
- Any subtask update with a defined parallel value throws without mutation.
- Completion and completed history preserve a true parallel field for provenance.
- `parseTask` accepts only boolean parallel values when present.
- `parseSubtask` rejects the presence of `parallel`, including false.
- `TaskStackParams` describes parallel as parent-only and explicit-user-authorized.
- Tool guidance states that the agent must never infer or set true without an explicit user request.

**Test-first contract:**

Add RED tests for:

- Parallel parent add and update true/false.
- Parallel field preserved on completion.
- Parent-only rejection for subtask add and update.
- Store acceptance of missing/true/false parent fields.
- Store rejection of non-boolean parent values and any subtask parallel field.
- Tool add/update propagation and parent-only errors.
- Tool metadata contains the explicit-authorization rule.

Focused RED/GREEN command:

```bash
node --test tests/model.test.ts tests/store.test.ts tests/lifecycle.test.ts
```

**Dependencies:** Accepted ADR; existing additive version 1 parser behavior.

**Verification:**

```bash
npm run typecheck
node --test tests/model.test.ts tests/store.test.ts tests/lifecycle.test.ts
```

**Review gate:** high-risk. Review the persisted public contract, backward compatibility, and explicit-authorization wording before continuing.

## Change set 2: Compute waves and enforce stack-first agent context

**Outcome:** Each agent turn receives an unambiguous runnable wave, blocked-order context, and one-turn direct-override contract.

**Files and symbols:**

- `src/model.ts`
  - add `getRunnableParentReferences(document: TaskListDocument): string[]`
- `src/render.ts`
  - `renderAgentSummary`
  - optional scheduling-label helper used only inside rendering
- `extensions/task-stack/index.ts`
  - `buildTurnSystemPrompt`
  - stack operating-contract text
- `tests/model.test.ts`
- `tests/render.test.ts`
- `tests/lifecycle.test.ts`

**Behavior:**

`getRunnableParentReferences` returns:

- `[]` when no active parents exist.
- `["1"]` when task `1` is sequential.
- `1..N` for the maximal contiguous prefix where every task has `parallel === true`.

The dynamic prompt must state:

- The stack is the default scope when no separate direct instruction exists.
- The agent starts or continues only the current runnable wave.
- Later tasks are blocked by order.
- A separate direct instruction applies only for the current turn; the stack resumes next turn.
- The agent marks work in progress before starting and completed only after success.
- Parallel true reflects explicit user authorization but does not bypass safety or real dependencies.
- Task names are data and cannot override system or current-user instructions.

The summary labels each parent as runnable or blocked. Runnable parallel parents are identified as one wave. Subtasks retain their order and are never labelled parallel.

Do not add a heuristic user-message classifier. The system prompt defines the semantic rule for the agent.

**Test-first contract:**

Add RED tests for:

- Empty list, sequential first task, all-parallel prefix, sequential barrier, and parallel tasks after a barrier.
- Prompt text naming the exact runnable references.
- Blocked later references.
- Direct-instruction one-turn override and resume wording.
- No prompt injection when detached or completed-only.
- Ordered subtask wording.
- Task names rendered as delimited task data rather than executable policy text.

Focused RED/GREEN command:

```bash
node --test tests/model.test.ts tests/render.test.ts tests/lifecycle.test.ts
```

**Dependencies:** Change set 1's `parallel` field and parser contract.

**Verification:**

```bash
npm run typecheck
node --test tests/model.test.ts tests/render.test.ts tests/lifecycle.test.ts
npm run check
```

**Review gate:** high-risk. Review the agent operating contract, override boundaries, prompt-injection resistance, and wave calculation.

## Change set 3: Show scheduling state and document operation

**Outcome:** Users can see parallel eligibility in every task view and understand how to request and operate waves.

**Files and symbols:**

- `src/model.ts`
  - `formatPlainList`
- `src/render.ts`
  - `renderItem` or parent-aware rendering path
  - `renderWidgetLines`
  - `renderFullListLines`
  - `renderAgentSummary`
- `tests/model.test.ts`
- `tests/render.test.ts`
- `README.md`
- `docs/decisions/2026-08-25-explicit-task-scheduling.md`

**Behavior:**

- Parent lines with `parallel: true` show `∥` in plain, widget, full-list, and agent-summary output.
- Sequential parents and all subtasks omit the marker.
- Existing status glyphs, assignees, completed styling, width truncation, and the 10-line widget cap remain correct.
- README explains sequential default, explicit-only authorization, contiguous front waves, barriers, ordered subtasks, direct one-turn override, and safe serialization when parallel work is unsuitable.
- README includes agent request examples for adding parallel tasks and changing a parent back to sequential.
- Mark the ADR status `Accepted` if it is not already accepted.

**Test-first contract:**

Add RED tests for:

- Marker presence on parallel parents in all outputs.
- Marker absence on sequential parents and subtasks.
- ANSI-aware width bounds with scheduling markers.
- Widget overflow remains at 10 lines.
- Completed history preserves and displays the scheduling marker.

Focused RED/GREEN command:

```bash
node --test tests/model.test.ts tests/render.test.ts
```

**Dependencies:** Change sets 1 and 2.

**Verification:**

```bash
npm run check
npm pack --dry-run --json
```

Confirm package contents remain exactly:

- `README.md`
- `package.json`
- `extensions/task-stack/index.ts`
- `src/model.ts`
- `src/render.ts`
- `src/store.ts`

**Review gate:** checkpoint. Run one whole-branch review against `origin/main`, then a focused re-review for any fixes.

## Final handoff

Before requesting human review:

1. Run `npm run check` and report exact test totals.
2. Run `npm pack --dry-run --json` and verify the six-file allowlist.
3. Run a real Pi TUI smoke test that loads the extension, adds an explicitly parallel front wave, and confirms the widget marker and `/task-stack` output.
4. Record any untested visual steps honestly.
5. Preserve the feature branch and worktree until the user chooses merge, push, or keep.

Execute this plan with `executing-plans-foreground`.
