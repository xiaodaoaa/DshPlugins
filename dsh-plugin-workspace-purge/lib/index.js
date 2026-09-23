/**
 * Workspace-scoped Session purge: deleting a Workspace also deletes the stored
 * Sessions that belonged to it.
 *
 * DSH has no Session-deletion API. `@deepseek-ai/dsh-session-persistence` says
 * so outright — "no deletion or retention interface; pruning stored Sessions is
 * out-of-band backend maintenance" — and `@deepseek-ai/dsh-workspace` states
 * that removing a Workspace never deletes data, which is exactly why its
 * Sessions fall into the Ungrouped bucket. This plugin performs that out-of-band
 * maintenance, and nothing else: the Workspace's folder, its files, and every
 * Session that is not accounted to the deleted Workspace are left untouched.
 *
 * Three facts about the surrounding code shape the implementation.
 *
 * - A deletion is announced as `{ domain, table, key, operation: "deleted" }`
 *   with no value, and by the time the event is emitted the registry has already
 *   dropped the record from its cache. The Session account therefore has to be
 *   mirrored while it still exists: seeded from `ctx.workspaceRegistry.list()`
 *   at activation and refreshed from every `put` event, which is how
 *   `WorkspaceFeed` in `@deepseek-ai/dsh-api-workspace-controller` tracks the
 *   same domain.
 * - Stored Session paths come from `ctx.sessionPersistence.listArtifacts()`,
 *   whose `{ header, path }` pairs are the backend's own answer for where one
 *   Session lives. Re-deriving `root/<project>/<session>/session.vN.jsonl` here
 *   would duplicate a private path convention and break silently when it moves.
 * - A live Session is never deleted. The persistence backend holds its log open,
 *   `ctx.sessions` keeps serving it from memory, and the next append would
 *   recreate the file. There is no public way to close a live Session, so those
 *   Sessions are reported and left alone.
 *
 * Because the Workspace delete confirmation dialog in the shipped Web client
 * still promises that session logs are kept, this plugin makes that sentence
 * false. See the README's known limitations.
 *
 * @module dsh-plugin-workspace-purge
 */

import { readdir, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import Schema from "@deepseek-ai/schemastery";

/** Cordis plugin name, used in diagnostics and the profile tree. */
export const name = "workspace-purge";

/**
 * Services this plugin needs before it installs its observer.
 *
 * `workspaceRegistry` is the authoritative Workspace account, `sessions` is the
 * live-Session store that protects running Sessions, and `sessionPersistence` is
 * the only source of stored Session log paths.
 */
export const inject = ["workspaceRegistry", "sessionPersistence", "sessions"];

/** Deployment-owned configuration. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description("Delete the Sessions of a deleted Workspace; false keeps every stored log"),
  notifyClient: Schema.boolean().default(true).description("Tell connected clients that each purged Session is gone, so its sidebar row disappears without a reload")
});

/**
 * The one committed log filename a Session directory holds, in both physical
 * encodings: `session.jsonl`, `session.v3.jsonl`, `session.v3.jsonl.zstd`.
 *
 * Derived from `sessionFormatLogFilename` and `logSuffix` in
 * `@deepseek-ai/dsh-session-persistence-jsonl`; a name outside this shape is not
 * something this plugin is willing to delete a directory for.
 */
const SESSION_LOG_FILENAME = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u;

/**
 * The Session directory a committed log path belongs to, or `undefined` when the
 * path does not have the shape this plugin deletes.
 *
 * The guard exists because the directory is removed recursively. A path whose
 * basename is not a committed Session log — a stray file, a filesystem root, a
 * bare filename that resolves to the process directory — must never cost a
 * directory that holds anything else.
 *
 * @param logPath - absolute path of one stored Session log.
 * @returns the Session directory, or `undefined` when deletion is refused.
 */
export function sessionDirOf(logPath) {
  if (typeof logPath !== "string" || logPath.length === 0) return undefined;
  if (!SESSION_LOG_FILENAME.test(basename(logPath))) return undefined;
  const dir = dirname(logPath);
  if (dir === logPath || dirname(dir) === dir) return undefined;
  return dir;
}

/**
 * Directories that hold the committed logs of more than one Session.
 *
 * One Session owns one directory, so a directory named by several Sessions is
 * the project directory above them, not a Session directory — and recursively
 * deleting it would take every sibling Session with it. This is the guard that
 * survives a backend layout change, and it is derived from the backend's own
 * listing rather than from a path convention.
 *
 * @param artifactPaths - stored log path by Session id.
 * @returns the set of directories that must never be deleted.
 */
function sharedDirectories(artifactPaths) {
  const owners = new Map();
  for (const logPath of artifactPaths.values()) {
    const dir = sessionDirOf(logPath);
    if (dir === undefined) continue;
    const count = owners.get(dir) ?? 0;
    owners.set(dir, count + 1);
  }
  return new Set([...owners].filter(([, count]) => count > 1).map(([dir]) => dir));
}

/**
 * Split one Workspace's Session account into what will be deleted and what will
 * not, without touching the filesystem.
 *
 * @param sessionIds - the account mirrored before the Workspace was deleted.
 * @param artifactPaths - stored log path by Session id, as the backend reports it.
 * @param isLive - predicate answering whether one Session is live right now.
 * @returns `purge` pairs to delete, plus the identities kept as `live`, absent
 *   from storage, or refused for an unexpected path shape.
 */
export function planPurge(sessionIds, artifactPaths, isLive) {
  const purge = [];
  const live = [];
  const absent = [];
  const refused = [];
  const shared = sharedDirectories(artifactPaths);
  for (const id of sessionIds) {
    if (isLive(id)) {
      live.push(id);
      continue;
    }
    const logPath = artifactPaths.get(id);
    if (logPath === undefined) {
      absent.push(id);
      continue;
    }
    const dir = sessionDirOf(logPath);
    if (dir === undefined || shared.has(dir)) {
      refused.push(id);
      continue;
    }
    purge.push({ id, dir, logName: basename(logPath) });
  }
  return { purge, live, absent, refused };
}

/**
 * Delete one Session directory, but only after confirming the directory still
 * holds the log that identified it.
 *
 * @param dir - the Session directory to remove recursively.
 * @param logName - the committed log filename that must be present inside it.
 * @returns `"removed"` when this call deleted it, `"absent"` when it was already
 *   gone, and `"unidentified"` when it no longer holds that log and was
 *   therefore left alone rather than guessed at.
 */
async function removeSessionDir(dir, logName) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  if (!entries.includes(logName)) return "unidentified";
  await rm(dir, { recursive: true, force: true });
  return "removed";
}

