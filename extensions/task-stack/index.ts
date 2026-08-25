import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatPlainList,
  type MutationOperation,
  type TaskListDocument,
  type TaskStatus,
} from "../../src/model.ts";
import {
  renderAgentSummary,
  renderFullListLines,
  renderWidgetLines,
  type RenderTheme,
} from "../../src/render.ts";
import {
  resolveRepositoryRoot,
  TaskListNotFoundError,
  TaskStore,
  type TaskListCandidate,
} from "../../src/store.ts";

const ATTACHMENT_TYPE = "pi-task-stack-attachment";
const WIDGET_ID = "task-stack";

interface AttachmentData {
  version: 1;
  taskListId: string | null;
}

interface ToolParams {
  action: "add" | "update" | "move" | "pop" | "delete" | "list" | "resume";
  name?: string;
  position?: number;
  parent?: string;
  task?: string;
  status?: TaskStatus;
  assignee?: string;
  section?: "active" | "completed";
  includeCompleted?: boolean;
  taskListId?: string;
}

const TaskStackParams = Type.Object({
  action: StringEnum(["add", "update", "move", "pop", "delete", "list", "resume"] as const),
  name: Type.Optional(Type.String({ description: "Required task name for add; optional replacement name for update" })),
  position: Type.Optional(Type.Integer({ minimum: 1, description: "One-based insertion or destination position" })),
  parent: Type.Optional(Type.String({ description: "Active parent reference such as 5 when adding a subtask" })),
  task: Type.Optional(Type.String({ description: "Visible task reference such as 5 or 5.1" })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
  assignee: Type.Optional(Type.String({ description: "Free-form assignee label; an empty string clears it" })),
  section: Type.Optional(StringEnum(["active", "completed"] as const)),
  includeCompleted: Type.Optional(Type.Boolean()),
  taskListId: Type.Optional(Type.String({ description: "Task-list UUID returned by resume discovery" })),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function findLatestAttachment(entries: readonly unknown[]): string | undefined {
  let attachment: string | undefined;
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record?.type !== "custom" || record.customType !== ATTACHMENT_TYPE) continue;
    const data = asRecord(record.data);
    if (data?.version !== 1) continue;
    if (data.taskListId === null) {
      attachment = undefined;
    } else if (typeof data.taskListId === "string") {
      attachment = data.taskListId;
    }
  }
  return attachment;
}

export function shouldShowWidget(
  attachmentId: string | undefined,
  document: TaskListDocument | undefined,
): boolean {
  return attachmentId !== undefined && document !== undefined && document.active.length > 0;
}

export function buildTurnSystemPrompt(
  base: string,
  attachmentId: string | undefined,
  document: TaskListDocument | undefined,
): string {
  if (attachmentId === undefined || document === undefined || document.active.length === 0) return base;
  const summary = renderAgentSummary(document);
  return summary.length === 0 ? base : `${base}\n\n[Task stack attached]\n${summary}`;
}

function toRenderTheme(theme: Theme): RenderTheme {
  return {
    text: (value) => theme.fg("text", value),
    accent: (value) => theme.fg("accent", value),
    muted: (value) => theme.fg("muted", value),
    success: (value) => theme.fg("success", value),
    dim: (value) => theme.fg("dim", value),
    strikethrough: (value) => theme.strikethrough(value),
  };
}

function requireString(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function mutationFromParams(params: ToolParams): MutationOperation {
  switch (params.action) {
    case "add": {
      const operation: MutationOperation = { action: "add", name: requireString(params.name, "name") };
      if (params.position !== undefined) operation.position = params.position;
      if (params.parent !== undefined) operation.parent = params.parent;
      return operation;
    }
    case "update": {
      const operation: Extract<MutationOperation, { action: "update" }> = {
        action: "update",
        task: requireString(params.task, "task"),
      };
      if (params.name !== undefined) operation.name = params.name;
      if (params.status !== undefined) operation.status = params.status;
      if (params.assignee !== undefined) {
        const assignee = params.assignee.trim();
        operation.assignee = assignee.length === 0 ? null : assignee;
      }
      if (operation.name === undefined && operation.status === undefined && operation.assignee === undefined) {
        throw new Error("update requires name, status, or assignee");
      }
      return operation;
    }
    case "move":
      if (params.position === undefined) throw new Error("position is required");
      return { action: "move", task: requireString(params.task, "task"), position: params.position };
    case "pop":
      return { action: "pop" };
    case "delete": {
      const operation: Extract<MutationOperation, { action: "delete" }> = {
        action: "delete",
        task: requireString(params.task, "task"),
      };
      if (params.section === "completed") operation.section = "completed";
      return operation;
    }
    default:
      throw new Error(`${params.action} is not a mutation action`);
  }
}

function formatCandidates(candidates: TaskListCandidate[]): string {
  if (candidates.length === 0) return "No previous task lists found in this repository.";
  return candidates.map((candidate) => {
    const preview = candidate.firstTaskName === undefined ? "no named tasks" : candidate.firstTaskName;
    return `${candidate.id}  updated ${candidate.updatedAt}  active ${candidate.activeCount}  completed ${candidate.completedCount}  ${preview}`;
  }).join("\n");
}

export default function taskStackExtension(pi: ExtensionAPI): void {
  let attachmentId: string | undefined;
  let document: TaskListDocument | undefined;
  let store: TaskStore | undefined;

  function refreshWidget(ctx: ExtensionContext): void {
    if (attachmentId === undefined || document === undefined || document.active.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    const snapshot = document;
    ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
      render: (width: number) => renderWidgetLines(snapshot, width, toRenderTheme(theme)),
      invalidate: () => {},
    }));
  }

  function appendAttachment(taskListId: string | null): void {
    const data: AttachmentData = { version: 1, taskListId };
    pi.appendEntry(ATTACHMENT_TYPE, data);
  }

  async function createStore(ctx: ExtensionContext): Promise<TaskStore> {
    const repositoryRoot = await resolveRepositoryRoot(ctx.cwd, async (cwd) => {
      const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
      return result.code === 0 ? result.stdout.trim() : undefined;
    });
    return new TaskStore(repositoryRoot);
  }

  async function restoreAttachment(ctx: ExtensionContext): Promise<void> {
    store ??= await createStore(ctx);
    attachmentId = findLatestAttachment(ctx.sessionManager.getBranch());
    document = undefined;
    if (attachmentId !== undefined) {
      try {
        document = await store.read(attachmentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TaskListNotFoundError) {
          appendAttachment(null);
          attachmentId = undefined;
        }
        ctx.ui.notify(`Could not restore task stack: ${message}`, "error");
      }
    }
    refreshWidget(ctx);
  }

  async function refreshFromStore(ctx: ExtensionContext): Promise<boolean> {
    if (store === undefined || attachmentId === undefined) return false;
    try {
      document = await store.read(attachmentId);
      refreshWidget(ctx);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TaskListNotFoundError) {
        appendAttachment(null);
        attachmentId = undefined;
        document = undefined;
        refreshWidget(ctx);
      }
      ctx.ui.notify(`Could not refresh task stack: ${message}`, "error");
      return false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreAttachment(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreAttachment(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    attachmentId = undefined;
    document = undefined;
    store = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!await refreshFromStore(ctx)) return undefined;
    const systemPrompt = buildTurnSystemPrompt(event.systemPrompt, attachmentId, document);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  pi.registerTool({
    name: "task_stack",
    label: "Task Stack",
    description: "Create, order, track, complete, delete, list, and explicitly resume repository task lists",
    promptSnippet: "Create, order, track, complete, and resume repository task lists",
    promptGuidelines: [
      "Use task_stack for the attached execution task list instead of an ad hoc checklist.",
      "Do not issue dependent task_stack mutations in one parallel tool batch because visible task numbers can change.",
      "Call task_stack with action resume only when the user asks to resume previous tasks.",
    ],
    parameters: TaskStackParams,
    executionMode: "sequential",

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as ToolParams;
      store ??= await createStore(ctx);

      if (params.action === "resume") {
        if (params.taskListId === undefined) {
          const discovery = await store.discoverAvailable();
          if (discovery.errors.length > 0) {
            ctx.ui.notify(
              `Skipped ${discovery.errors.length} unreadable task-list file(s) during resume discovery.`,
              "warning",
            );
          }
          return {
            content: [{ type: "text", text: formatCandidates(discovery.candidates) }],
            details: { action: "resume", candidates: discovery.candidates, errors: discovery.errors },
          };
        }
        const resumed = await store.read(params.taskListId);
        if (attachmentId !== params.taskListId) {
          if (attachmentId !== undefined) appendAttachment(null);
          appendAttachment(params.taskListId);
        }
        attachmentId = params.taskListId;
        document = resumed;
        refreshWidget(ctx);
        return {
          content: [{ type: "text", text: formatPlainList(resumed, true) || "Task list is empty." }],
          details: { action: "resume", taskListId: attachmentId, document },
        };
      }

      if (params.action === "list") {
        if (attachmentId === undefined) {
          throw new Error("No task list is attached. Add a task to start a new list or ask to resume previous tasks.");
        }
        if (!await refreshFromStore(ctx)) {
          throw new Error("The attached task list is no longer available.");
        }
        return {
          content: [{ type: "text", text: formatPlainList(document!, params.includeCompleted) || "No tasks." }],
          details: { action: "list", taskListId: attachmentId, document },
        };
      }

      const operation = mutationFromParams(params);
      if (attachmentId === undefined) {
        if (operation.action !== "add") {
          throw new Error("No task list is attached. Add a task to start a new list or ask to resume previous tasks.");
        }
        const created = await store.create(ctx.sessionManager.getSessionId());
        const result = await store.mutate(created.id, operation);
        appendAttachment(created.id);
        attachmentId = created.id;
        document = result.document;
        refreshWidget(ctx);
        return {
          content: [{ type: "text", text: `${result.message}\n${formatPlainList(document)}` }],
          details: { action: params.action, taskListId: attachmentId, document },
        };
      }

      const result = await store.mutate(attachmentId, operation);
      document = result.document;
      refreshWidget(ctx);
      return {
        content: [{ type: "text", text: `${result.message}\n${formatPlainList(document) || "No active tasks."}` }],
        details: { action: params.action, taskListId: attachmentId, document },
      };
    },

    renderCall(args, theme) {
      const params = args as ToolParams;
      const reference = params.task ?? params.parent ?? params.taskListId ?? "";
      const suffix = reference.length === 0 ? "" : ` ${theme.fg("muted", reference)}`;
      return new Text(`${theme.fg("toolTitle", theme.bold("task_stack"))} ${theme.fg("muted", params.action)}${suffix}`, 0, 0);
    },

    renderResult(result, _options, theme, context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      return new Text(context.isError ? theme.fg("error", text) : theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerCommand("task-stack", {
    description: "Show the attached active and completed task list",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/task-stack requires interactive mode", "error");
        return;
      }
      if (attachmentId === undefined || store === undefined) {
        ctx.ui.notify("No task list is attached. Ask the agent to resume previous tasks.", "info");
        return;
      }
      if (!await refreshFromStore(ctx) || document === undefined) return;
      const snapshot = document;
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => ({
        render: (width: number) => {
          const lines = renderFullListLines(snapshot, width, toRenderTheme(theme));
          return lines.length === 0 ? [theme.fg("dim", "No tasks.")] : lines;
        },
        invalidate: () => {},
        handleInput: (data: string) => {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
        },
      }));
    },
  });
}
