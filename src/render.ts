import { truncateToWidth } from "@earendil-works/pi-tui";
import { getRunnableParentReferences, type Subtask, type Task, type TaskListDocument } from "./model.ts";

export interface RenderTheme {
  text(value: string): string;
  accent(value: string): string;
  muted(value: string): string;
  success(value: string): string;
  dim(value: string): string;
  strikethrough(value: string): string;
}

function renderItem(
  item: Task | Subtask,
  reference: string,
  indent: string,
  width: number,
  theme: RenderTheme,
  parallel = false,
): string {
  let glyph: string;
  let label: string;
  const scheduling = parallel ? "∥ " : "";

  switch (item.status) {
    case "in_progress":
      glyph = theme.accent("▶");
      label = theme.accent(`${scheduling}${reference} ${item.name}`);
      break;
    case "completed":
      glyph = theme.success("✓");
      label = theme.muted(theme.strikethrough(`${scheduling}${reference} ${item.name}`));
      break;
    case "pending":
      glyph = theme.text("○");
      label = theme.text(`${scheduling}${reference} ${item.name}`);
      break;
  }

  const assignee = item.assignee === undefined ? "" : `  ${theme.muted(`@${item.assignee}`)}`;
  return truncateToWidth(`${indent}${glyph} ${label}${assignee}`, Math.max(0, width));
}

function renderTaskTree(task: Task, index: number, width: number, theme: RenderTheme): string[] {
  const reference = String(index + 1);
  return [
    renderItem(task, reference, "", width, theme, task.parallel === true),
    ...task.subtasks.map((subtask, subtaskIndex) =>
      renderItem(subtask, `${reference}.${subtaskIndex + 1}`, "  ", width, theme),
    ),
  ];
}

const MAX_WIDGET_LINES = 10;

export function renderWidgetLines(document: TaskListDocument, width: number, theme: RenderTheme): string[] {
  if (document.active.length === 0) return [];
  const lines = [
    truncateToWidth(theme.accent("Tasks"), Math.max(0, width)),
    ...document.active.flatMap((task, index) => renderTaskTree(task, index, width, theme)),
  ];
  if (lines.length <= MAX_WIDGET_LINES) return lines;
  const visible = lines.slice(0, MAX_WIDGET_LINES - 1);
  const omitted = lines.length - visible.length;
  visible.push(truncateToWidth(theme.dim(`… ${omitted} more. Use /task-stack to view all tasks.`), Math.max(0, width)));
  return visible;
}

export function renderFullListLines(document: TaskListDocument, width: number, theme: RenderTheme): string[] {
  const lines: string[] = [];
  if (document.active.length > 0) {
    lines.push(truncateToWidth(theme.accent("Active"), Math.max(0, width)));
    lines.push(...document.active.flatMap((task, index) => renderTaskTree(task, index, width, theme)));
  }
  if (document.completed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(truncateToWidth(theme.muted("Completed"), Math.max(0, width)));
    lines.push(...document.completed.flatMap((task, index) => renderTaskTree(task, index, width, theme)));
  }
  return lines;
}

const UNSAFE_AGENT_DATA_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\[\]]/gu;

function escapeUnicodeCodePoint(value: string): string {
  const codePoint = value.codePointAt(0)!;
  if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;

  const offset = codePoint - 0x10000;
  const high = 0xd800 + (offset >> 10);
  const low = 0xdc00 + (offset & 0x3ff);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

function serializeAgentData(value: string): string {
  return JSON.stringify(value).replace(UNSAFE_AGENT_DATA_CHARACTER, escapeUnicodeCodePoint);
}

export function renderAgentSummary(document: TaskListDocument): string {
  const lines: string[] = [];
  const runnable = new Set(getRunnableParentReferences(document));
  const parallelWave = document.active[0]?.parallel === true;

  for (const [taskIndex, task] of document.active.entries()) {
    const reference = String(taskIndex + 1);
    const scheduling = runnable.has(reference)
      ? parallelWave ? "runnable parallel wave" : "runnable"
      : "blocked by order";
    const marker = task.parallel === true ? " ∥" : "";
    const assignee = task.assignee === undefined ? "" : ` assignee=${serializeAgentData(task.assignee)}`;
    lines.push(`${reference}${marker} [${scheduling}] [${task.status}] name=${serializeAgentData(task.name)}${assignee}`);
    for (const [subtaskIndex, subtask] of task.subtasks.entries()) {
      const subtaskAssignee = subtask.assignee === undefined
        ? ""
        : ` assignee=${serializeAgentData(subtask.assignee)}`;
      lines.push(
        `  ${reference}.${subtaskIndex + 1} [ordered subtask] [${subtask.status}] name=${serializeAgentData(subtask.name)}${subtaskAssignee}`,
      );
    }
  }
  return lines.join("\n");
}