/**
 * Workspace-deletion observer. Mirrors the Session account of every Workspace
 * and purges the stored Sessions of one that is deleted.
 */
export class WorkspacePurge {
  /** Session account by Workspace id, as last observed in the domain. */
  #accounts = new Map();

  /** Serializes purges so two deletions cannot interleave their file work. */
  #chain = Promise.resolve();

  #ctx;

  #config;

  /**
   * @param ctx - host context carrying the registry, the Session store, and the
   *   persistence backend.
   * @param config - resolved configuration; both fields default to `true`.
   */
  constructor(ctx, config) {
    this.#ctx = ctx;
    this.#config = { enabled: config?.enabled ?? true, notifyClient: config?.notifyClient ?? true };
  }

  /**
   * Record the Session account of every Workspace that already exists.
   *
   * `Workspace.sessionIds` is the registry's own live-cwd-filtered view, which
   * is the same filtering the registry applies before every write, so the seed
   * matches what later `put` events report.
   *
   * @param workspaces - the registry's ordered Workspace projection.
   */
  seed(workspaces) {
    for (const workspace of workspaces) {
      this.#accounts.set(String(workspace.id), [...workspace.sessionIds].map(String));
    }
  }

  /**
   * Apply one `domain/changed` notification.
   *
   * A `put` refreshes the mirror. A `deleted` takes the mirrored account, drops
   * it, and queues the purge — never awaited here, because the emitter treats
   * listeners as notifications and a slow delete must not stall the Workspace
   * write that produced it.
   *
   * @param change - one domain change notification.
   */
  observe(change) {
    if (change?.domain !== "workspace" || change?.table !== "workspaces") return;
    const key = String(change.key);
    if (change.operation === "deleted") {
      const sessionIds = this.#accounts.get(key) ?? [];
      this.#accounts.delete(key);
      if (!this.#config.enabled) {
        this.#ctx.logger.info(`workspace-purge: workspace "${key}" was deleted with ${sessionIds.length} Session(s); the plugin is disabled, so nothing was deleted`);
        return;
      }
      this.#chain = this.#chain
        .then(() => this.purge(sessionIds))
        .catch((error) => {
          this.#ctx.logger.warn(`workspace-purge: purging the Sessions of workspace "${key}" failed: ${String(error)}`);
        });
      return;
    }
    if (change.operation === "put" && change.value !== undefined) {
      this.#accounts.set(key, [...change.value.sessionIds].map(String));
    }
  }

