---
title: Lightweight Pi task stack extension
date: 2026-08-24
repo: pi-tasks
services: [pi-tasks]
tags: [workflow, frontend, testing]
status: active
decisions:
  - Store each task list in a separate repository-local file under .pi/tasks/
  - Require explicit attachment before a new session can resume an existing task list
  - Restore attachments automatically when the same session resumes or reloads
  - Compute visible task and subtask numbers from their current list positions
  - Keep completed parent tasks in a separate section
  - Limit task nesting to one subtask level
  - Expose one task_stack agent tool and one /task-stack user command
  - Hide the widget when no incomplete parent tasks remain
  - Store subagent assignments as manual free-form labels
  - Keep task-list state canonical rather than rewinding it during session tree navigation
---

# Lightweight Pi task stack extension

## Summary

Build a lightweight Pi package that tracks ordered tasks for agents and users. The extension displays active tasks in a terminal user interface (TUI) widget. It persists task lists across compaction, session restart, and explicit cross-session resume.

The extension keeps unrelated sessions separate. Each task list has its own repository-local file. A new session does not discover or display old tasks until the user asks to resume them.

## Goals

- Let an agent append, insert, update, move, complete, pop, and delete tasks.
- Support one level of subtasks.
- Number active tasks by current execution order, such as `5` and `5.1`.
- Renumber active tasks and subtasks after insertion, movement, completion, or deletion.
- Show task status and optional assignee information in a widget.
- Keep completed parent tasks in a separate history section.
- Preserve state across compaction and restart of the same session.
- Let a new session explicitly resume a prior task list in the same repository.
- Prevent unrelated sessions from writing to the same task list by default.

## Non-goals

- Priority levels.
- More than one level of subtasks.
- Automatic integration with a subagent extension.
- Automatic task extraction from assistant text.
- Team synchronization or remote storage.
- Editing tasks from the full-list TUI in the first version.
- Automatic modification of a repository's `.gitignore`.

## Decisions

[HUMAN DECISION]
Use one task-list file per logical stream of work. Store files under `.pi/tasks/` in the repository. This prevents unrelated sessions from sharing one mutable file.
[/HUMAN DECISION]

[HUMAN DECISION]
A new session starts unattached. It can create a new task list or explicitly resume an existing task list. It must not display old tasks by default.
[/HUMAN DECISION]

[HUMAN DECISION]
Visible numbers represent current execution order. They are computed from array positions and change after reorder, completion, or deletion. Internal identifiers remain stable and hidden from normal use.
[/HUMAN DECISION]

[HUMAN DECISION]
Completed parent tasks move to a separate section. The next active parent becomes task `1`. Completed subtasks remain under an active parent until that parent completes.
[/HUMAN DECISION]

[HUMAN DECISION]
A parent cannot complete while any subtask remains incomplete. `pop` completes the first active parent and follows this same validation rule.
[/HUMAN DECISION]

[HUMAN DECISION]
Tasks and subtasks can have `pending`, `in_progress`, or `completed` status. Multiple items can be in progress when work runs in parallel. An optional free-form assignee label can identify a subagent.
[/HUMAN DECISION]

[HUMAN DECISION]
Expose one `task_stack` tool with a small action set. Use `/task-stack` for the read-only full-list interface because `/tasks` is already owned by another extension.
[/HUMAN DECISION]

[AI DECISION]
Treat the task-list file as canonical current state. Session tree navigation can attach or detach a list based on the attachment marker, but it does not rewind task mutations. This avoids conflicting historical snapshots across sessions.
[/AI DECISION]

## Package structure

