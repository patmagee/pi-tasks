import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  applyMutation,
  createTaskList,
  type IdFactory,
  type MutationOperation,
  type MutationResult,
  type Subtask,
  type Task,
  type TaskListDocument,
  type TaskStatus,
} from "./model.ts";

const TASK_LIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed"]);

export interface TaskListCandidate {
  id: string;
  updatedAt: string;
  activeCount: number;
  completedCount: number;
  firstTaskName?: string;
}

export interface StoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

interface RequiredStoreOptions {
  lockTimeoutMs: number;
  staleLockMs: number;
  retryDelayMs: number;
  now: () => Date;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function assertTaskListId(id: string): void {
  if (!TASK_LIST_ID.test(id)) {
    throw new Error(`Invalid task-list identifier: ${id}`);
  }
}

function requireRecord(value: unknown, field: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}: ${field} must be a non-empty string`);
  }
  return value;
}

function parseStatus(value: unknown, field: string, path: string): TaskStatus {
  if (typeof value !== "string" || !STATUSES.has(value as TaskStatus)) {
    throw new Error(`${path}: ${field} must be pending, in_progress, or completed`);
  }
  return value as TaskStatus;
}

function parseSubtask(value: unknown, field: string, path: string): Subtask {
  const record = requireRecord(value, field, path);
  const subtask: Subtask = {
    id: requireString(record.id, `${field}.id`, path),
    name: requireString(record.name, `${field}.name`, path),
    status: parseStatus(record.status, `${field}.status`, path),
  };
  if (record.assignee !== undefined) {
    subtask.assignee = requireString(record.assignee, `${field}.assignee`, path);
  }
  return subtask;
}

function parseTask(value: unknown, field: string, path: string): Task {
  const record = requireRecord(value, field, path);
  if (!Array.isArray(record.subtasks)) {
    throw new Error(`${path}: ${field}.subtasks must be an array`);
  }
  const task: Task = {
    id: requireString(record.id, `${field}.id`, path),
    name: requireString(record.name, `${field}.name`, path),
    status: parseStatus(record.status, `${field}.status`, path),
    subtasks: record.subtasks.map((subtask, index) => parseSubtask(subtask, `${field}.subtasks[${index}]`, path)),
  };
  if (record.assignee !== undefined) {
    task.assignee = requireString(record.assignee, `${field}.assignee`, path);
  }
  return task;
}

function parseDocument(value: unknown, path: string): TaskListDocument {
  const record = requireRecord(value, "document", path);
  if (record.version !== 1) {
    throw new Error(`${path}: unsupported task-list version ${String(record.version)}`);
  }
  const id = requireString(record.id, "id", path);
  assertTaskListId(id);
  if (!Array.isArray(record.active)) throw new Error(`${path}: active must be an array`);
  if (!Array.isArray(record.completed)) throw new Error(`${path}: completed must be an array`);

  const active = record.active.map((task, index) => parseTask(task, `active[${index}]`, path));
  const completed = record.completed.map((task, index) => parseTask(task, `completed[${index}]`, path));
  if (active.some((task) => task.status === "completed")) {
    throw new Error(`${path}: active parent tasks cannot be completed`);
  }
  if (completed.some((task) => task.status !== "completed")) {
    throw new Error(`${path}: completed parent tasks must have completed status`);
  }

  return {
    version: 1,
    id,
    originSessionId: requireString(record.originSessionId, "originSessionId", path),
    createdAt: requireString(record.createdAt, "createdAt", path),
    updatedAt: requireString(record.updatedAt, "updatedAt", path),
    active,
    completed,
  };
}

async function readDocument(path: string, expectedId?: string): Promise<TaskListDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Task list not found: ${path}`);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: invalid JSON: ${message}`);
  }
  const document = parseDocument(value, path);
  if (expectedId !== undefined && document.id !== expectedId) {
    throw new Error(`${path}: document id does not match filename`);
  }
  return document;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function resolveRepositoryRoot(
  cwd: string,
  gitTopLevel: (cwd: string) => Promise<string | undefined> = async () => undefined,
): Promise<string> {
  const gitRoot = await gitTopLevel(cwd);
  const selected = gitRoot?.trim() || cwd;
  return resolve(isAbsolute(selected) ? selected : resolve(cwd, selected));
}

export class TaskStore {
  readonly fileRoot: string;
  private readonly options: RequiredStoreOptions;

  constructor(repositoryRoot: string, options: StoreOptions = {}) {
    this.fileRoot = join(resolve(repositoryRoot), ".pi", "tasks");
    this.options = {
      lockTimeoutMs: options.lockTimeoutMs ?? 2_000,
      staleLockMs: options.staleLockMs ?? 30_000,
      retryDelayMs: options.retryDelayMs ?? 20,
      now: options.now ?? (() => new Date()),
    };
  }

  async create(originSessionId: string): Promise<TaskListDocument> {
    const id = randomUUID();
    const path = this.filePath(id);
    return withFileMutationQueue(path, async () =>
      this.withLock(id, async () => {
        const now = this.options.now().toISOString();
        const document = createTaskList(id, originSessionId, now);
        await this.writeAtomic(path, document);
        return document;
      }),
    );
  }

  async read(id: string): Promise<TaskListDocument> {
    return readDocument(this.filePath(id), id);
  }

  async discover(): Promise<TaskListCandidate[]> {
    await mkdir(this.fileRoot, { recursive: true });
    const entries = await readdir(this.fileRoot, { withFileTypes: true });
    const documents: TaskListDocument[] = [];
    const errors: Error[] = [];

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const id = entry.name.slice(0, -5);
          try {
            assertTaskListId(id);
            const document = await readDocument(join(this.fileRoot, entry.name), id);
            documents.push(document);
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );

    if (errors.length > 0) {
      throw new AggregateError(errors, `Could not discover task lists in ${this.fileRoot}`);
    }

    return documents
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((document) => {
        const candidate: TaskListCandidate = {
          id: document.id,
          updatedAt: document.updatedAt,
          activeCount: document.active.length,
          completedCount: document.completed.length,
        };
        const firstTaskName = document.active[0]?.name ?? document.completed[0]?.name;
        if (firstTaskName !== undefined) candidate.firstTaskName = firstTaskName;
        return candidate;
      });
  }

  async mutate(
    id: string,
    operation: MutationOperation,
    nextId: IdFactory = randomUUID,
  ): Promise<MutationResult> {
    const path = this.filePath(id);
    return withFileMutationQueue(path, async () =>
      this.withLock(id, async () => {
        const current = await readDocument(path, id);
        const result = applyMutation(current, operation, this.options.now().toISOString(), nextId);
        await this.writeAtomic(path, result.document);
        return result;
      }),
    );
  }

  private filePath(id: string): string {
    assertTaskListId(id);
    return join(this.fileRoot, `${id}.json`);
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.fileRoot, { recursive: true });
    const lockPath = join(this.fileRoot, `${id}.lock`);
    const startedAt = Date.now();
    let ownsLock = false;

    while (!ownsLock) {
      try {
        await mkdir(lockPath);
        ownsLock = true;
        await this.writeOwner(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (await this.isStale(lockPath)) {
          await this.reclaimStaleLock(lockPath);
          continue;
        }
        if (Date.now() - startedAt >= this.options.lockTimeoutMs) {
          throw new Error(`Timed out waiting for task-list lock: ${lockPath}`);
        }
        await delay(this.options.retryDelayMs);
      }
    }

    try {
      return await operation();
    } finally {
      if (ownsLock) await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async isStale(lockPath: string): Promise<boolean> {
    try {
      const lockStat = await stat(lockPath);
      return Date.now() - lockStat.mtimeMs >= this.options.staleLockMs;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async reclaimStaleLock(lockPath: string): Promise<void> {
    const reclaimPath = `${lockPath}.reclaim`;
    try {
      await mkdir(reclaimPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return;
      throw error;
    }

    try {
      if (await this.isStale(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } finally {
      await rm(reclaimPath, { recursive: true, force: true });
    }
  }

  private async writeOwner(lockPath: string): Promise<void> {
    const ownerPath = join(lockPath, "owner.json");
    const handle = await open(ownerPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeAtomic(path: string, document: TaskListDocument): Promise<void> {
    await mkdir(this.fileRoot, { recursive: true });
    const temporaryPath = join(this.fileRoot, `${document.id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
