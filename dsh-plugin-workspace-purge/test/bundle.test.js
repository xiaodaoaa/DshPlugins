import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { name } from "../lib/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Collect the `id:` values a patch file inserts.
 *
 * This is a deliberately narrow reader rather than a YAML parser: the patch
 * files involved are three lines of `insert:` list, and the check exists to
 * catch one specific fatal mistake, not to reimplement the loader.
 */
function insertedIds(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "- insert:");
  if (start === -1) return [];
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+id:\s*'?([^'\s]+)'?\s*$/u.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

test("the bundle patch inserts exactly one entry, named after this plugin", () => {
  const ids = insertedIds(readFileSync(join(root, "cordis.patch.yml"), "utf8"));
  assert.deepEqual(ids, ["workspace-purge"]);
});

test("the package declares the bundle patch the loader resolves", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(manifest.name, "dsh-plugin-workspace-purge");
  assert.equal(name, "workspace-purge", "the patch entry id and the cordis plugin name agree");
});

/**
 * A profile that lists this package in `dsh.profile.bundles` must not insert
 * the same entry id from its own `cordis.patch.yml`: the loader composes both
 * layers into one list and rejects a repeated id with
 * "duplicate loader entry id", which fails the whole profile boot.
 *
 * Skipped when the profile is not present, so the check is useful on the
 * machine that actually has the plugin installed and inert everywhere else.
 */
test("no installed profile inserts the same entry id twice", () => {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
  const profilesDir = join(home, "profiles");
  if (!existsSync(profilesDir)) return;

  const bundleIds = insertedIds(readFileSync(join(root, "cordis.patch.yml"), "utf8"));
  const collisions = [];
  for (const profile of ["web", "tui", "headless", "acp", "sdk"]) {
    const manifestPath = join(profilesDir, profile, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!(manifest.dsh?.profile?.bundles ?? []).includes("dsh-plugin-workspace-purge")) continue;

    const userPatchPath = join(profilesDir, profile, "cordis.patch.yml");
    if (!existsSync(userPatchPath)) continue;
    const shared = insertedIds(readFileSync(userPatchPath, "utf8")).filter((id) => bundleIds.includes(id));
    if (shared.length > 0) collisions.push(`${profile}: ${shared.join(", ")}`);
  }
  assert.deepEqual(collisions, [], `profile patch layer repeats a bundle entry id (${name}): ${collisions.join("; ")}`);
});