```text
pi-tasks/
├── extensions/
│   └── task-stack/
│       └── index.ts
├── src/
│   ├── model.ts
│   ├── render.ts
│   └── store.ts
├── tests/
│   ├── lifecycle.test.ts
│   ├── model.test.ts
│   └── store.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

`extensions/task-stack/index.ts` owns Pi integration. It registers lifecycle handlers, the agent tool, the command, and the widget.

`src/model.ts` owns task data, computed references, transitions, ordering, and validation. It has no Pi or file-system dependency.

`src/store.ts` owns discovery, parsing, schema validation, per-list locking, and atomic writes.

`src/render.ts` owns compact text formatting for the widget, tool results, and full-list view.

## Data model

Each task-list file uses a versioned JSON document:

```json
{
  "version": 1,
  "id": "task-list-uuid",
  "createdAt": "2026-08-24T12:00:00.000Z",
  "updatedAt": "2026-08-24T12:05:00.000Z",
  "originSessionId": "pi-session-uuid",
  "active": [
    {
      "id": "task-uuid",
      "name": "Implement persistence",
      "status": "in_progress",
      "assignee": "store-agent",
      "subtasks": [
        {
          "id": "subtask-uuid",
          "name": "Add atomic writes",
          "status": "completed"
        }
      ]
    }
  ],
  "completed": []
}
```

A task name must contain non-whitespace text. An assignee is optional free-form text. Empty assignee input clears the assignment.

Top-level entries in `active` use `pending` or `in_progress`. Completing a top-level task moves its whole tree to `completed`. A completed subtask can remain inside an active parent.

Completed parent trees are appended to `completed` in completion order. Completed-section numbers are local to that section and do not affect active numbering.

## Numbering and references

Visible references are computed and are not persisted:

- Active parent at array index 0: `1`.
- Its first subtask: `1.1`.
- Completed parent at array index 0: `1` in the completed section.

Tool operations use visible references. Operations against completed tasks must set `section: "completed"` because active and completed sections have independent numbers.

Every mutation reads the latest document while holding the list lock. It resolves the reference against that version and returns the new active list. Tool guidance tells agents not to submit dependent numbered mutations in one parallel tool batch.

## Agent tool

Register one tool named `task_stack` with these actions:

| Action | Main inputs | Result |
|---|---|---|
| `add` | `name`, optional `position`, optional `parent` | Append by default. Insert when a position is present. A parent reference creates a subtask. |
| `update` | `task`, optional `name`, `status`, or `assignee` | Change one or more fields. Completing a parent archives its tree after validation. |
| `move` | `task`, `position` | Reorder an active parent or a subtask within its current parent. |
| `pop` | None | Complete and archive active task `1`. |
| `delete` | `task`, optional `section` | Permanently remove an active or completed item. |
| `list` | optional `includeCompleted` | Return active tasks or both sections. |
| `resume` | optional `taskListId` | Without an identifier, return resume candidates. With an identifier, attach that list. |

`add` in an unattached session creates a new task list and appends a session attachment marker. It does not modify older task lists.

`resume` without an identifier is discovery only. Candidate results include the task-list identifier, last update time, active count, completed count, and first available task name. The agent calls `resume` again with the selected identifier after the user chooses or clearly identifies a candidate.

The tool returns errors by throwing. Failed validation and persistence operations do not mutate in-memory state or replace a valid file.

## Transition rules

- `pending` to `in_progress` is valid for active parents and subtasks.
- `in_progress` to `pending` is valid.
- An active subtask can become `completed` and remains under its parent.
- A parent can become `completed` only when every subtask is completed.
- Completing a parent moves the tree from `active` to `completed`.
- `pop` applies parent completion to active task `1`.
- Completed parent trees cannot reopen or move in the first version.
- Delete can permanently remove an active parent, active subtask, completed parent, or completed subtask.
- Move cannot move a subtask between parents in the first version.
- Position must be within the existing range or exactly one position after it for insertion.

## Persistence and session attachment

Task lists use this path:

```text
<repository-root>/.pi/tasks/<task-list-id>.json
```

The extension resolves the repository root with Git when possible. If the working directory is not inside a Git repository, it uses `ctx.cwd`. This keeps sessions started from different subdirectories of one repository on the same task-list namespace.

The package documentation tells users to ignore `.pi/tasks/` when task state should remain local. The extension does not modify `.gitignore` because that is a repository policy decision.

The session stores a custom entry with the attachment:

```json
{
  "customType": "pi-task-stack-attachment",
  "data": {
    "version": 1,
    "taskListId": "task-list-uuid"
  }
}
```

The extension scans the current branch for the latest valid attachment entry during `session_start` and `session_tree`.

Lifecycle behavior:

- Compaction does not affect the file or in-memory attachment.
- Reload or restart of the same session restores its attachment.
- Tree navigation before the attachment marker detaches the task list and clears the widget.
- Tree navigation after the marker reads the latest canonical task-list file. It does not restore historical task state.
- A fork inherits the attachment marker and therefore shares the logical task list.
- An unrelated new session has no marker and remains unattached.
- A missing attached file produces a clear notification and removes the widget. It does not create a replacement file silently.
- `session_shutdown` removes the widget from the old runtime.

## Concurrency and file safety

Each task-list file has an adjacent lock directory. Mutation acquires the lock with an atomic directory creation, reads the latest file, applies one operation, writes a temporary file in the same directory, and atomically renames it over the target.

A bounded lock timeout prevents indefinite waiting. Lock metadata records creation time and process information for diagnostics. A stale-lock policy can recover locks older than the documented threshold because task mutations are short operations.

Within one Pi process, mutations also use Pi's file mutation queue for the resolved task-list path. This preserves call order and coordinates with any built-in file tool that targets the same file.

Discovery and list operations do not write. They tolerate a file disappearing during discovery and report malformed candidate files without exposing tasks from them.

## Agent context after compaction

When a list is attached, `before_agent_start` appends a compact active-task summary to the system prompt for that turn. The summary contains visible references, status, names, and assignees. It does not contain completed parent history.

This dynamic prompt addition keeps the agent aware after compaction without adding repeated messages to the session file. An unattached session receives no task summary and no information about stored task lists.

## Widget

The widget appears above the editor only when at least one active parent exists.

Suggested appearance:

```text
Tasks
▶ 1 Implement persistence  @store-agent
  ✓ 1.1 Add atomic writes
  ○ 1.2 Add lock timeout
