# Task Stack Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable Pi extension that tracks ordered, hierarchical task lists across compaction and explicit cross-session resume.

**Architecture:** Pure domain functions own task transitions and computed numbering. A repository-local store keeps one locked, atomic JSON file per task list. The Pi entry point attaches sessions to lists, injects active context, and mounts or removes the TUI widget from current runtime state.

**Tech Stack:** TypeScript, Node.js 24 built-in test runner, Pi extension API, TypeBox, and Pi TUI.

**Spec:** `docs/superpowers/specs/2026-08-24-task-stack-extension-design.md`

## Global Constraints

- Store task lists at `<repository-root>/.pi/tasks/<task-list-id>.json`.
- Use one task-list file per logical stream of work.
- A new session must not discover or display old task contents without explicit `resume` use.
- Restore the attachment automatically for the same session, reload, or inherited fork.
- Compute visible active numbers from current positions. Do not persist them.
- Limit nesting to one subtask level.
- Keep completed parent trees in a separate section.
- A parent cannot complete while a subtask is incomplete.
- Multiple active items can be `in_progress`.
- Store assignees as optional free-form labels.
- Expose one `task_stack` tool and one `/task-stack` command.
- Remove the widget when no active parent tasks remain.
- Treat the task-list file as canonical. Session tree navigation does not rewind mutations.
- Use red-green-refactor for every behavior change.
- Stage explicit paths. Never use `git add .` or `git add -A`.

---

## File map

- `package.json`: Pi package manifest, scripts, peer dependencies, and development dependencies.
- `tsconfig.json`: strict TypeScript configuration for extension, source, and tests.
- `src/model.ts`: versioned task types, reference resolution, immutable mutations, transition validation, and plain summaries.
- `src/store.ts`: repository root resolution, list discovery, schema parsing, lock acquisition, and atomic persistence.
- `src/render.ts`: width-safe widget lines, full-list lines, and compact agent context.
- `extensions/task-stack/index.ts`: Pi schemas, tool execution, session attachment, command, context injection, and widget lifecycle.
- `tests/model.test.ts`: domain mutation and numbering tests.
- `tests/store.test.ts`: persistence, discovery, locking, and corruption tests.
- `tests/render.test.ts`: visual-state and width tests.
- `tests/lifecycle.test.ts`: attachment reconstruction and widget visibility tests through exported pure helpers.
- `README.md`: installation, storage, actions, resume workflow, visual states, and deletion warning.

### Shared interfaces

`src/model.ts` produces these interfaces for all later tasks:

```ts
export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskSection = "active" | "completed";

export interface Subtask {
  id: string;
  name: string;
  status: TaskStatus;
  assignee?: string;
}

export interface Task extends Subtask {
  subtasks: Subtask[];
}

export interface TaskListDocument {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  originSessionId: string;
  active: Task[];
  completed: Task[];
}

export type MutationOperation =
  | { action: "add"; name: string; position?: number; parent?: string }
  | { action: "update"; task: string; name?: string; status?: TaskStatus; assignee?: string | null }
  | { action: "move"; task: string; position: number }
  | { action: "pop" }
  | { action: "delete"; task: string; section?: TaskSection };

export interface MutationResult {
  document: TaskListDocument;
  message: string;
}

export type IdFactory = () => string;

export function createTaskList(id: string, originSessionId: string, now: string): TaskListDocument;
export function applyMutation(
  source: TaskListDocument,
  operation: MutationOperation,
  now: string,
  nextId: IdFactory,
): MutationResult;
export function formatPlainList(document: TaskListDocument, includeCompleted?: boolean): string;
```

`src/store.ts` produces:

```ts
export class TaskListNotFoundError extends Error {
  readonly path: string;
}

export interface TaskListCandidate {
  id: string;
  updatedAt: string;
  activeCount: number;
  completedCount: number;
  firstTaskName?: string;
}

export interface TaskListDiscovery {
  candidates: TaskListCandidate[];
  errors: string[];
}

export interface StoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

export class TaskStore {
  constructor(repositoryRoot: string, options?: StoreOptions);
  create(originSessionId: string): Promise<TaskListDocument>;
  read(id: string): Promise<TaskListDocument>;
  discover(): Promise<TaskListCandidate[]>;
  discoverAvailable(): Promise<TaskListDiscovery>;
  mutate(id: string, operation: MutationOperation, nextId?: IdFactory): Promise<MutationResult>;
  get fileRoot(): string;
}

export async function resolveRepositoryRoot(
  cwd: string,
  gitTopLevel?: (cwd: string) => Promise<string | undefined>,
): Promise<string>;
```

