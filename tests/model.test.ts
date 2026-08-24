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