○ 2 Add task widget
```

Visual rules:

- `○` with normal text: pending.
- `▶` with accent text: in progress.
- `✓` with muted or struck text: completed subtask.
- `@label` with muted text: assignee.
- Subtasks use indentation.
- Every line is truncated safely to the available terminal width.

The widget never includes completed parent tasks. When no active parents remain, the extension calls `setWidget(..., undefined)`. It does not leave an empty-state row.

The widget is rebuilt after attachment, mutation, reload, session resume, and tree navigation. It is cleared on detachment and shutdown. This state-driven mount and unmount behavior prevents a dead widget from remaining after its runtime state disappears.

## Full-list command

`/task-stack` opens a read-only full-list TUI in interactive mode. It shows active tasks first and completed parent trees in a separate section. Escape and Control-C close the view.

In a new unattached session, the command reports that no task list is attached. It does not discover or display previous task lists. The user must ask the agent to resume previous tasks.

In non-TUI modes, the command reports that the full-list view requires interactive mode. The agent can use `task_stack` with `action: "list"` for textual output.

## Error handling

- Reject unsupported schema versions without rewriting the file.
- Reject malformed JSON with the exact affected path.
- Reject empty names.
- Reject missing or stale visible references.
- Reject invalid positions.
- Reject parent completion while any subtask remains incomplete.
- Reject movement of completed trees and cross-parent subtask moves.
- Reject a resume identifier that is not a valid task-list identifier or is not present in the current repository.
- Resolve task-list paths from validated identifiers only, so an identifier cannot escape `.pi/tasks/`.
- Report lock timeout with the task-list path.
- Keep the last valid widget state when a mutation fails.
- Clear the widget when its attached file no longer exists.

Delete is intentionally permanent. Its result names the deleted item and returns the current list so the action remains visible to the agent and user.

## Testing strategy

Use red-green-refactor for each model and persistence behavior. Keep the domain tests independent from Pi runtime APIs where possible.

### Model tests

- Add appends and inserts parents.
- Add appends and inserts subtasks.
- Visible references change after move, completion, and deletion.
- Move reorders only within the valid container.
- Status and assignee updates preserve other fields.
- Parent completion fails with incomplete subtasks.
- Parent completion archives the whole completed tree.
- Pop targets active task `1`.
- Pop fails when task `1` has incomplete subtasks.
- Delete handles both sections and subtasks.
- Empty names and stale references fail without mutation.

### Store tests

- A new list gets a unique file.
- Multiple lists coexist in one repository.
- Candidate discovery returns metadata without task contents.
- Atomic replacement preserves valid JSON.
- Concurrent mutations serialize and retain both changes.
- Lock timeout reports an error.
- Corrupt and unsupported files are not overwritten.

### Lifecycle tests

Use a small fake Pi API and user interface surface to verify:

- A new session stays unattached and hides the widget.
- The first add creates and attaches a new list.
- Explicit resume attaches the selected list.
- Session restart restores the latest branch attachment.
- Tree navigation before the marker detaches and hides the widget.
- An active list mounts the widget.
- Completing the final parent removes the widget.
- Shutdown clears the widget.
- Dynamic agent context appears only while attached.

### Manual smoke test

Run the package with `pi -e .` in a temporary Git repository. Verify tool calls, `/task-stack`, compaction, `/new`, `/resume`, `/fork`, `/reload`, narrow terminal rendering, and two Pi processes mutating one intentionally shared list.

## Documentation

The README must include:

- Local and Git package installation.
- The `task_stack` action table.
- `/task-stack` usage.
- Status and assignee behavior.
- Explicit cross-session resume behavior.
- The `.pi/tasks/` storage path.
- Suggested `.gitignore` entry.
- The permanent nature of delete.
- The concurrency limitation and lock behavior.