`src/render.ts` produces:

```ts
export interface RenderTheme {
  text(value: string): string;
  accent(value: string): string;
  muted(value: string): string;
  success(value: string): string;
  dim(value: string): string;
  strikethrough(value: string): string;
}

export function renderWidgetLines(document: TaskListDocument, width: number, theme: RenderTheme): string[];
export function renderFullListLines(document: TaskListDocument, width: number, theme: RenderTheme): string[];
export function renderAgentSummary(document: TaskListDocument): string;
```

---

### Task 1: Package foundation and ordered task model

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/model.ts`
- Create: `tests/model.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: all interfaces listed under `src/model.ts`, initially covering creation, add, update of non-completion fields, move, reference resolution, and plain active-list output.

- [ ] **Step 1: Add package configuration**

Create `package.json` with a Git-installable Pi manifest and strict validation scripts:

```json
{
  "name": "pi-tasks",
  "version": "0.1.0",
  "description": "A durable ordered task stack extension for Pi",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "tasks"],
  "pi": {
    "extensions": ["./extensions/task-stack/index.ts"]
  },
  "files": [
    "extensions/",
    "src/",
    "README.md"
  ],
  "scripts": {
    "test": "node --test tests/*.test.ts",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0"
  },
  "engines": {
    "node": ">=24"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts", "src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 2: Install development dependencies**

Run: `npm install`

Expected: `package-lock.json` and `node_modules/` are created. Installation exits with status 0.

- [ ] **Step 3: Write failing ordered-model tests**

Create `tests/model.test.ts` with deterministic identifiers and these first tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyMutation, createTaskList, formatPlainList } from "../src/model.ts";

const ids = (...values: string[]) => {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
};

const now = "2026-08-24T12:00:00.000Z";

test("add pushes parents and inserts at a one-based position", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Second" }, now, ids("task-2")).document;
  document = applyMutation(document, { action: "add", name: "First", position: 1 }, now, ids("task-1")).document;

  assert.deepEqual(document.active.map((task) => task.name), ["First", "Second"]);
  assert.match(formatPlainList(document), /^1\. ○ First\n2\. ○ Second$/);
});

test("add creates and inserts one-level subtasks", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Parent" }, now, ids("parent")).document;
  document = applyMutation(document, { action: "add", name: "Later", parent: "1" }, now, ids("later")).document;
  document = applyMutation(document, { action: "add", name: "Earlier", parent: "1", position: 1 }, now, ids("earlier")).document;

  assert.deepEqual(document.active[0]?.subtasks.map((task) => task.name), ["Earlier", "Later"]);
  assert.match(formatPlainList(document), /1\.1 ○ Earlier\n  1\.2 ○ Later/);
});

test("move renumbers parents and subtasks from current positions", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  for (const name of ["A", "B", "C"]) {
    document = applyMutation(document, { action: "add", name }, now, ids(name)).document;
  }
  document = applyMutation(document, { action: "move", task: "1", position: 3 }, now, ids()).document;

  assert.deepEqual(document.active.map((task) => task.name), ["B", "C", "A"]);
});

test("update changes name status and assignee without changing identity", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Work" }, now, ids("stable-id")).document;
  document = applyMutation(
    document,
    { action: "update", task: "1", name: "Build store", status: "in_progress", assignee: "store-agent" },
    now,
    ids(),
  ).document;

  assert.deepEqual(document.active[0], {
    id: "stable-id",
    name: "Build store",
    status: "in_progress",
    assignee: "store-agent",
    subtasks: [],
  });
});

test("invalid names references and positions do not mutate the source", () => {
  const source = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  assert.throws(() => applyMutation(source, { action: "add", name: "   " }, now, ids("x")), /name/i);
  assert.throws(() => applyMutation(source, { action: "move", task: "2", position: 1 }, now, ids()), /not found/i);
  assert.deepEqual(source.active, []);
});
```

