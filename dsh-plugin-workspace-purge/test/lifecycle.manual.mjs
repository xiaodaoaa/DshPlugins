/**
 * Manual verification against the real Cordis runtime.
 *
 * Not part of `node --test`: it needs the harness packages resolvable, so run it
 * from a profile directory that has this plugin installed (or with this
 * package's own `node_modules` links in place):
 *
 *   cd "$DSH_HOME/profiles/web" && node "D:\path\to\dsh-plugin-workspace-purge\test\lifecycle.manual.mjs"
 *
 * It mounts the plugin through a real `Context.plugin()` fiber with real
 * `Service` instances behind its `inject` list, then drives a real
 * `domain/changed` emission. That proves activation, inject resolution, the
 * `ctx.effect` subscription, and — after `fiber.dispose()` — that the observer
 * really is gone, none of which the stub-context unit tests can show.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";

class WorkspaceRegistry extends Service {
  constructor(ctx, workspaces) {
    super(ctx, "workspaceRegistry");
    this.workspaces = workspaces;
  }
  list() {
    return this.workspaces;
  }
}

class Sessions extends Service {
  constructor(ctx, live) {
    super(ctx, "sessions");
    this.live = live;
  }
  get(id) {
    return this.live.includes(id) ? { id } : undefined;
  }
}

class SessionPersistence extends Service {
  constructor(ctx, artifacts) {
    super(ctx, "sessionPersistence");
    this.artifacts = artifacts;
  }
  async listArtifacts() {
    return this.artifacts.map((artifact) => ({ header: { id: artifact.id }, path: artifact.path }));
  }
}

const root = mkdtempSync(join(tmpdir(), "dsh-plugin-workspace-purge-lifecycle-"));
const session = (id) => {
  const dir = join(root, "project", id);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "session.v3.jsonl");
  writeFileSync(logPath, "{}\n");
  return { dir, logPath };
};

const doomed = session("s-doomed");
const other = session("s-other");
const kept = session("s-live");

const ctx = new Context();
new WorkspaceRegistry(ctx, [
  { id: "ws-1", sessionIds: ["s-doomed", "s-live"] },
  { id: "ws-2", sessionIds: ["s-other"] }
]);
new Sessions(ctx, ["s-live"]);
new SessionPersistence(ctx, [
  { id: "s-doomed", path: doomed.logPath },
  { id: "s-other", path: other.logPath },
  { id: "s-live", path: kept.logPath }
]);

const mod = await import("dsh-plugin-workspace-purge");
const fiber = ctx.plugin(mod, {});
await new Promise((resolve) => setTimeout(resolve, 50));

ctx.emit("domain/changed", { domain: "workspace", table: "workspaces", key: "ws-1", operation: "deleted" });
await new Promise((resolve) => setTimeout(resolve, 200));

console.log("accounted session deleted:", existsSync(doomed.dir) === false);
console.log("live session kept:", existsSync(kept.dir) === true);
console.log("other workspace's session kept:", existsSync(other.dir) === true);

await fiber.dispose();
await new Promise((resolve) => setTimeout(resolve, 50));

const afterDispose = session("s-after-dispose");
ctx.emit("domain/changed", { domain: "workspace", table: "workspaces", key: "ws-1", operation: "deleted" });
await new Promise((resolve) => setTimeout(resolve, 200));

console.log("observer gone after dispose:", existsSync(afterDispose.dir) === true);

rmSync(root, { recursive: true, force: true });
