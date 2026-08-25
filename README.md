# Pi Tasks

Pi Tasks is a lightweight Pi extension for durable, ordered task lists. It shows active work in a widget and keeps completed parent tasks in a separate history.

Task lists are JSON files under the repository root at `.pi/tasks/<task-list-id>.json`. Each list is independent.

## Requirements

- Pi
- Node.js 24 or newer

## Install

Install from a local checkout:

```bash
pi install /absolute/path/to/pi-tasks
```

Install from GitHub:

```bash
pi install git:github.com/patmagee/pi-tasks
```

Pi loads the extension for later sessions after installation. Use `pi -e /absolute/path/to/pi-tasks` to load a local checkout for one run.

If task state must stay local, add this path to the repository `.gitignore` file:

```gitignore
.pi/tasks/
```

## Use the agent tool

Ask the agent to manage tasks. The extension provides one agent tool named `task_stack`.

| Action | Result |
| --- | --- |
| `add` | Add a parent task or one-level subtask. The first add in an unattached session creates a new list. |
| `update` | Change a task name, status, or assignee. An empty assignee clears it. |
| `move` | Move an active task to a one-based position in its current level. |
| `pop` | Complete active parent task `1`. All of its subtasks must be complete. |
| `delete` | Permanently remove an active or completed task. |
| `list` | Read the active list, with optional completed history. |
| `resume` | Discover previous lists or explicitly attach one selected list. |

Example requests:

```text
Add "Write migration" to the task stack.
Insert "Confirm backup" at position 1.
Add "Test rollback" as a subtask of task 2.
Start task 1 and assign it to worker-a.
Mark task 2.1 completed.
Pop the first task.
Delete completed task 1 permanently.
Show the full task list.
Find previous task lists in this repository, then resume the one I select.
```

The agent should discover candidates before it resumes previous work. Discovery does not attach a list. A selected list identifier is required for attachment.

Do not send dependent numbered changes in parallel. A completion, move, or deletion can renumber later tasks.

## View the full list

Run this command in Pi interactive mode:

```text
/task-stack
```

The view is read-only. It shows active tasks and completed parent history. Press Escape or Control-C to close it.

The compact widget shows at most 10 lines. If more lines exist, use `/task-stack` to view all tasks.

## Status and numbering

The widget uses these status symbols:

| Symbol | Status |
| --- | --- |
| `○` | `pending` |
| `▶` | `in_progress` |
| `✓` | `completed` |

Parent tasks use current positions such as `1` and `2`. Subtasks use references such as `1.1`. Moving, completing, or deleting a task can change later references.

Only one subtask level is supported. A parent cannot complete until all of its subtasks are complete. Multiple tasks can have `in_progress` status.

Completed parent tasks move out of the active list and into completed history. **Delete is permanent and does not move a task to history.**

## Sessions, forks, and resume

A new unrelated session starts unattached. It does not display or load previous task contents automatically. Ask the agent to discover and resume previous tasks when you want them.

Reloading or reopening the same session restores its attachment. A fork inherits the attachment from its session branch. Both branches then share the same canonical task-list file.

Navigating the session tree restores the attachment marker at that point. It does not rewind task changes. The current `.pi/tasks/<task-list-id>.json` file remains canonical.

If an attached file is missing or invalid, the extension detaches it, removes the widget, and reports the error. It does not silently select another list.

## Concurrent access

Writes use an in-process mutation queue, a cross-process lock, and atomic file replacement. The default lock wait timeout is 2 seconds. A lock becomes eligible for stale recovery after 30 seconds, but it is not reclaimed while its recorded local owner process is alive.

Two sessions can intentionally attach the same list. Their writes are serialized, but visible task positions can change after another write. Read the latest list before a position-dependent change.