- [ ] **Step 4: Run tests to verify red state**

Run: `node --test tests/model.test.ts`

Expected: FAIL because `src/model.ts` does not exist.

- [ ] **Step 5: Implement the minimal ordered model**

Create `src/model.ts` with the shared interfaces. Implement immutable cloning, trimmed name validation, one-based position validation, `N` and `N.M` reference parsing, add, move, and non-completion updates. Reject a parent reference on a subtask add so nesting cannot exceed one level.

Use these internal signatures to keep later work consistent:

```ts
function cloneDocument(source: TaskListDocument): TaskListDocument;
function requireName(value: string): string;
function parseReference(value: string): { parentIndex: number; subtaskIndex?: number };
function resolveActive(document: TaskListDocument, reference: string): { task: Task | Subtask; parent: Task; parentIndex: number; subtaskIndex?: number };
function insertionIndex(position: number | undefined, length: number): number;
function moveIndex(position: number, length: number): number;
```

`applyMutation` must clone before changing data, set `updatedAt`, and return a concise message. Leave completion, pop, and delete branches throwing `Unsupported mutation` until Task 2.

- [ ] **Step 6: Run model tests to verify green state**

Run: `node --test tests/model.test.ts`

Expected: all Task 1 tests pass.

- [ ] **Step 7: Run type checking**

Run: `npm run typecheck`

Expected: exits with status 0.

- [ ] **Step 8: Commit the ordered model**

```bash
git add package.json package-lock.json tsconfig.json src/model.ts tests/model.test.ts
git commit -m "Build ordered task model"
```

---

### Task 2: Completion, pop, history, and deletion

**Files:**
- Modify: `src/model.ts`
- Modify: `tests/model.test.ts`

**Interfaces:**
- Consumes: `TaskListDocument`, `MutationOperation`, `applyMutation`, and `formatPlainList` from Task 1.
- Produces: complete behavior for every `MutationOperation` variant and completed-section formatting.

- [ ] **Step 1: Add failing transition tests**

Append these explicit builders and tests:

```ts
function documentWithParentAndSubtasks() {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Parent" }, now, ids("parent")).document;
  document = applyMutation(document, { action: "add", name: "One", parent: "1" }, now, ids("one")).document;
  document = applyMutation(document, { action: "add", name: "Two", parent: "1" }, now, ids("two")).document;
  return document;
}

function readyParentFollowedByTask() {
  let document = documentWithParentAndSubtasks();
  document = applyMutation(document, { action: "update", task: "1.1", status: "completed" }, now, ids()).document;
  document = applyMutation(document, { action: "update", task: "1.2", status: "completed" }, now, ids()).document;
  document = applyMutation(document, { action: "add", name: "Next" }, now, ids("next")).document;
  return document;
}

function twoReadyParents() {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "First" }, now, ids("first")).document;
  document = applyMutation(document, { action: "add", name: "Second" }, now, ids("second")).document;
  return document;
}

function activeAndCompletedDocument() {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Done" }, now, ids("done")).document;
  document = applyMutation(document, { action: "update", task: "1", status: "completed" }, now, ids()).document;
  document = applyMutation(document, { action: "add", name: "Active" }, now, ids("active")).document;
  document = applyMutation(document, { action: "add", name: "Child", parent: "1" }, now, ids("child")).document;
  return document;
}

test("a parent cannot complete before all subtasks complete", () => {
  const document = documentWithParentAndSubtasks();
  assert.throws(
    () => applyMutation(document, { action: "update", task: "1", status: "completed" }, now, ids()),
    /complete all subtasks/i,
  );
});

test("completed subtasks remain until the parent moves to history", () => {
  let document = documentWithParentAndSubtasks();
  document = applyMutation(document, { action: "update", task: "1.1", status: "completed" }, now, ids()).document;
  assert.equal(document.active[0]?.subtasks[0]?.status, "completed");
  assert.equal(document.completed.length, 0);
});

test("completing a ready parent archives it and renumbers active tasks", () => {
  let document = readyParentFollowedByTask();
  document = applyMutation(document, { action: "update", task: "1", status: "completed" }, now, ids()).document;
  assert.equal(document.completed[0]?.status, "completed");
  assert.equal(document.active[0]?.name, "Next");
  assert.match(formatPlainList(document), /^1\. ○ Next/);
});

test("pop archives only the first active parent", () => {
  let document = twoReadyParents();
  document = applyMutation(document, { action: "pop" }, now, ids()).document;
  assert.equal(document.completed[0]?.name, "First");
  assert.equal(document.active[0]?.name, "Second");
});

test("delete removes parents and subtasks from either section", () => {
  let document = activeAndCompletedDocument();
  document = applyMutation(document, { action: "delete", task: "1.1" }, now, ids()).document;
  document = applyMutation(document, { action: "delete", task: "1", section: "completed" }, now, ids()).document;
  assert.equal(document.active[0]?.subtasks.length, 0);
  assert.equal(document.completed.length, 0);
});
```

