import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Subtask, Task, TaskListDocument } from "./model.ts";

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
): string {
  let glyph: string;
  let label: string;

  switch (item.status) {
    case "in_progress":
      glyph = theme.accent("▶");
      label = theme.accent(`${reference} ${item.name}`);
      break;
    case "completed":
      glyph = theme.success("✓");
      label = theme.muted(theme.strikethrough(`${reference} ${item.name}`));
      break;
    case "pending":
      glyph = theme.text("○");
      label = theme.text(`${reference} ${item.name}`);
      break;
  }

  const assignee = item.assignee === undefined ? "" : `  ${theme.muted(`@${item.assignee}`)}`;
  return truncateToWidth(`${indent}${glyph} ${label}${assignee}`, Math.max(0, width));
}

function renderTaskTree(task: Task, index: number, width: number, theme: RenderTheme): string[] {
  const reference = String(index + 1);
  return [
    renderItem(task, reference, "", width, theme),
    ...task.subtasks.map((subtask, subtaskIndex) =>
      renderItem(subtask, `${reference}.${subtaskIndex + 1}`, "  ", width, theme),
    ),
  ];
}

export function renderWidgetLines(document: TaskListDocument, width: number, theme: RenderTheme): string[] {
  if (document.active.length === 0) return [];
  return [
    truncateToWidth(theme.accent("Tasks"), Math.max(0, width)),
    ...document.active.flatMap((task, index) => renderTaskTree(task, index, width, theme)),
  ];
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

export function renderAgentSummary(document: TaskListDocument): string {
  const lines: string[] = [];
  for (const [taskIndex, task] of document.active.entries()) {
    const reference = String(taskIndex + 1);
    const assignee = task.assignee === undefined ? "" : ` @${task.assignee}`;
    lines.push(`${reference} [${task.status}] ${task.name}${assignee}`);
    for (const [subtaskIndex, subtask] of task.subtasks.entries()) {
      const subtaskAssignee = subtask.assignee === undefined ? "" : ` @${subtask.assignee}`;
      lines.push(`  ${reference}.${subtaskIndex + 1} [${subtask.status}] ${subtask.name}${subtaskAssignee}`);
    }
  }
  return lines.join("\n");
}
