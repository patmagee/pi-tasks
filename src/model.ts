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

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Subtask {
  id: string;
  name: string;
  status: TaskStatus;
  assignee?: string;
}

export interface Task extends Subtask {
  /** True only when the user explicitly authorizes parallel execution. */
  parallel?: boolean;
  subtasks: Subtask[];
}

export interface TaskListDocument {
  version: 1;
  /** Stable identifier for this document (UUID). */
  id: string;
  /** Pi session identifier that created the document. */
  originSessionId: string;
  createdAt: string;
  updatedAt: string;
  active: Task[];
  /** Tasks that have been completed and archived from active. */
  completed: Task[];
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
  /** Parent-only scheduling flag. True requires explicit user authorization. */
  parallel?: boolean;
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
  /**
   * Active subtasks accept all three statuses.
   * Active parents accept pending and in_progress; setting completed archives the task.
   */
  status?: "pending" | "in_progress" | "completed";
  /** Pass null to remove an existing assignee. */
  assignee?: string | null;
  /** Parent-only scheduling flag. False restores the sequential default. */
  parallel?: boolean;
}

export interface PopMutation {
  action: "pop";
}

export type TaskSection = "active" | "completed";

export interface DeleteMutation {
  action: "delete";
  /** Reference string: "N" or "N.M". */
  task: string;
  /** Resolve the reference against the completed list. Defaults to active. */
  section?: TaskSection;
}

export type MutationOperation = AddMutation | MoveMutation | UpdateMutation | PopMutation | DeleteMutation;
export type IdFactory = () => string;