Add explicit helper builders in the test file. Do not hide assertions inside helpers.

- [ ] **Step 2: Run the new tests to verify red state**

Run: `node --test tests/model.test.ts`

Expected: FAIL with `Unsupported mutation` or incorrect completion behavior.

- [ ] **Step 3: Implement transition validation and archive movement**

In `src/model.ts`:

- Let active subtasks transition among all three statuses.
- Let active parents transition between `pending` and `in_progress`.
- For parent `completed`, require every subtask to be `completed`, set the parent status, remove it from `active`, and append it to `completed`.
- Implement `pop` by applying the same parent-completion rule to current active task `1`.
- Resolve delete references against `active` by default or `completed` when specified.
- Allow completed subtasks and parent trees to be deleted.
- Reject move and non-delete update operations against completed history.
- Extend `formatPlainList(document, true)` with `Completed` and section-local numbering.

- [ ] **Step 4: Run all model tests**

Run: `node --test tests/model.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Add edge-case tests and refactor**

Add tests for empty pop, pop with incomplete subtasks, clearing an assignee with `null`, nested-parent references, moving a subtask between invalid bounds, and deleting a stale reference. Refactor only after these tests pass.

- [ ] **Step 6: Run focused validation**

Run: `npm run typecheck && node --test tests/model.test.ts`

Expected: both commands pass.

- [ ] **Step 7: Commit transitions**

```bash
git add src/model.ts tests/model.test.ts
git commit -m "Track task completion and history"
```

---

### Task 3: Repository-local multi-list persistence

**Files:**
- Create: `src/store.ts`
- Create: `tests/store.test.ts`

**Interfaces:**
- Consumes: model types, `createTaskList`, and `applyMutation`.
- Produces: `TaskStore`, `TaskListCandidate`, `StoreOptions`, and `resolveRepositoryRoot` from the shared interfaces.

- [ ] **Step 1: Write failing root and multi-list tests**

Create `tests/store.test.ts` with temporary directories and these helpers:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRepositoryRoot, TaskStore } from "../src/store.ts";

const fixedClock = () => new Date("2026-08-24T12:00:00.000Z");

async function temporaryRoot(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("resolveRepositoryRoot uses Git root and falls back to cwd", async () => {
  assert.equal(await resolveRepositoryRoot("/repo/sub", async () => "/repo"), "/repo");
  assert.equal(await resolveRepositoryRoot("/plain", async () => undefined), "/plain");
});

test("create writes separate versioned files and discover returns metadata", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { now: fixedClock });
  const first = await store.create("session-a");
  const second = await store.create("session-b");
  assert.notEqual(first.id, second.id);
  assert.equal((await store.discover()).length, 2);
});

test("mutate reads latest state and preserves concurrent additions", async (t) => {
  const root = await temporaryRoot(t);
  const storeA = new TaskStore(root);
  const document = await storeA.create("session-a");
  const storeB = new TaskStore(root);
  await Promise.all([
    storeA.mutate(document.id, { action: "add", name: "A" }),
    storeB.mutate(document.id, { action: "add", name: "B" }),
  ]);
  assert.deepEqual((await storeA.read(document.id)).active.map((task) => task.name).sort(), ["A", "B"]);
});
```

