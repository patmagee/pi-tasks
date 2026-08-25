# Explicit task scheduling and stack-first agent behavior

- Status: Accepted
- Date: 2026-08-25
- Decision owners: User and implementer

## Context

Pi Tasks currently persists an ordered task list and injects active task summaries into each agent turn. The summary informs the agent, but it does not make the stack the agent's default operating scope. The model also has no way to distinguish work that must stay ordered from work the user permits the agent to start concurrently.

The scheduling model must remain lightweight. It must preserve positional numbering, one-level subtasks, explicit cross-session resume, and backward compatibility with existing version 1 task-list files.

Parallel execution can increase concurrency risks. The agent must not infer permission from task wording, assignees, status, or apparent independence. Only an explicit user instruction can authorize parallel scheduling.

## Decision

### Stack-first behavior

When an attached list has active parent tasks, the stack controls the agent's default scope and execution order.

At the start of each turn:

1. If the current user message contains a separate direct instruction, the agent follows only that instruction for the turn.
2. Otherwise, the agent starts or continues the current runnable task wave.
3. The agent does not work on later blocked tasks.
4. A direct instruction does not mutate the stack unless it explicitly requests a stack change or completes stack work.
5. Stack-first behavior resumes on the next turn.

The agent marks a task `in_progress` before it starts work. It marks a task `completed` only after successful completion. Failed or blocked work remains incomplete and is reported without hiding the failure.

This is a dynamic system-prompt contract. It guides agent behavior but does not attempt to intercept or rewrite user messages.

### Scheduling field

Parent tasks gain an optional persisted field:

```ts
parallel?: boolean;
```

Missing or `false` means sequential. `true` means the user explicitly authorized the task to run as part of a parallel wave.

The `task_stack` `add` and `update` actions accept the same optional field. Subtasks reject `parallel` because subtasks remain ordered within their parent in this version.

The agent may set `parallel: true` only when the current user instruction explicitly requests parallel execution. It must not infer authorization. Setting `parallel: false` is allowed when the user requests ordered execution.

The document remains schema version 1. The field is optional, so existing files remain valid and default to sequential behavior.

### Runnable waves

The active parent array remains the source of execution order.

- If active task `1` is sequential, the runnable wave contains only task `1`.
- If active task `1` is parallel, the runnable wave is the maximal contiguous prefix of active tasks with `parallel: true`.
- The first sequential task ends a parallel wave and blocks itself and every later task until the wave completes.
- When the current wave is removed through completion or deletion, positions are recomputed and the next wave becomes runnable.
- Subtasks of each runnable parent are processed in their existing order.
- Parallel permission is eligibility, not permission to bypass safety, dependencies, or tool limits. If concurrent execution is unsafe or unavailable, the agent serializes the work and explains why.

Example:

```text
1 parallel
2 parallel
3 sequential
4 parallel
```

Tasks `1` and `2` form the current wave. Task `3` waits for both. Task `4` waits for task `3`.

### Agent context

Dynamic task context includes:

- The stack-first operating contract.
- The direct-instruction override rule.
- The current runnable wave.
- Later tasks labelled as blocked by order.
- Status, visible references, names, assignees, and parallel markers.

The context continues to be added through `before_agent_start`. It is not appended as repeated session messages.

### Display

Widget, full-list, plain-list, and agent-summary output mark parallel parent tasks with `∥`. Subtasks do not show a parallel marker.

The full-list command remains read-only. The widget remains bounded to 10 lines.

## User decisions

The user explicitly decided:

- Tasks are the agent's next operations and its default guardrails.
- A separate direct user instruction overrides the stack.
- Parallel execution occurs only after explicit user authorization.
- Sequential execution is the default.
- Parallel scheduling applies to parent tasks only.
- Subtasks remain ordered within a parent.
- A direct override lasts for one turn, and stack-first behavior resumes on the next turn.

## Agent-selected implementation details

The implementation uses a boolean field and contiguous front waves. This is the smallest representation that distinguishes ordered and explicitly parallel work without adding group lifecycle or dependency identifiers.

## Alternatives considered

### Parallel group identifiers

Tasks could carry a generated or user-visible group identifier. This supports named and non-contiguous groups, but it adds group creation, editing, validation, rendering, and migration behavior. It is not needed for front-of-stack execution waves.

### Dependency graph

Tasks could reference predecessor identifiers. This models arbitrary scheduling but conflicts with the extension's positional, lightweight interface. It would expose or translate stable identifiers and require cycle detection.

### Infer parallelism

The agent could infer independence from task descriptions or assignees. This was rejected because inference can violate user intent and create unsafe concurrent operations.

## Consequences

### Positive

- The stack becomes actionable rather than informational.
- Ordered work has an explicit blocking rule.
- Users can authorize simple parallel waves without managing dependencies.
- Existing files remain compatible.
- The agent receives clear constraints after compaction and session restoration.

### Negative

- Stack-first behavior depends on model compliance with the system prompt.
- Boolean waves cannot represent non-contiguous or nested parallel groups.
- Parallel task completion can renumber remaining visible references.
- A user who wants parallel work must state that intent explicitly.

## Invariants

- Sequential is the default.
- Only explicit user authorization can produce `parallel: true` through the agent.
- Task `1` always belongs to the current runnable wave.
- No task after the current wave is runnable.
- A sequential task forms a wave of one.
- A parallel wave is a contiguous active prefix.
- Subtasks are never parallel-marked.
- Direct instructions override stack-first behavior for one turn only.
- Completion is recorded only after successful work.
- Existing version 1 files without `parallel` parse as sequential.
- Completed parent history preserves the task's scheduling field for provenance.

## Acceptance scenarios

### Sequential default

Given an existing or newly added task without a parallel field, when the agent determines the runnable wave, then only active task `1` is runnable.

### Explicit parallel wave

Given the user explicitly asks for three tasks to run in parallel, when the agent adds those tasks, then all three persist `parallel: true` and form one runnable wave while they remain the contiguous active prefix.

### Sequential barrier

Given two parallel tasks followed by a sequential task and another parallel task, when the first wave is active, then only the first two tasks are runnable. After both complete, the sequential task runs alone. The final parallel task waits.

### Direct override

Given active tasks and a user message with a separate direct instruction, when the agent handles that turn, then it performs only the direct instruction and does not start a stacked task. On the next turn without a separate instruction, the stack is again the default scope.

### Ordered subtasks

Given a runnable parallel parent with several subtasks, when the agent works on that parent, then it processes those subtasks in order and does not mark them parallel.

### Backward compatibility

Given a valid version 1 task-list file without parallel fields, when the store reads it, then every parent behaves as sequential and the file is not rewritten merely because it was read.

### Failed work

Given a runnable task whose operation fails, when the agent reports the result, then the task is not marked completed and later blocked tasks do not become runnable.

## Excluded work

- Arbitrary dependency graphs.
- Named parallel groups.
- Non-contiguous parallel waves.
- Parallel subtasks.
- Automatic inference of parallel safety or user authorization.
- Runtime interception of direct user messages.
- Automatic cancellation or rollback of background jobs.
- Stable identifiers in the user-facing task interface.