  /**
   * Wait for every queued purge to settle. Used by tests and by nothing in the
   * plugin's own lifecycle.
   *
   * @returns a promise resolving when the queue is empty.
   */
  settled() {
    return this.#chain;
  }

  /**
   * Delete every stored Session of one deleted Workspace.
   *
   * @param sessionIds - the account mirrored before the deletion.
   * @returns a report naming the identities in each outcome bucket.
   */
  async purge(sessionIds) {
    const report = { purged: [], live: [], absent: [], refused: [], unidentified: [], failed: [] };
    if (sessionIds.length === 0) return report;

    let artifactPaths;
    try {
      artifactPaths = await this.#artifactPaths();
    } catch (error) {
      this.#ctx.logger.warn(`workspace-purge: cannot locate stored Session logs, so nothing was deleted: ${String(error)}`);
      report.failed.push(...sessionIds);
      this.#log(report, sessionIds.length);
      return report;
    }

    const plan = planPurge(sessionIds, artifactPaths, (id) => this.#ctx.sessions.get(id) !== undefined);
    report.live.push(...plan.live);
    report.absent.push(...plan.absent);
    report.refused.push(...plan.refused);

    for (const { id, dir, logName } of plan.purge) {
      try {
        const outcome = await removeSessionDir(dir, logName);
        if (outcome === "unidentified") {
          report.unidentified.push(id);
          this.#ctx.logger.warn(`workspace-purge: Session "${id}" no longer holds ${logName} in ${dir}; that directory was left alone`);
          continue;
        }
        report.purged.push(id);
        if (this.#config.notifyClient) this.#ctx.emit("api-session/removed", id);
      } catch (error) {
        report.failed.push(id);
        this.#ctx.logger.warn(`workspace-purge: cannot delete Session "${id}" at ${dir}: ${String(error)}`);
      }
    }

    this.#log(report, sessionIds.length);
    return report;
  }

  /**
   * Stored log path by Session id, straight from the persistence backend.
   *
   * `listArtifacts` is not part of the service definition, so it is probed
   * rather than assumed: a backend that does not answer it is reported as a
   * failed purge instead of a silently skipped one.
   *
   * @returns a map from Session id to absolute log path.
   */
  async #artifactPaths() {
    const persistence = this.#ctx.sessionPersistence;
    if (typeof persistence?.listArtifacts !== "function") {
      throw new Error("this session-persistence backend does not expose listArtifacts(), so stored Session logs cannot be located");
    }
    const paths = new Map();
    for (const artifact of await persistence.listArtifacts()) {
      paths.set(String(artifact.header.id), String(artifact.path));
    }
    return paths;
  }

  /**
   * Write one summary line for a completed purge.
   *
   * @param report - the outcome buckets.
   * @param total - how many Sessions the Workspace accounted for.
   */
  #log(report, total) {
    const parts = [`${report.purged.length} deleted`];
    if (report.live.length > 0) parts.push(`${report.live.length} kept because they are live`);
    if (report.absent.length > 0) parts.push(`${report.absent.length} had no stored log`);
    if (report.unidentified.length > 0) parts.push(`${report.unidentified.length} left alone because their log was no longer in the directory the backend named`);
    if (report.refused.length > 0) parts.push(`${report.refused.length} refused for an unexpected log path`);
    if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
    const message = `workspace-purge: a deleted workspace accounted for ${total} Session(s): ${parts.join(", ")}`;
    const noisy = report.failed.length > 0 || report.refused.length > 0 || report.unidentified.length > 0;
    if (noisy) this.#ctx.logger.warn(message);
    else this.#ctx.logger.info(message);
  }
}

/**
 * Observe Workspace deletions and purge the Sessions they accounted for.
 *
 * @param ctx - host context carrying the injected services.
 * @param config - validated deployment configuration.
 */
export function apply(ctx, config) {
  const purge = new WorkspacePurge(ctx, config);
  purge.seed(ctx.workspaceRegistry.list());
  ctx.effect(
    function* () {
      yield ctx.on("domain/changed", (change) => purge.observe(change));
    },
    "dsh-plugin-workspace-purge: purge the Sessions of a deleted Workspace"
  );
}