Also test malformed JSON, unsupported `version`, invalid identifiers, a missing file, and lock timeout.

- [ ] **Step 2: Run store tests to verify red state**

Run: `node --test tests/store.test.ts`

Expected: FAIL because `src/store.ts` does not exist.

- [ ] **Step 3: Implement repository root and schema parsing**

Create `src/store.ts`. Resolve all paths under `join(repositoryRoot, ".pi", "tasks")`. Accept only lowercase UUID identifiers matching:

```ts
const TASK_LIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
```

Implement explicit runtime validation for every persisted field. Throw errors that include the file path and field name. Do not coerce malformed values.

`resolveRepositoryRoot` must resolve the returned path and fallback path to absolute paths.

- [ ] **Step 4: Implement locking and atomic writes**

For `<id>.json`, use `<id>.lock` as an atomic lock directory:

1. Call `mkdir(lockPath)` without `recursive`.
2. On success, write `owner.json` with an ownership token, process ID, and acquisition time. If this write fails, remove the new lock before returning the error.
3. On `EEXIST`, inspect lock age and owner metadata.
4. Remove an old lock only when its recorded local owner process is no longer alive or valid owner metadata remains absent after the initialization grace period.
5. Retry until `lockTimeoutMs`, then throw a timeout error.
6. In `finally`, remove the owned lock only when its token still matches `owner.json`.

Write JSON to `<id>.<process.pid>.<randomUUID()>.tmp` in the same directory. Flush and close the file handle, rename it over `<id>.json`, then remove any remaining temporary file in `finally`.

Use defaults of 2,000 ms lock timeout, 30,000 ms stale age, and 20 ms retry delay.

- [ ] **Step 5: Implement create, read, discover, and mutate**

- `create` generates `crypto.randomUUID()`, creates an empty document, and writes while holding its list lock.
- `read` validates the identifier and parsed document.
- `discover` reads only `*.json`, ignores temporary and lock paths, returns metadata sorted by `updatedAt` descending, and throws an aggregate discovery error naming malformed files.
- `discoverAvailable` performs the same scan but returns valid candidates plus unreadable-file diagnostics. The explicit resume flow uses it so one malformed or disappearing file does not block other candidates.
- `mutate` acquires the lock, reads the latest document, calls `applyMutation`, writes the result atomically, and returns the mutation result.
- Wrap the complete read-modify-write window with Pi's `withFileMutationQueue` for the resolved JSON path.

- [ ] **Step 6: Run store tests and type checking**

Run: `npm run typecheck && node --test tests/store.test.ts`

Expected: all checks pass.