export interface MutationResult {
  document: TaskListDocument;
  message: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskList(id: string, originSessionId: string, now: string): TaskListDocument {
  return { version: 1, id, originSessionId, createdAt: now, updatedAt: now, active: [], completed: [] };
}

export function getRunnableParentReferences(document: TaskListDocument): string[] {
  if (document.active.length === 0) return [];
  if (document.active[0]!.parallel !== true) return ["1"];

  const references: string[] = [];
  for (const [index, task] of document.active.entries()) {
    if (task.parallel !== true) break;
    references.push(String(index + 1));
  }
  return references;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneTask(t: Task): Task {
  const clone = { ...t, subtasks: t.subtasks.map((s) => ({ ...s })) };
  if (clone.parallel !== true) delete clone.parallel;
  return clone;
}

function cloneDocument(source: TaskListDocument): TaskListDocument {
  return {
    ...source,
    active: source.active.map(cloneTask),
    completed: source.completed.map(cloneTask),
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
  const match = /^([1-9]\d*)(?:\.([1-9]\d*))?$/.exec(value);
  if (match === null) throw new Error(`Invalid reference: ${value}`);
  const parent = Number(match[1]);
  const subtask = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(parent) || (subtask !== undefined && !Number.isSafeInteger(subtask))) {
    throw new Error(`Invalid reference: ${value}`);
  }
  return subtask === undefined
    ? { parentIndex: parent - 1 }
    : { parentIndex: parent - 1, subtaskIndex: subtask - 1 };
}

/**
 * Convert a one-based optional position into a zero-based insertion index.
 * Appends when position is undefined or exactly one after the current list.
 */
function insertionIndex(position: number | undefined, length: number): number {
  if (position === undefined) return length;
  if (!Number.isInteger(position) || position < 1 || position > length + 1) {
    throw new Error(`Invalid position: ${position}`);
  }
  return position - 1;
}

/**
 * Convert a one-based target position into a zero-based destination index for
 * a move within a list of the given length (after the item has been removed).
 */
function moveIndex(position: number, length: number): number {
  if (!Number.isInteger(position) || position < 1) throw new Error(`Invalid position: ${position}`);
  const idx = position - 1;
  return Math.min(idx, length);
}

/**
 * Throw when any subtask has not yet reached completed status.
 * Used by both the explicit completion update and the pop shortcut.
 */
function requireSubtasksCompleted(task: Task): void {
  const incomplete = task.subtasks.filter((s) => s.status !== "completed");
  if (incomplete.length > 0) {
    throw new Error("Must complete all subtasks before completing a parent task");
  }
}

/**
 * Apply an assignee update to a task or subtask.
 * undefined: no change. null: remove. string: set.
 */
function applyAssignee(target: Task | Subtask, assignee: string | null | undefined): void {
  if (assignee === undefined) return;
  if (assignee === null) {
    delete target.assignee;
  } else {
    target.assignee = assignee;
  }
}

// ---------------------------------------------------------------------------
// Plain-text formatter
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◑",
  completed: "✓",
};

/**
 * Render the task list as a plain-text string.
 * Pass includeCompleted=true to append a "Completed" section with section-local numbering.
 */
export function formatPlainList(document: TaskListDocument, includeCompleted = false): string {
  const lines: string[] = [];

  const renderTask = (task: Task, n: number): void => {
    const scheduling = task.parallel === true ? " ∥" : "";
    lines.push(`${n}. ${STATUS_GLYPH[task.status]}${scheduling} ${task.name}`);
    task.subtasks.forEach((sub, si) => {
      lines.push(`  ${n}.${si + 1} ${STATUS_GLYPH[sub.status]} ${sub.name}`);
    });
  };

  document.active.forEach((task, ti) => renderTask(task, ti + 1));

  if (includeCompleted && document.completed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Completed");
    document.completed.forEach((task, ti) => renderTask(task, ti + 1));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// applyMutation
// ---------------------------------------------------------------------------

export function applyMutation(
  source: TaskListDocument,
  mutation: MutationOperation,
  now: string,
  nextId: IdFactory,
): MutationResult {
  switch (mutation.action) {
    case "add":
      return applyAdd(source, mutation, now, nextId);
    case "move":
      return applyMove(source, mutation, now);
    case "update":
      return applyUpdate(source, mutation, now);
    case "pop":
      return applyPop(source, now);
    case "delete":
      return applyDelete(source, mutation, now);
    default:
      throw new Error(`Unsupported mutation: ${(mutation as { action: string }).action}`);
  }
}

function applyAdd(
  source: TaskListDocument,
  mutation: AddMutation,
  now: string,
  nextId: IdFactory,
): MutationResult {
  const name = requireName(mutation.name);

  if (mutation.parent !== undefined) {
    if (mutation.parallel !== undefined) {
      throw new Error("Parallel scheduling is supported only for parent tasks");
    }
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
  if (mutation.parallel === true) task.parallel = true;
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
  // Parse once and validate before cloning (avoids a duplicate parse).
  const { parentIndex, subtaskIndex } = parseReference(mutation.task);
  const parent = source.active[parentIndex];
  if (parent === undefined) throw new Error(`Task not found: ${mutation.task}`);
  if (subtaskIndex !== undefined && parent.subtasks[subtaskIndex] === undefined) {
    throw new Error(`Task not found: ${mutation.task}`);
  }

  const doc = cloneDocument(source);
  doc.updatedAt = now;
  const targetParent = doc.active[parentIndex]!;

  if (subtaskIndex !== undefined) {
    if (mutation.parallel !== undefined) {
      throw new Error("Parallel scheduling is supported only for parent tasks");
    }
    const sub = targetParent.subtasks[subtaskIndex]!;
    if (mutation.name !== undefined) sub.name = requireName(mutation.name);
    if (mutation.status !== undefined) sub.status = mutation.status;
    applyAssignee(sub, mutation.assignee);
    return { document: doc, message: `Updated subtask "${sub.name}"` };
  }

  if (mutation.parallel === true) targetParent.parallel = true;
  if (mutation.parallel === false) delete targetParent.parallel;

  // Completing a parent validates subtasks and archives it.
  if (mutation.status === "completed") {
    requireSubtasksCompleted(targetParent);
    if (mutation.name !== undefined) targetParent.name = requireName(mutation.name);
    applyAssignee(targetParent, mutation.assignee);
    targetParent.status = "completed";
    doc.active.splice(parentIndex, 1);
    doc.completed.push(targetParent);
    return { document: doc, message: `Completed task "${targetParent.name}"` };
  }

  if (mutation.name !== undefined) targetParent.name = requireName(mutation.name);
  if (mutation.status !== undefined) targetParent.status = mutation.status;
  applyAssignee(targetParent, mutation.assignee);
  return { document: doc, message: `Updated task "${targetParent.name}"` };
}

function applyPop(source: TaskListDocument, now: string): MutationResult {
  const task = source.active[0];
  if (task === undefined) throw new Error("No active tasks to pop");

  requireSubtasksCompleted(task);

  const doc = cloneDocument(source);
  doc.updatedAt = now;
  const popped = doc.active.shift();
  if (popped === undefined) throw new Error("Internal error: shift returned undefined");
  popped.status = "completed";
  doc.completed.push(popped);
  return { document: doc, message: `Completed task "${popped.name}"` };
}

function applyDelete(source: TaskListDocument, mutation: DeleteMutation, now: string): MutationResult {
  const { parentIndex, subtaskIndex } = parseReference(mutation.task);
  const list = mutation.section === "completed" ? source.completed : source.active;

  const parent = list[parentIndex];
  if (parent === undefined) throw new Error(`Task not found: ${mutation.task}`);

  if (subtaskIndex !== undefined) {
    const subtask = parent.subtasks[subtaskIndex];
    if (subtask === undefined) throw new Error(`Task not found: ${mutation.task}`);
    const doc = cloneDocument(source);
    doc.updatedAt = now;
    const targetList = mutation.section === "completed" ? doc.completed : doc.active;
    targetList[parentIndex]!.subtasks.splice(subtaskIndex, 1);
    return { document: doc, message: `Deleted subtask "${subtask.name}"` };
  }

  const doc = cloneDocument(source);
  doc.updatedAt = now;
  const targetList = mutation.section === "completed" ? doc.completed : doc.active;
  targetList.splice(parentIndex, 1);
  return { document: doc, message: `Deleted task "${parent.name}"` };
}
