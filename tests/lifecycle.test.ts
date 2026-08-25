import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  let customLines: string[] | undefined;
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
      custom: async (factory: (...args: any[]) => any) => {
        const theme = {
          fg: (_color: string, value: string) => value,
          strikethrough: (value: string) => value,
        };
        const component = factory({ requestRender: () => {} }, theme, {}, () => {});
        customLines = component.render(120);
      },
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
    get customLines() { return customLines; },
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

test("invalid first add leaves no persisted task list", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });

  await assert.rejects(
    harness.tool.execute("bad-add", { action: "add", name: "Invalid", position: 2 }, undefined, undefined, harness.ctx),
    /position/i,
  );
  assert.equal(harness.entries.length, 0);
  assert.deepEqual(await new TaskStore(root).discover(), []);
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

test("missing file during session restore records a detach marker once", async (t) => {
  const root = await temporaryRoot(t);
  const missingId = "00000000-0000-4000-8000-000000000099";
  const harness = createHarness(root, [attachmentEntry(missingId)]);
  await harness.fire("session_start", { reason: "resume" });
  assert.equal(findLatestAttachment(harness.entries), undefined);
  assert.equal((harness.entries.at(-1)?.data as { taskListId: string | null }).taskListId, null);
  assert.match(harness.notifications.at(-1)?.message ?? "", /could not restore task stack/i);

  const notificationCount = harness.notifications.length;
  await harness.fire("session_start", { reason: "reload" });
  assert.equal(harness.notifications.length, notificationCount);
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

test("transient refresh errors keep the attachment and last valid widget", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  const added = await harness.tool.execute("call-add", { action: "add", name: "Keep visible" }, undefined, undefined, harness.ctx);
  await writeFile(
    join(root, ".pi", "tasks", `${added.details.taskListId}.json`),
    JSON.stringify({ version: 2, id: added.details.taskListId }),
    "utf8",
  );

  await harness.fire("before_agent_start", { systemPrompt: "base" });
  assert.equal(findLatestAttachment(harness.entries), added.details.taskListId);
  assert.equal(harness.entries.length, 1);
  assert.equal(typeof harness.widget, "function");
  assert.match(harness.notifications.at(-1)?.message ?? "", /could not refresh task stack/i);
});

test("tree restore errors keep the last valid widget for the same attachment", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  const added = await harness.tool.execute("add", { action: "add", name: "Keep on tree" }, undefined, undefined, harness.ctx);
  await writeFile(
    join(root, ".pi", "tasks", `${added.details.taskListId}.json`),
    JSON.stringify({ version: 2, id: added.details.taskListId }),
    "utf8",
  );

  await harness.fire("session_tree", {});
  assert.equal(findLatestAttachment(harness.entries), added.details.taskListId);
  assert.equal(typeof harness.widget, "function");
});

test("invalid file during session restore does not write a detach marker", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const document = await store.create("old-session");
  await writeFile(
    join(store.fileRoot, `${document.id}.json`),
    JSON.stringify({ version: 2, id: document.id }),
    "utf8",
  );
  const harness = createHarness(root, [attachmentEntry(document.id)]);

  await harness.fire("session_start", { reason: "resume" });
  assert.equal(findLatestAttachment(harness.entries), document.id);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.widget, undefined);
  assert.match(harness.notifications.at(-1)?.message ?? "", /could not restore task stack/i);
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

test("resume discovery skips corrupt files and reports diagnostics", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const valid = await store.create("old-session");
  await writeFile(join(store.fileRoot, "notes.json"), "not a task list", "utf8");
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "new" });

  const result = await harness.tool.execute("call-discover", { action: "resume" }, undefined, undefined, harness.ctx);
  assert.deepEqual(result.details.candidates.map((candidate: { id: string }) => candidate.id), [valid.id]);
  assert.equal(result.details.errors.length, 1);
  assert.match(harness.notifications.at(-1)?.message ?? "", /skipped 1 unreadable/i);
});

test("tool mutations use fresh visible positions and trim assignees", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  assert.equal(harness.tool.executionMode, "sequential");
  await harness.fire("session_start", { reason: "startup" });
  await harness.tool.execute("add-a", { action: "add", name: "A" }, undefined, undefined, harness.ctx);
  await harness.tool.execute("add-b", { action: "add", name: "B" }, undefined, undefined, harness.ctx);
  await harness.tool.execute("assign", { action: "update", task: "1", assignee: "  worker  " }, undefined, undefined, harness.ctx);
  await harness.tool.execute("move", { action: "move", task: "2", position: 1 }, undefined, undefined, harness.ctx);
  await harness.tool.execute("pop", { action: "pop" }, undefined, undefined, harness.ctx);
  const listed = await harness.tool.execute("list", { action: "list", includeCompleted: true }, undefined, undefined, harness.ctx);
  assert.match(listed.content[0].text, /1\. ○ A/);
  assert.match(listed.content[0].text, /Completed/);
  assert.equal(listed.details.document.active[0].assignee, "worker");

  await harness.tool.execute("clear", { action: "update", task: "1", assignee: "   " }, undefined, undefined, harness.ctx);
  const deleted = await harness.tool.execute(
    "delete",
    { action: "delete", task: "1", section: "completed" },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal("assignee" in deleted.details.document.active[0], false);
  assert.equal(deleted.details.document.completed.length, 0);
});

test("resuming the current list does not append a duplicate marker", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  const added = await harness.tool.execute("add", { action: "add", name: "Current list" }, undefined, undefined, harness.ctx);

  await harness.tool.execute(
    "resume",
    { action: "resume", taskListId: added.details.taskListId },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(harness.entries.length, 1);
  assert.equal(findLatestAttachment(harness.entries), added.details.taskListId);
});

test("switching attached lists records detach then attach", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  await harness.tool.execute("add", { action: "add", name: "First list" }, undefined, undefined, harness.ctx);
  const otherStore = new TaskStore(root);
  const other = await otherStore.create("other-session");
  await otherStore.mutate(other.id, { action: "add", name: "Second list" });

  await harness.tool.execute("resume", { action: "resume", taskListId: other.id }, undefined, undefined, harness.ctx);
  assert.equal(harness.entries.length, 3);
  assert.equal(findLatestAttachment(harness.entries), other.id);
  assert.equal((harness.entries[1]?.data as { taskListId: string | null }).taskListId, null);
});

test("task-stack command is TUI-only and renders the attached full list", async (t) => {
  const root = await temporaryRoot(t);
  const harness = createHarness(root);
  await harness.fire("session_start", { reason: "startup" });
  await harness.command.handler("", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /no task list is attached/i);

  await harness.tool.execute("add", { action: "add", name: "Visible" }, undefined, undefined, harness.ctx);
  await harness.command.handler("", harness.ctx);
  assert.deepEqual(harness.customLines, ["Active", "○ 1 Visible"]);

  harness.ctx.mode = "print";
  await harness.command.handler("", harness.ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /requires interactive mode/i);
});