- [ ] **Step 7: Commit persistence**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "Persist isolated repository task lists"
```

---

### Task 4: Widget, full-list, and agent-context rendering

**Files:**
- Create: `src/render.ts`
- Create: `tests/render.test.ts`

**Interfaces:**
- Consumes: `TaskListDocument`, active task order, completed order, status, and assignee fields.
- Produces: `RenderTheme`, `renderWidgetLines`, `renderFullListLines`, and `renderAgentSummary`.

- [ ] **Step 1: Write failing rendering tests**

Create explicit fixtures and an identity theme. Use a second recording theme to verify which semantic style callback is selected.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskListDocument } from "../src/model.ts";
import { renderAgentSummary, renderFullListLines, renderWidgetLines, type RenderTheme } from "../src/render.ts";

const identityTheme: RenderTheme = {
  text: (value) => value,
  accent: (value) => value,
  muted: (value) => value,
  success: (value) => value,
  dim: (value) => value,
  strikethrough: (value) => value,
};

function renderFixture(): TaskListDocument {
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    originSessionId: "session-1",
    active: [
      {
        id: "parent",
        name: "Implement persistence",
        status: "in_progress",
        assignee: "store-agent",
        subtasks: [
          { id: "atomic", name: "Add atomic writes", status: "completed" },
          { id: "timeout", name: "Add lock timeout", status: "pending" },
        ],
      },
      { id: "widget", name: "Add task widget", status: "pending", subtasks: [] },
    ],
    completed: [
      { id: "old", name: "Old completed parent", status: "completed", subtasks: [] },
    ],
  };
}

function completedOnlyFixture(): TaskListDocument {
  const document = renderFixture();
  return { ...document, active: [] };
}

function longNameFixture(): TaskListDocument {
  const document = renderFixture();
  return {
    ...document,
    active: [{ ...document.active[0]!, name: "A task name that is much wider than the terminal" }],
  };
}

test("widget distinguishes pending in-progress and completed subtasks", () => {
  const lines = renderWidgetLines(renderFixture(), 120, identityTheme);
  assert.deepEqual(lines, [
    "Tasks",
    "▶ 1 Implement persistence  @store-agent",
    "  ✓ 1.1 Add atomic writes",
    "  ○ 1.2 Add lock timeout",
    "○ 2 Add task widget",
  ]);
});

test("widget returns no lines when no active parents exist", () => {
  assert.deepEqual(renderWidgetLines(completedOnlyFixture(), 80, identityTheme), []);
});

test("full list separates active and completed parent trees", () => {
  const lines = renderFullListLines(renderFixture(), 120, identityTheme);
  assert.ok(lines.includes("Completed"));
});

test("every rendered line fits the available width", () => {
  for (const line of renderWidgetLines(longNameFixture(), 24, identityTheme)) {
    assert.ok(visibleWidth(line) <= 24);
  }
});

test("agent summary excludes completed parent history", () => {
  const summary = renderAgentSummary(renderFixture());
  assert.match(summary, /1 Implement persistence/);
  assert.doesNotMatch(summary, /Old completed parent/);
});
```

For exact visual assertions, use a plain identity theme without ANSI wrappers. Add a separate semantic-theme assertion for status callback selection.

- [ ] **Step 2: Run render tests to verify red state**

Run: `node --test tests/render.test.ts`

Expected: FAIL because `src/render.ts` does not exist.

- [ ] **Step 3: Implement compact render functions**

Use `truncateToWidth` and `visibleWidth` from `@earendil-works/pi-tui`. Render:

- Pending as `○` and normal text.
- In progress as `▶` and accent text.
- Completed subtasks as `✓` and muted strikethrough text.
- Assignee as two spaces plus muted `@<assignee>`.
- Subtasks with two-space indentation.
- Active and completed headings in the full view.

`renderAgentSummary` must use plain text, include active references, status words, and assignees, and return an empty string for an empty active section.

- [ ] **Step 4: Run render tests and type checking**

Run: `npm run typecheck && node --test tests/render.test.ts`

Expected: all checks pass.

- [ ] **Step 5: Commit rendering**

```bash
git add src/render.ts tests/render.test.ts
git commit -m "Render task state in Pi interfaces"
```

---

### Task 5: Pi tool, attachment lifecycle, widget, and command

**Files:**
- Create: `extensions/task-stack/index.ts`
- Create: `tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: every public interface from `src/model.ts`, `src/store.ts`, and `src/render.ts`.
- Produces: the default Pi extension factory plus exported pure helpers `findLatestAttachment`, `shouldShowWidget`, and `buildTurnSystemPrompt` for lifecycle tests.

- [ ] **Step 1: Write failing lifecycle helper tests**

Create `tests/lifecycle.test.ts` with explicit custom-entry and document fixtures:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskListDocument } from "../src/model.ts";
import {
  buildTurnSystemPrompt,
  findLatestAttachment,
  shouldShowWidget,
} from "../extensions/task-stack/index.ts";

const attachmentEntry = (taskListId: string) => ({
  type: "custom",
  customType: "pi-task-stack-attachment",
  data: { version: 1, taskListId },
});

const detachEntry = () => ({
  type: "custom",
  customType: "pi-task-stack-attachment",
  data: { version: 1, taskListId: null },
});

function activeDocument(): TaskListDocument {
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    originSessionId: "session-1",
    active: [{ id: "task", name: "Work", status: "pending", subtasks: [] }],
    completed: [],
  };
}

function completedOnlyDocument(): TaskListDocument {
  const document = activeDocument();
  return { ...document, active: [], completed: [{ ...document.active[0]!, status: "completed" }] };
}

test("latest branch attachment wins and an explicit detach clears it", () => {
  const entries = [
    attachmentEntry("list-a"),
    attachmentEntry("list-b"),
    detachEntry(),
  ];
  assert.equal(findLatestAttachment(entries), undefined);
});

test("widget visibility requires an attachment and active parents", () => {
  assert.equal(shouldShowWidget(undefined, activeDocument()), false);
  assert.equal(shouldShowWidget("list-a", completedOnlyDocument()), false);
  assert.equal(shouldShowWidget("list-a", activeDocument()), true);
});

test("turn prompt adds active tasks only while attached", () => {
  assert.equal(buildTurnSystemPrompt("base", undefined, activeDocument()), "base");
  assert.match(buildTurnSystemPrompt("base", "list-a", activeDocument()), /Task stack attached/);
});
```

