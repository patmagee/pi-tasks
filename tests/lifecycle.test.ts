import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TaskListDocument } from "../src/model.ts";
import { TaskStore } from "../src/store.ts";
import taskStackExtension, {
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

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-task-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function createHarness(root: string, entries: Array<Record<string, unknown>> = []) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  let tool: any;
  let command: any;
  let widget: unknown;
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "session-test",
    },
    ui: {
      setWidget: (_id: string, value: unknown) => { widget = value; },
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
    },
  };
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (definition: unknown) => { tool = definition; },
    registerCommand: (_name: string, definition: unknown) => { command = definition; },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  taskStackExtension(pi as never);
  return {
    ctx,
    entries,
    notifications,
    get tool() { return tool; },
    get command() { return command; },
    get widget() { return widget; },
    async fire(name: string, event: Record<string, unknown> = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

test("latest branch attachment wins and an explicit detach clears it", () => {
  const entries = [attachmentEntry("list-a"), attachmentEntry("list-b"), detachEntry()];
  assert.equal(findLatestAttachment(entries), undefined);
  assert.equal(findLatestAttachment(entries.slice(0, 2)), "list-b");
});

test("invalid attachment entries do not replace the latest valid attachment", () => {
  const entries = [
    attachmentEntry("list-a"),
    { type: "custom", customType: "pi-task-stack-attachment", data: { version: 2, taskListId: "list-b" } },
    { type: "custom", customType: "other", data: { version: 1, taskListId: null } },
  ];
  assert.equal(findLatestAttachment(entries), "list-a");
});

test("widget visibility requires an attachment and active parents", () => {
  assert.equal(shouldShowWidget(undefined, activeDocument()), false);
  assert.equal(shouldShowWidget("list-a", completedOnlyDocument()), false);
  assert.equal(shouldShowWidget("list-a", activeDocument()), true);
});

test("turn prompt adds active tasks only while attached", () => {
  assert.equal(buildTurnSystemPrompt("base", undefined, activeDocument()), "base");
  assert.equal(buildTurnSystemPrompt("base", "list-a", completedOnlyDocument()), "base");
  const prompt = buildTurnSystemPrompt("base", "list-a", activeDocument());
  assert.match(prompt, /^base\n\n\[Task stack attached\]/);
  assert.match(prompt, /1 \[pending\] Work/);
});

test("first add attaches a list and pop removes the final widget", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  assert.equal(harness.widget, undefined);

  const added = await harness.tool.execute("call-add", { action: "add", name: "Implement" }, undefined, undefined, harness.ctx);
  assert.equal(harness.entries.length, 1);
  assert.equal(typeof harness.widget, "function");
  assert.equal(added.details.document.active[0].name, "Implement");

  const popped = await harness.tool.execute("call-pop", { action: "pop" }, undefined, undefined, harness.ctx);
  assert.equal(harness.widget, undefined);
  assert.equal(popped.details.document.active.length, 0);
  assert.equal(popped.details.document.completed[0].name, "Implement");
});

test("same-session attachment restores and tree navigation before it hides the widget", async (t) => {
  const root = await temporaryRoot(t);
  const original = createHarness(root);
  await original.fire("session_start", { reason: "startup" });
  await original.tool.execute("call-add", { action: "add", name: "Resume me" }, undefined, undefined, original.ctx);

  const restored = createHarness(root, [...original.entries]);
  await restored.fire("session_start", { reason: "resume" });
  assert.equal(typeof restored.widget, "function");

  restored.entries.splice(0);
  await restored.fire("session_tree", {});
  assert.equal(restored.widget, undefined);
});

test("missing attached file clears the widget and notifies before an agent turn", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  const added = await harness.tool.execute("call-add", { action: "add", name: "Temporary" }, undefined, undefined, harness.ctx);
  await rm(join(root, ".pi", "tasks", `${added.details.taskListId}.json`));

  await harness.fire("before_agent_start", { systemPrompt: "base" });
  assert.equal(harness.widget, undefined);
  assert.match(harness.notifications.at(-1)?.message ?? "", /could not refresh task stack/i);
});

test("new session discovers without attaching and resumes only the selected list", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const document = await store.create("old-session");
  await store.mutate(document.id, { action: "add", name: "Previous work" });

  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "new" });
  const candidates = await harness.tool.execute("call-discover", { action: "resume" }, undefined, undefined, harness.ctx);
  assert.equal(harness.widget, undefined);
  assert.equal(harness.entries.length, 0);
  assert.equal(candidates.details.candidates[0].id, document.id);

  await harness.tool.execute(
    "call-resume",
    { action: "resume", taskListId: document.id },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(harness.entries.length, 1);
  assert.equal(typeof harness.widget, "function");
});
