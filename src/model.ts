/**
 * Ordered task model for the Pi task-stack extension.
 *
 * All mutations are immutable: applyMutation clones before modifying.
 * Positions are one-based throughout the public interface.
 * References are strings of the form "N" (parent) or "N.M" (subtask).
 * Nesting is limited to one level; subtasks cannot themselves have subtasks.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface Subtask {
  id: string;
  name: string;
  status: TaskStatus;
  assignee?: string;
}

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
  assignee?: string;
  subtasks: Subtask[];
}

export interface TaskListDocument {
  /** Stable identifier for this document (UUID). */
  id: string;
  /** Pi session identifier that created the document. */
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  active: Task[];
}

// ---------------------------------------------------------------------------
// Mutation shapes
// ---------------------------------------------------------------------------

export interface AddMutation {
  action: "add";
  name: string;
  /** One-based insertion position. Appends when absent. */
  position?: number;
  /** Reference string "N" for the parent task. Absent means top-level. */
  parent?: string;
}

export interface MoveMutation {
  action: "move";
  /** Reference string: "N" or "N.M". */
  task: string;
  /** Target one-based position within the same list. */
  position: number;
}

export interface UpdateMutation {
  action: "update";
  /** Reference string: "N" or "N.M". */
  task: string;
  name?: string;
  /** Only non-completion statuses may be set here. */
  status?: "pending" | "in_progress";
  assignee?: string;
}

export type Mutation = AddMutation | MoveMutation | UpdateMutation;

export interface MutationResult {
  document: TaskListDocument;
  message: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskList(id: string, sessionId: string, now: string): TaskListDocument {
  return { id, sessionId, createdAt: now, updatedAt: now, active: [] };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneDocument(source: TaskListDocument): TaskListDocument {
  return {
    ...source,
    active: source.active.map((t) => ({ ...t, subtasks: t.subtasks.map((s) => ({ ...s })) })),
  };
}

function requireName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("name must not be blank");
  }
  return trimmed;
}

/**
 * Parse a reference string into zero-based indices.
 * "N" → { parentIndex: N-1 }
 * "N.M" → { parentIndex: N-1, subtaskIndex: M-1 }
 */
function parseReference(value: string): { parentIndex: number; subtaskIndex?: number } {
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1) throw new Error(`Invalid reference: ${value}`);
    return { parentIndex: n - 1 };
  }
  const n = parseInt(value.slice(0, dotIndex), 10);
  const m = parseInt(value.slice(dotIndex + 1), 10);
  if (isNaN(n) || n < 1 || isNaN(m) || m < 1) throw new Error(`Invalid reference: ${value}`);
  return { parentIndex: n - 1, subtaskIndex: m - 1 };
}

function resolveActive(
  document: TaskListDocument,
  reference: string,
): { task: Task | Subtask; parent: Task; parentIndex: number; subtaskIndex?: number } {
  const { parentIndex, subtaskIndex } = parseReference(reference);
  const parent = document.active[parentIndex];
  if (parent === undefined) {
    throw new Error(`Task not found: ${reference}`);
  }
  if (subtaskIndex !== undefined) {
    const subtask = parent.subtasks[subtaskIndex];
    if (subtask === undefined) {
      throw new Error(`Task not found: ${reference}`);
    }
    return { task: subtask, parent, parentIndex, subtaskIndex };
  }
  return { task: parent, parent, parentIndex };
}

/**
 * Convert a one-based optional position into a zero-based insertion index.
 * Appends when position is undefined or exceeds the list length.
 */
function insertionIndex(position: number | undefined, length: number): number {
  if (position === undefined) return length;
  const idx = position - 1;
  return Math.max(0, Math.min(idx, length));
}

/**
 * Convert a one-based target position into a zero-based destination index for
 * a move within a list of the given length (after the item has been removed).
 */
function moveIndex(position: number, length: number): number {
  const idx = position - 1;
  return Math.max(0, Math.min(idx, length));
}

// ---------------------------------------------------------------------------
// Plain-text formatter
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◑",
  done: "●",
  cancelled: "✕",
};