Use attachment custom type `pi-task-stack-attachment` and data version `1`. Represent detachment with the same custom type and `{ version: 1, taskListId: null }`.

- [ ] **Step 2: Run lifecycle tests to verify red state**

Run: `node --test tests/lifecycle.test.ts`

Expected: FAIL because the extension entry point does not exist.

- [ ] **Step 3: Register strict TypeBox tool parameters**

Use `StringEnum` for `action`, `status`, and `section`. Define one schema with optional fields and perform action-specific checks in execution.

The tool metadata must include:

```ts
name: "task_stack",
label: "Task Stack",
promptSnippet: "Create, order, track, complete, and resume repository task lists",
promptGuidelines: [
  "Use task_stack for the attached execution task list instead of an ad hoc checklist.",
  "Do not issue dependent task_stack mutations in one parallel tool batch because visible task numbers can change.",
  "Call task_stack with action resume only when the user asks to resume previous tasks.",
]
```

- [ ] **Step 4: Implement session attachment and repository setup**

Inside the extension factory, keep only runtime state:

```ts
let attachmentId: string | undefined;
let document: TaskListDocument | undefined;
let store: TaskStore | undefined;
```

On `session_start`:

1. Resolve the repository root using `pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd })` through the injectable root helper.
2. Construct `TaskStore`.
3. Scan `ctx.sessionManager.getBranch()` for the latest attachment.
4. Read the attached list if present.
5. Refresh or remove the widget.

On `session_tree`, repeat steps 3 through 5. On `session_shutdown`, call `ctx.ui.setWidget("task-stack", undefined)` and clear runtime references.

Append an attachment custom entry only after successful create or resume. Use a detachment marker before switching from one attached list to another, then append the new attachment marker.

- [ ] **Step 5: Implement tool execution**

- `resume` without `taskListId`: call `discoverAvailable`, warn when unreadable files were skipped, and return valid candidate metadata only. Do not attach or mount.
- `resume` with `taskListId`: read, append attachment, update runtime state, refresh widget, and return the active list.
- `add` while unattached: create a list, append attachment, then apply add.
- Other mutation while unattached: throw `No task list is attached. Add a task to start a new list or ask to resume previous tasks.`
- Mutations: call `store.mutate`, replace runtime document, refresh widget, and return `formatPlainList` plus mutation details.
- `list`: require attachment and return active or full plain text without writing.

Return structured details with `action`, `taskListId`, and the current document or candidate metadata. Custom renderers may show one compact result line and defer full list output to expanded mode.

- [ ] **Step 6: Implement status-driven widget lifecycle**

Create one `refreshWidget(ctx)` function. If detached, missing, or without active parents, call:

```ts
ctx.ui.setWidget("task-stack", undefined);
```

Otherwise register a widget factory that uses the callback theme and calls `renderWidgetLines`. Do not mount an empty component during `session_start`.

Map Pi theme methods to `RenderTheme` inside the callback. The returned component must truncate by the `render(width)` argument and implement `invalidate()`.

- [ ] **Step 7: Implement dynamic agent context**

In `before_agent_start`, return nothing while detached. While attached and active, return:

