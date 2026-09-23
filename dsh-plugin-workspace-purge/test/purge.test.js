import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspacePurge } from "../lib/index.js";

/**
 * Build a purge observer over a stub host context.
 *
 * The three services are stand-ins; the file work is real, against a temporary
 * directory the caller owns.
 */
function harness({ artifacts = [], live = [], config, persistence } = {}) {
  const emitted = [];
  const logs = [];
  let listCalls = 0;
  const ctx = {
    sessions: { get: (id) => (live.includes(id) ? { id } : undefined) },
    sessionPersistence:
      persistence ??
      {
        async listArtifacts() {
          listCalls += 1;
          return artifacts.map((artifact) => ({ header: { id: artifact.id }, path: artifact.path }));
        }
      },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message)
    },
    emit: (event, ...args) => emitted.push([event, ...args])
  };
  return { purge: new WorkspacePurge(ctx, config), emitted, logs, listCalls: () => listCalls };
}

/** Build one session directory holding a committed log, and return its paths. */
function storedSession(root, sessionId) {
  const dir = join(root, "project", sessionId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "session.v3.jsonl");
  writeFileSync(logPath, "{}\n");
  return { dir, logPath };
}

/** The domain change that deletes one workspace. */
function deleted(workspaceId) {
  return { domain: "workspace", table: "workspaces", key: workspaceId, operation: "deleted" };
}

/** The domain change that republishes one workspace record. */
function put(workspaceId, sessionIds) {
  return { domain: "workspace", table: "workspaces", key: workspaceId, operation: "put", value: { sessionIds } };
}

/** Run one deletion through the observer and wait for its file work to settle. */
async function observeDelete(purge, workspaceId) {
  purge.observe(deleted(workspaceId));
  await purge.settled();
}

test("a deleted workspace takes its stored sessions with it and tells the client", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const b = storedSession(root, "s-b");
    const { purge, emitted, logs } = harness({
      artifacts: [
        { id: "s-a", path: a.logPath },
        { id: "s-b", path: b.logPath }
      ]
    });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a", "s-b"] }]);

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(a.dir), false);
    assert.equal(existsSync(b.dir), false);
    assert.deepEqual(emitted, [
      ["api-session/removed", "s-a"],
      ["api-session/removed", "s-b"]
    ]);
    assert.match(logs.at(-1), /a deleted workspace accounted for 2 Session\(s\): 2 deleted$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live session is kept and reported, never deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const live = storedSession(root, "s-live");
    const cold = storedSession(root, "s-cold");
    const { purge, emitted, logs } = harness({
      live: ["s-live"],
      artifacts: [
        { id: "s-live", path: live.logPath },
        { id: "s-cold", path: cold.logPath }
      ]
    });
    purge.seed([{ id: "ws-1", sessionIds: ["s-live", "s-cold"] }]);

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(live.dir), true, "a live session's log is held open and would be recreated anyway");
    assert.equal(existsSync(cold.dir), false);
    assert.deepEqual(emitted, [["api-session/removed", "s-cold"]]);
    assert.match(logs.at(-1), /1 kept because they are live/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disabled plugin deletes nothing and still forgets the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const { purge, emitted, logs, listCalls } = harness({
      config: { enabled: false },
      artifacts: [{ id: "s-a", path: a.logPath }]
    });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(a.dir), true);
    assert.deepEqual(emitted, []);
    assert.equal(listCalls(), 0, "a disabled plugin never even lists stored sessions");
    assert.match(logs.at(-1), /the plugin is disabled, so nothing was deleted/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the account is the one current at deletion, not the one seeded at activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const b = storedSession(root, "s-b");
    const { purge } = harness({
      artifacts: [
        { id: "s-a", path: a.logPath },
        { id: "s-b", path: b.logPath }
      ]
    });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);
    purge.observe(put("ws-1", ["s-a", "s-b"]));

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(a.dir), false);
    assert.equal(existsSync(b.dir), false, "a session attached after activation is still part of the account");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace whose account was emptied by a later put deletes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const { purge, listCalls } = harness({ artifacts: [{ id: "s-a", path: a.logPath }] });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);
    purge.observe(put("ws-1", []));

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(a.dir), true);
    assert.equal(listCalls(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessions of another workspace survive a deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const mine = storedSession(root, "s-mine");
    const theirs = storedSession(root, "s-theirs");
    const { purge } = harness({
      artifacts: [
        { id: "s-mine", path: mine.logPath },
        { id: "s-theirs", path: theirs.logPath }
      ]
    });
    purge.seed([
      { id: "ws-1", sessionIds: ["s-mine"] },
      { id: "ws-2", sessionIds: ["s-theirs"] }
    ]);

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(mine.dir), false);
    assert.equal(existsSync(theirs.dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session with no stored log is reported absent instead of failing", async () => {
  const { purge, logs } = harness({ artifacts: [] });
  purge.seed([{ id: "ws-1", sessionIds: ["s-never-materialized"] }]);

  await observeDelete(purge, "ws-1");

  assert.match(logs.at(-1), /1 had no stored log/u);
});

test("a backend that cannot locate stored logs fails the purge loudly", async () => {
  const { purge, logs, emitted } = harness({ persistence: {} });
  purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);

  await observeDelete(purge, "ws-1");

  assert.deepEqual(emitted, []);
  assert.match(logs[0], /does not expose listArtifacts\(\)/u);
  assert.match(logs.at(-1), /1 failed/u);
});

test("a session whose directory is already gone is announced, not skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const { purge, emitted, logs } = harness({ artifacts: [{ id: "s-a", path: a.logPath }] });
    rmSync(a.dir, { recursive: true, force: true });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);

    await observeDelete(purge, "ws-1");

    assert.deepEqual(emitted, [["api-session/removed", "s-a"]], "a session absent from storage is still gone from the client's point of view");
    assert.match(logs.at(-1), /1 deleted$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that no longer holds the identifying log is left alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    rmSync(a.logPath, { force: true });
    writeFileSync(join(a.dir, "session.v4.jsonl"), "{}\n");

    const { purge, emitted, logs } = harness({ artifacts: [{ id: "s-a", path: a.logPath }] });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(a.dir), true, "an unidentified directory is never removed recursively");
    assert.deepEqual(emitted, []);
    assert.match(logs.at(-1), /1 left alone/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("notifyClient false purges the logs without touching the client list", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const { purge, emitted } = harness({
      config: { notifyClient: false },
      artifacts: [{ id: "s-a", path: a.logPath }]
    });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);

    await observeDelete(purge, "ws-1");

    assert.equal(existsSync(a.dir), false);
    assert.deepEqual(emitted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changes outside the workspaces table of the workspace domain are ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const { purge, listCalls } = harness({ artifacts: [{ id: "s-a", path: a.logPath }] });
    purge.seed([{ id: "ws-1", sessionIds: ["s-a"] }]);

    purge.observe({ domain: "workspace", table: "archived", key: "ws-1", operation: "deleted" });
    purge.observe({ domain: "settings", table: "workspaces", key: "ws-1", operation: "deleted" });
    purge.observe({ domain: "workspace", table: "workspaces", key: "ws-1", operation: "put" });
    await purge.settled();

    assert.equal(existsSync(a.dir), true);
    assert.equal(listCalls(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting an unknown workspace is an idempotent no-op", async () => {
  const { purge, listCalls, logs } = harness({});

  await observeDelete(purge, "ws-absent");

  assert.equal(listCalls(), 0);
  assert.deepEqual(logs, []);
});
