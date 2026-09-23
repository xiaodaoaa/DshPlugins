import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Config, apply, inject, name, planPurge, sessionDirOf } from "../lib/index.js";

/**
 * Load the plugin against a stub Cordis context.
 *
 * This exercises the real `apply`; only the cordis runtime and the three
 * services are stand-ins. The stub mirrors cordis's `effect()` contract: run the
 * executor, and collect every yielded disposer.
 */
function load({ workspaces = [], artifacts = [], live = [], config = {} } = {}) {
  const listeners = [];
  const emitted = [];
  const logs = [];
  const labels = [];
  const disposers = [];
  const ctx = {
    workspaceRegistry: { list: () => workspaces },
    sessions: { get: (id) => (live.includes(id) ? { id } : undefined) },
    sessionPersistence: {
      listArtifacts: async () => artifacts.map((artifact) => ({ header: { id: artifact.id }, path: artifact.path }))
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message)
    },
    emit: (event, ...args) => emitted.push([event, ...args]),
    on(event, listener) {
      listeners.push({ event, listener });
      return () => {};
    },
    effect(execute, label) {
      labels.push(label);
      for (const disposer of execute()) disposers.push(disposer);
    }
  };
  apply(ctx, config);
  return {
    ctx,
    disposers,
    emitted,
    labels,
    logs,
    subscriptions: listeners,
    fire: (change) => {
      for (const subscription of listeners) subscription.listener(change);
    }
  };
}

/** Poll until `predicate` holds, so an asynchronous purge settles without a fixed sleep. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the purge did not settle before the timeout");
}

/** Build one project directory holding a session directory with a committed log. */
function storedSession(root, sessionId, logName = "session.v3.jsonl") {
  const dir = join(root, "project", sessionId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, logName);
  writeFileSync(logPath, "{}\n");
  return { dir, logPath };
}

test("module exports the cordis plugin shape", () => {
  assert.equal(name, "workspace-purge");
  assert.deepEqual(inject, ["workspaceRegistry", "sessionPersistence", "sessions"]);
  assert.equal(typeof apply, "function");
  assert.equal(typeof Config, "function");
});

test("the schema defaults both switches to on", () => {
  const resolved = Config({});
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.notifyClient, true);
});

test("sessionDirOf accepts a committed log and returns its session directory", () => {
  assert.equal(sessionDirOf(join("root", "project", "s-a", "session.v3.jsonl")), join("root", "project", "s-a"));
  assert.equal(sessionDirOf(join("root", "project", "s-a", "session.jsonl")), join("root", "project", "s-a"));
  assert.equal(sessionDirOf(join("root", "project", "s-a", "session.v3.jsonl.zstd")), join("root", "project", "s-a"));
});

test("sessionDirOf refuses every path it must not delete a directory for", () => {
  assert.equal(sessionDirOf(undefined), undefined);
  assert.equal(sessionDirOf(""), undefined);
  assert.equal(sessionDirOf(join("root", "project", "s-a", "notes.txt")), undefined);
  assert.equal(sessionDirOf(join("root", "project", "s-a", "session.lock")), undefined);
  assert.equal(sessionDirOf("/session.v3.jsonl"), undefined, "a filesystem root is never a session directory");
  assert.equal(sessionDirOf("session.v3.jsonl"), undefined, "a relative bare filename resolves to the process directory");
});

test("planPurge splits one account into delete and keep buckets", () => {
  const artifacts = new Map([
    ["s-a", join("root", "p", "s-a", "session.v3.jsonl")],
    ["s-b", join("root", "p", "s-b", "session.v3.jsonl")],
    ["s-d", join("root", "p", "s-d", "notes.txt")]
  ]);
  const plan = planPurge(["s-a", "s-b", "s-c", "s-d", "s-live"], artifacts, (id) => id === "s-live");

  assert.deepEqual(plan.purge.map((entry) => entry.id), ["s-a", "s-b"]);
  assert.equal(plan.purge[0].dir, join("root", "p", "s-a"));
  assert.equal(plan.purge[0].logName, "session.v3.jsonl");
  assert.deepEqual(plan.live, ["s-live"]);
  assert.deepEqual(plan.absent, ["s-c"]);
  assert.deepEqual(plan.refused, ["s-d"]);
});

test("planPurge refuses a directory that holds more than one session's log", () => {
  const sharedDir = join("root", "p");
  const artifacts = new Map([
    ["s-a", join(sharedDir, "session.v3.jsonl")],
    ["s-b", join(sharedDir, "session.v3.jsonl")]
  ]);
  const plan = planPurge(["s-a", "s-b"], artifacts, () => false);

  assert.deepEqual(plan.purge, [], "a layout that puts logs straight into the project directory never deletes that directory");
  assert.deepEqual(plan.refused, ["s-a", "s-b"]);
});

test("planPurge still purges a project directory holding exactly one session", () => {
  const artifacts = new Map([["s-a", join("root", "p", "session.v3.jsonl")]]);
  const plan = planPurge(["s-a"], artifacts, () => false);

  assert.deepEqual(plan.purge.map((entry) => entry.id), ["s-a"], "no sibling session is at risk, so the intended deletion stands");
});

test("apply seeds the account and subscribes to workspace domain changes", () => {
  const { disposers, labels, subscriptions } = load({
    workspaces: [{ id: "ws-1", sessionIds: ["s-a"] }]
  });
  assert.deepEqual(labels, ["dsh-plugin-workspace-purge: purge the Sessions of a deleted Workspace"]);
  assert.equal(disposers.length, 1, "the effect yields the unsubscriber as its disposer");
  assert.equal(typeof disposers[0], "function");
  assert.deepEqual(subscriptions.map((subscription) => subscription.event), ["domain/changed"]);
});

test("a deletion observed through apply deletes the stored logs of that workspace only", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-"));
  try {
    const a = storedSession(root, "s-a");
    const b = storedSession(root, "s-b");
    const other = storedSession(root, "s-other");

    const { fire, emitted } = load({
      workspaces: [{ id: "ws-1", sessionIds: ["s-a", "s-b"] }],
      artifacts: [
        { id: "s-a", path: a.logPath },
        { id: "s-b", path: b.logPath },
        { id: "s-other", path: other.logPath }
      ]
    });

    fire({ domain: "workspace", table: "workspaces", key: "ws-1", operation: "deleted" });

    await waitFor(() => !existsSync(a.dir) && !existsSync(b.dir));
    assert.equal(existsSync(other.dir), true, "a session outside the deleted workspace keeps its log");
    assert.deepEqual(emitted, [
      ["api-session/removed", "s-a"],
      ["api-session/removed", "s-b"]
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