```ts
{
  systemPrompt: `${event.systemPrompt}\n\n[Task stack attached]\n${renderAgentSummary(document)}`,
}
```

Do not use `sendMessage` or append repeated task summaries to the session.

- [ ] **Step 8: Implement `/task-stack`**

In non-TUI mode, notify that interactive mode is required. In an unattached TUI session, notify that no task list is attached and that the user can ask the agent to resume.

For an attached list, use `ctx.ui.custom()` with a component that:

- Calls `renderFullListLines` for current width.
- Closes on Escape or Control-C through `matchesKey`.
- Invalidates cached lines on theme changes.
- Uses `tui.requestRender()` after input that changes component state.

The view is read-only.

- [ ] **Step 9: Run lifecycle and full validation**

Run: `npm run check`

Expected: type checking and every test pass.

- [ ] **Step 10: Commit Pi integration**

```bash
git add extensions/task-stack/index.ts tests/lifecycle.test.ts
git commit -m "Attach task lists to Pi sessions"
```

---

### Task 6: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify only if verification finds a defect: extension, source, or test files from Tasks 1 through 5.

**Interfaces:**
- Consumes: the completed package behavior.
- Produces: install and operating documentation plus recorded validation evidence in the commit history.

- [ ] **Step 1: Write README usage documentation**

Replace the current one-line README with these sections:

- What the extension does.
- Requirements: Pi and Node.js 24 or newer.
- Install from the local path and with `pi install git:github.com/patmagee/pi-tasks`.
- Add `.pi/tasks/` to `.gitignore` when task state must stay local.
- Agent action table for `add`, `update`, `move`, `pop`, `delete`, `list`, and `resume`.
- Examples for push, positional insert, subtask add, start with assignee, complete, pop, delete, and resume.
- `/task-stack` read-only full-list usage.
- Status symbols and numbering behavior.
- Explicit warning that delete is permanent.
- Explanation that forks share attachments and unrelated sessions do not.
- Explanation that tree navigation does not rewind canonical task files.
- Lock timeout and stale-lock behavior.

- [ ] **Step 2: Run automated validation**

Run: `npm run check`

Expected: type checking succeeds and every test passes with no skipped tests.

- [ ] **Step 3: Run package inspection**

Run: `npm pack --dry-run`

Expected: output includes `extensions/task-stack/index.ts`, `src/*.ts`, `README.md`, and `package.json`. It must not include `.pi/tasks/`, test temporary files, or `node_modules/`.

- [ ] **Step 4: Run interactive smoke tests**

Create a temporary Git repository outside the package and launch:

```bash
pi -e /absolute/path/to/pi-tasks
```

Verify this sequence:

1. No widget appears in a new session.
2. Ask the agent to add two tasks and one subtask.
3. Start one task with an assignee and confirm its visual style.
4. Complete the subtask, then pop task 1.
5. Confirm active task renumbering and the completed section in `/task-stack`.
6. Run `/compact` and confirm the widget and agent context remain.
7. Run `/new` and confirm no widget appears.
8. Ask to resume previous tasks and select the candidate.
9. Run `/reload`, `/resume`, and `/fork`; confirm attachment restoration.
10. Complete the final parent and confirm the widget is removed.

If interactive automation is unavailable, record the exact untested steps in the final handoff instead of claiming they passed.

- [ ] **Step 5: Verify intentional shared-list concurrency**

Start two Pi processes in the same temporary repository. Explicitly resume the same task-list identifier in both. Add one task from each process at nearly the same time. Confirm the final JSON contains both tasks and parses successfully.

If this manual test is impractical, rely on the concurrent store test and report the manual limitation.

- [ ] **Step 6: Commit documentation and any verification fixes**

```bash
git add README.md
git commit -m "Document task stack workflows"
```

If verification required code changes, stage those exact source and test paths in the same commit only when they directly support the documented behavior. Otherwise make a separate focused fix commit.

- [ ] **Step 7: Final verification before completion**

Run:

```bash
npm run check
npm pack --dry-run
git status --short
```

Expected: checks pass, package contents are correct, and the working tree contains no unexpected files.