export function formatPlainList(document: TaskListDocument): string {
  const lines: string[] = [];
  document.active.forEach((task, ti) => {
    const n = ti + 1;
    lines.push(`${n}. ${STATUS_GLYPH[task.status]} ${task.name}`);
    task.subtasks.forEach((sub, si) => {
      const m = si + 1;
      lines.push(`  ${n}.${m} ${STATUS_GLYPH[sub.status]} ${sub.name}`);
    });
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// applyMutation
// ---------------------------------------------------------------------------

export function applyMutation(
  source: TaskListDocument,
  mutation: Mutation,
  now: string,
  nextId: () => string,
): MutationResult {
  switch (mutation.action) {
    case "add":
      return applyAdd(source, mutation, now, nextId);
    case "move":
      return applyMove(source, mutation, now);
    case "update":
      return applyUpdate(source, mutation, now);
    default:
      throw new Error(`Unsupported mutation: ${(mutation as { action: string }).action}`);
  }
}

function applyAdd(
  source: TaskListDocument,
  mutation: AddMutation,
  now: string,
  nextId: () => string,
): MutationResult {
  const name = requireName(mutation.name);

  if (mutation.parent !== undefined) {
    // Subtask path — resolve parent and validate it is a top-level task.
    const ref = parseReference(mutation.parent);
    if (ref.subtaskIndex !== undefined) {
      throw new Error("Cannot nest subtasks more than one level deep");
    }
    const parent = source.active[ref.parentIndex];
    if (parent === undefined) {
      throw new Error(`Task not found: ${mutation.parent}`);
    }

    const doc = cloneDocument(source);
    doc.updatedAt = now;
    const targetParent = doc.active[ref.parentIndex]!;
    const idx = insertionIndex(mutation.position, targetParent.subtasks.length);
    const subtask: Subtask = { id: nextId(), name, status: "pending" };
    targetParent.subtasks.splice(idx, 0, subtask);
    return { document: doc, message: `Added subtask "${name}" under "${targetParent.name}"` };
  }

  // Top-level task path.
  const doc = cloneDocument(source);
  doc.updatedAt = now;
  const idx = insertionIndex(mutation.position, doc.active.length);
  const task: Task = { id: nextId(), name, status: "pending", subtasks: [] };
  doc.active.splice(idx, 0, task);
  return { document: doc, message: `Added task "${name}"` };
}

function applyMove(source: TaskListDocument, mutation: MoveMutation, now: string): MutationResult {
  const { parentIndex, subtaskIndex } = parseReference(mutation.task);

  if (subtaskIndex !== undefined) {
    const parent = source.active[parentIndex];
    if (parent === undefined || parent.subtasks[subtaskIndex] === undefined) {
      throw new Error(`Task not found: ${mutation.task}`);
    }
    const doc = cloneDocument(source);
    doc.updatedAt = now;
    const targetParent = doc.active[parentIndex]!;
    const removed = targetParent.subtasks.splice(subtaskIndex, 1);
    const item = removed[0];
    if (item === undefined) throw new Error(`Internal error: subtask splice returned empty array`);
    const dest = moveIndex(mutation.position, targetParent.subtasks.length);
    targetParent.subtasks.splice(dest, 0, item);
    return { document: doc, message: `Moved subtask to position ${mutation.position}` };
  }

  const task = source.active[parentIndex];
  if (task === undefined) {
    throw new Error(`Task not found: ${mutation.task}`);
  }
  const doc = cloneDocument(source);
  doc.updatedAt = now;
  const removed = doc.active.splice(parentIndex, 1);
  const item = removed[0];
  if (item === undefined) throw new Error(`Internal error: task splice returned empty array`);
  const dest = moveIndex(mutation.position, doc.active.length);
  doc.active.splice(dest, 0, item);
  return { document: doc, message: `Moved task "${item.name}" to position ${mutation.position}` };
}

function applyUpdate(source: TaskListDocument, mutation: UpdateMutation, now: string): MutationResult {
  resolveActive(source, mutation.task); // validate reference before cloning

  const doc = cloneDocument(source);
  doc.updatedAt = now;

  const { parentIndex, subtaskIndex } = parseReference(mutation.task);
  const parent = doc.active[parentIndex]!;

  if (subtaskIndex !== undefined) {
    const sub = parent.subtasks[subtaskIndex]!;
    if (mutation.name !== undefined) sub.name = requireName(mutation.name);
    if (mutation.status !== undefined) sub.status = mutation.status;
    if (mutation.assignee !== undefined) sub.assignee = mutation.assignee;
    return { document: doc, message: `Updated subtask "${sub.name}"` };
  }

  if (mutation.name !== undefined) parent.name = requireName(mutation.name);
  if (mutation.status !== undefined) parent.status = mutation.status;
  if (mutation.assignee !== undefined) parent.assignee = mutation.assignee;
  return { document: doc, message: `Updated task "${parent.name}"` };
}
