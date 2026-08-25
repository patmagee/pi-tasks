import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { resolveRepositoryRoot, TaskStore } from "../src/store.ts";

const fixedClock = () => new Date("2026-08-24T12:00:00.000Z");

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function startMutator(root: string, id: string, name: string, readyRoot: string, goPath: string) {
  const script = `
    import { access, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { TaskStore } from "./src/store.ts";
    const { ROOT, ID, NAME, READY_ROOT, GO_PATH } = process.env;
    await writeFile(join(READY_ROOT, NAME), "ready");
    while (true) {
      try { await access(GO_PATH); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
    }
    await new TaskStore(ROOT, { staleLockMs: 0, lockTimeoutMs: 2_000, retryDelayMs: 2 })
      .mutate(ID, { action: "add", name: NAME });
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, ROOT: root, ID: id, NAME: name, READY_ROOT: readyRoot, GO_PATH: goPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child: ReturnType<typeof startMutator>): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  assert.equal(code, 0, stderr);
}

test("resolveRepositoryRoot uses Git root and falls back to cwd", async () => {
  assert.equal(await resolveRepositoryRoot("/repo/sub", async () => "/repo"), "/repo");
  assert.equal(await resolveRepositoryRoot("/plain", async () => undefined), "/plain");
});

test("create writes separate versioned files and discover returns newest metadata first", async (t) => {
  const root = await temporaryRoot(t);
  let timestamp = Date.parse("2026-08-24T12:00:00.000Z");
  const store = new TaskStore(root, { now: () => new Date(timestamp) });
  const first = await store.create("session-a");
  timestamp += 1_000;
  const second = await store.create("session-b");
  timestamp += 1_000;
  await store.mutate(first.id, { action: "add", name: "First task" }, () => "task-a");

  assert.notEqual(first.id, second.id);
  const candidates = await store.discover();
  assert.deepEqual(candidates.map((candidate) => candidate.id), [first.id, second.id]);
  assert.deepEqual(candidates[0], {
    id: first.id,
    updatedAt: "2026-08-24T12:00:02.000Z",
    activeCount: 1,
    completedCount: 0,
    firstTaskName: "First task",
  });
});

test("mutate reads latest state and preserves concurrent additions", async (t) => {
  const root = await temporaryRoot(t);
  const storeA = new TaskStore(root);
  const document = await storeA.create("session-a");
  const storeB = new TaskStore(root);

  await Promise.all([
    storeA.mutate(document.id, { action: "add", name: "A" }, () => "task-a"),
    storeB.mutate(document.id, { action: "add", name: "B" }, () => "task-b"),
  ]);

  assert.deepEqual((await storeA.read(document.id)).active.map((task) => task.name).sort(), ["A", "B"]);
});

test("persisted JSON is complete and has no temporary file after mutation", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { now: fixedClock });
  const document = await store.create("session-a");
  await store.mutate(document.id, { action: "add", name: "Saved" }, () => "task-a");

  const raw = await readFile(join(store.fileRoot, `${document.id}.json`), "utf8");
  assert.equal(JSON.parse(raw).active[0].name, "Saved");
  const candidates = await store.discover();
  assert.equal(candidates.length, 1);
});

test("read rejects invalid identifiers before resolving a path", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  await assert.rejects(store.read("../outside"), /invalid task-list identifier/i);
});

test("read rejects missing malformed and unsupported task-list files", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  await mkdir(store.fileRoot, { recursive: true });
  const malformedId = "00000000-0000-4000-8000-000000000011";
  const unsupportedId = "00000000-0000-4000-8000-000000000012";
  await writeFile(join(store.fileRoot, `${malformedId}.json`), "{", "utf8");
  await writeFile(
    join(store.fileRoot, `${unsupportedId}.json`),
    JSON.stringify({ version: 2, id: unsupportedId }),
    "utf8",
  );

  await assert.rejects(store.read("00000000-0000-4000-8000-000000000013"), /not found/i);
  await assert.rejects(store.read(malformedId), new RegExp(`${malformedId}\\.json.*JSON`, "i"));
  await assert.rejects(store.read(unsupportedId), /unsupported.*version/i);
});

test("read rejects mismatched identifiers and invalid section state", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { now: fixedClock });
  const document = await store.create("session-a");
  const otherId = "00000000-0000-4000-8000-000000000031";
  await writeFile(
    join(store.fileRoot, `${otherId}.json`),
    JSON.stringify({ ...document, id: "00000000-0000-4000-8000-000000000032" }),
    "utf8",
  );
  await assert.rejects(store.read(otherId), /does not match filename/i);

  const invalidId = "00000000-0000-4000-8000-000000000033";
  await writeFile(
    join(store.fileRoot, `${invalidId}.json`),
    JSON.stringify({
      ...document,
      id: invalidId,
      active: [{ id: "task-a", name: "Already done", status: "completed", subtasks: [] }],
    }),
    "utf8",
  );
  await assert.rejects(store.read(invalidId), /active.*cannot be completed/i);

  const nestedId = "00000000-0000-4000-8000-000000000034";
  await writeFile(
    join(store.fileRoot, `${nestedId}.json`),
    JSON.stringify({
      ...document,
      id: nestedId,
      active: [{
        id: "task-a",
        name: "Parent",
        status: "pending",
        subtasks: [{ id: "sub-a", name: "Nested", status: "pending", subtasks: [] }],
      }],
    }),
    "utf8",
  );
  await assert.rejects(store.read(nestedId), /subtask.*subtasks.*not supported/i);
});

test("discover reports malformed candidate files without returning partial results", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const valid = await store.create("session-a");
  const malformedId = "00000000-0000-4000-8000-000000000021";
  await writeFile(join(store.fileRoot, `${malformedId}.json`), "not-json", "utf8");

  await assert.rejects(store.discover(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /discover/i);
    assert.match(String(error.errors[0]), new RegExp(malformedId));
    return true;
  });

  const available = await store.discoverAvailable();
  assert.deepEqual(available.candidates.map((candidate) => candidate.id), [valid.id]);
  assert.equal(available.errors.length, 1);
  assert.match(available.errors[0] ?? "", new RegExp(malformedId));
  assert.doesNotMatch(available.errors[0] ?? "", /not-json/);
});

test("lock timeout leaves the current document unchanged", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { lockTimeoutMs: 30, retryDelayMs: 5, staleLockMs: 60_000 });
  const document = await store.create("session-a");
  await mkdir(join(store.fileRoot, `${document.id}.lock`));

  await assert.rejects(
    store.mutate(document.id, { action: "add", name: "Blocked" }, () => "task-a"),
    /timed out.*lock/i,
  );
  assert.equal((await store.read(document.id)).active.length, 0);
});

test("a stale lock is recovered before mutation", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { lockTimeoutMs: 100, retryDelayMs: 5, staleLockMs: 0 });
  const document = await store.create("session-a");
  const lockPath = join(store.fileRoot, `${document.id}.lock`);
  await mkdir(lockPath);
  const old = new Date(Date.now() - 5_000);
  await utimes(lockPath, old, old);

  const result = await store.mutate(document.id, { action: "add", name: "Recovered" }, () => "task-a");
  assert.equal(result.document.active[0]?.name, "Recovered");
});

test("a live process lock is never reclaimed only because of age", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { lockTimeoutMs: 30, retryDelayMs: 5, staleLockMs: 0 });
  const document = await store.create("session-a");
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"]);
  t.after(() => child.kill());
  assert.notEqual(child.pid, undefined);

  const lockPath = join(store.fileRoot, `${document.id}.lock`);
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ token: "live-owner", pid: child.pid, acquiredAt: new Date(0).toISOString() }),
    "utf8",
  );
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    store.mutate(document.id, { action: "add", name: "Must wait" }),
    /timed out.*lock/i,
  );
  assert.equal((await store.read(document.id)).active.length, 0);
});

test("a live owner-initialization marker prevents stale reclaim", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root, { lockTimeoutMs: 30, retryDelayMs: 5, staleLockMs: 0 });
  const document = await store.create("session-a");
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"]);
  t.after(() => child.kill());
  assert.notEqual(child.pid, undefined);

  const lockPath = join(store.fileRoot, `${document.id}.lock`);
  await mkdir(lockPath);
  await mkdir(join(lockPath, `.owner-${child.pid}-initializing`));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    store.mutate(document.id, { action: "add", name: "Must wait" }),
    /timed out.*lock/i,
  );
  assert.equal((await store.read(document.id)).active.length, 0);
});

test("initialization cleanup cannot remove a replacement owner's lock", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const document = await store.create("session-a");
  const lockPath = join(store.fileRoot, `${document.id}.lock`);
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ token: "replacement", pid: process.pid, acquiredAt: new Date().toISOString() }),
    "utf8",
  );
  const contenderToken = "contender";
  await mkdir(join(lockPath, `.owner-${process.pid}-${contenderToken}`));

  const internal = store as unknown as {
    releaseOwnedLock(path: string, token: string): Promise<void>;
  };
  await internal.releaseOwnedLock(lockPath, contenderToken);
  assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token, "replacement");
});

test("a leaked reclaim gate still reaches the lock timeout", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const document = await store.create("session-a");
  const lockPath = join(store.fileRoot, `${document.id}.lock`);
  await mkdir(lockPath);
  await mkdir(`${lockPath}.reclaim`);

  const script = `
    import { TaskStore } from "./src/store.ts";
    const { ROOT, ID } = process.env;
    try {
      await new TaskStore(ROOT, { staleLockMs: 0, lockTimeoutMs: 30, retryDelayMs: 2 })
        .mutate(ID, { action: "add", name: "blocked" });
      process.exit(2);
    } catch (error) {
      process.exit(/timed out/i.test(String(error)) ? 0 : 3);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, ROOT: root, ID: document.id },
    stdio: "ignore",
  });
  const code = await Promise.race([
    new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
    new Promise<"hung">((resolveHung) => setTimeout(() => resolveHung("hung"), 500)),
  ]);
  if (code === "hung") child.kill();
  assert.equal(code, 0, "mutation hung instead of reaching lock timeout");
});

test("two processes reclaiming one stale lock preserve both mutations", async (t) => {
  const root = await temporaryRoot(t);
  const store = new TaskStore(root);
  const document = await store.create("session-a");
  const lockPath = join(store.fileRoot, `${document.id}.lock`);
  await mkdir(lockPath);
  const old = new Date(Date.now() - 5_000);
  await utimes(lockPath, old, old);

  const readyRoot = join(root, "ready");
  const goPath = join(root, "go");
  await mkdir(readyRoot);
  const first = startMutator(root, document.id, "process-a", readyRoot, goPath);
  const second = startMutator(root, document.id, "process-b", readyRoot, goPath);
  await Promise.all([
    waitForFile(join(readyRoot, "process-a")),
    waitForFile(join(readyRoot, "process-b")),
  ]);
  await writeFile(goPath, "go");
  await Promise.all([waitForExit(first), waitForExit(second)]);

  assert.deepEqual((await store.read(document.id)).active.map((task) => task.name).sort(), ["process-a", "process-b"]);
});
