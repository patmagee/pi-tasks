import assert from "node:assert/strict";
import test from "node:test";
import { applyMutation, createTaskList, formatPlainList, type TaskStatus } from "../src/model.ts";

// @ts-expect-error Unsupported statuses must stay outside the public model.
const unsupportedStatus: TaskStatus = "done";
void unsupportedStatus;

const ids = (...values: string[]) => {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
};

const now = "2026-08-24T12:00:00.000Z";

test("task list records its schema version and origin session", () => {
  const document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  assert.equal(document.version, 1);
  assert.equal(document.originSessionId, "session-1");
});

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

// ---------------------------------------------------------------------------
// Transition builders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Transition tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Edge-case tests
// ---------------------------------------------------------------------------

test("pop on an empty task list throws", () => {
  const document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  assert.throws(
    () => applyMutation(document, { action: "pop" }, now, ids()),
    /no active tasks/i,
  );
});

test("pop throws when the first task has incomplete subtasks", () => {
  const document = documentWithParentAndSubtasks();
  assert.throws(
    () => applyMutation(document, { action: "pop" }, now, ids()),
    /complete all subtasks/i,
  );
});

test("update with null assignee removes an existing assignee", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Work" }, now, ids("w")).document;
  document = applyMutation(document, { action: "update", task: "1", assignee: "alice" }, now, ids()).document;
  document = applyMutation(document, { action: "update", task: "1", assignee: null }, now, ids()).document;
  assert.equal("assignee" in document.active[0]!, false);
});

test("adding a subtask to a subtask reference throws", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Parent" }, now, ids("p")).document;
  document = applyMutation(document, { action: "add", name: "Sub", parent: "1" }, now, ids("s")).document;
  assert.throws(
    () => applyMutation(document, { action: "add", name: "Deep", parent: "1.1" }, now, ids()),
    /nest subtasks/i,
  );
});

test("move clamps an out-of-range position to the last slot", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  for (const name of ["A", "B", "C"]) {
    document = applyMutation(document, { action: "add", name }, now, ids(name)).document;
  }
  document = applyMutation(document, { action: "move", task: "1", position: 99 }, now, ids()).document;
  assert.deepEqual(document.active.map((t) => t.name), ["B", "C", "A"]);
});

test("move succeeds for a subtask within its parent", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Parent" }, now, ids("p")).document;
  document = applyMutation(document, { action: "add", name: "First", parent: "1" }, now, ids("f")).document;
  document = applyMutation(document, { action: "add", name: "Second", parent: "1" }, now, ids("s")).document;
  document = applyMutation(document, { action: "move", task: "1.1", position: 2 }, now, ids()).document;
  assert.deepEqual(document.active[0]?.subtasks.map((s) => s.name), ["Second", "First"]);
});

test("delete throws when the reference does not exist", () => {
  const document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  assert.throws(
    () => applyMutation(document, { action: "delete", task: "5" }, now, ids()),
    /not found/i,
  );
});

test("move rejects a reference after the task has been archived", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Solo" }, now, ids("s")).document;
  document = applyMutation(document, { action: "update", task: "1", status: "completed" }, now, ids()).document;
  assert.throws(
    () => applyMutation(document, { action: "move", task: "1", position: 1 }, now, ids()),
    /not found/i,
  );
});

test("update rejects a reference after the task has been archived", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Solo" }, now, ids("s")).document;
  document = applyMutation(document, { action: "update", task: "1", status: "completed" }, now, ids()).document;
  assert.throws(
    () => applyMutation(document, { action: "update", task: "1", status: "in_progress" }, now, ids()),
    /not found/i,
  );
});

test("formatPlainList uses distinct glyphs and renders the completed section", () => {
  let document = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  document = applyMutation(document, { action: "add", name: "Working" }, now, ids("w")).document;
  document = applyMutation(document, { action: "update", task: "1", status: "in_progress" }, now, ids()).document;
  document = applyMutation(document, { action: "add", name: "Done" }, now, ids("d")).document;
  document = applyMutation(document, { action: "update", task: "2", status: "completed" }, now, ids()).document;
  const output = formatPlainList(document, true);
  assert.match(output, /◑ Working/);
  assert.match(output, /Completed/);
  assert.match(output, /✓ Done/);
  assert.equal(output.indexOf("Completed") < output.indexOf("✓ Done"), true);
});

test("invalid names references and positions do not mutate the source", () => {
  const source = createTaskList("00000000-0000-4000-8000-000000000001", "session-1", now);
  assert.throws(() => applyMutation(source, { action: "add", name: "   " }, now, ids("x")), /name/i);
  assert.throws(() => applyMutation(source, { action: "move", task: "2", position: 1 }, now, ids()), /not found/i);
  assert.deepEqual(source.active, []);
});
