import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Config, apply, inject, name, renderPrompt } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packaged = readFileSync(join(here, "..", "lib", "template", "initialize.txt"), "utf8");

test("module exports the cordis plugin shape", () => {
  assert.equal(name, "init");
  assert.deepEqual(inject, ["commands"]);
  assert.equal(typeof apply, "function");
  assert.equal(typeof Config, "function");
});

test("the packaged template carries both placeholders", () => {
  assert.match(packaged, /\$\{path\}/u);
  assert.match(packaged, /\$ARGUMENTS/u);
  assert.doesNotMatch(packaged, /\$\d/u, "opencode numbered placeholders are not part of this template");
});

test("renderPrompt substitutes the worktree path", () => {
  const rendered = renderPrompt("Write AGENTS.md for ${path}.", "D:\\repo", "");
  assert.equal(rendered, "Write AGENTS.md for D:\\repo.");
});

test("renderPrompt substitutes user input for $ARGUMENTS", () => {
  const rendered = renderPrompt("Focus:\n$ARGUMENTS\n", "/repo", "only the CI setup");
  assert.equal(rendered, "Focus:\nonly the CI setup");
});

test("renderPrompt keeps an empty $ARGUMENTS line from growing the prompt", () => {
  assert.equal(renderPrompt("a\n$ARGUMENTS\nb", "/repo", ""), "a\n\nb");
});

test("renderPrompt appends input when the template never mentions $ARGUMENTS", () => {
  assert.equal(renderPrompt("Do the thing.", "/repo", "and be brief"), "Do the thing.\n\nand be brief");
  assert.equal(renderPrompt("Do the thing.", "/repo", "   "), "Do the thing.");
});

test("renderPrompt substitutes every occurrence, matching opencode", () => {
  assert.equal(renderPrompt("$ARGUMENTS and again $ARGUMENTS", "/repo", "x"), "x and again x");
});
