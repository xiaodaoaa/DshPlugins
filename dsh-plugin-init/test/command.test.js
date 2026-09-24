import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";

/**
 * Load the plugin against a stub Cordis context and hand back the one command
 * definition it registered plus the disposers the lifecycle effect collected.
 *
 * This exercises the real `apply` and the real handler; only the cordis runtime
 * and the agent are stand-ins. The stub mirrors cordis's `effect()` contract:
 * run the executor, and collect every yielded disposer.
 */
function load(config) {
  const registered = [];
  const disposers = [];
  let label;
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition);
        return () => {};
      }
    },
    effect(execute, effectLabel) {
      label = effectLabel;
      for (const disposer of execute()) disposers.push(disposer);
    }
  };
  apply(ctx, config ?? {});
  assert.equal(registered.length, 1, "apply registers exactly one command");
  return { command: registered[0], disposers, label };
}

/** A stand-in agent capturing what the handler steers into it. */
function fakeAgent(cwd) {
  const steered = [];
  return {
    steered,
    session: { header: cwd === undefined ? {} : { cwd } },
    steer(message) {
      steered.push(message);
    }
  };
}

function textOf(message) {
  return message.content.map((block) => block.text).join("");
}

test("the registered command declares name, description, and an input hint", () => {
  const { command } = load();
  assert.equal(command.name, "init");
  assert.equal(command.description, "Create or update CLAUDE.md for this repository");
  assert.deepEqual(command.input, { hint: "[focus or constraints]" });
  assert.equal(typeof command.handler, "function");
});

test("the lifecycle effect registers a disposer through a generator", () => {
  const { disposers, label } = load();
  assert.equal(disposers.length, 1);
  assert.equal(typeof disposers[0], "function");
  assert.equal(label, "dsh-plugin-init: register /init");
});

test("the handler steers one user message holding the rendered prompt", () => {
  const { command } = load();
  const agent = fakeAgent("D:\\repo");

  const result = command.handler({ agent, rawInput: "focus on CI", signal: new AbortController().signal });

  assert.equal(agent.steered.length, 1);
  const message = agent.steered[0];
  assert.equal(message.role, "user");
  assert.deepEqual(message.source, { kind: "user" });
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, "text");

  const text = textOf(message);
  assert.match(text, /create a CLAUDE\.md file/u);
  assert.match(text, /focus on CI/u);
  assert.doesNotMatch(text, /\$\{path\}/u, "the path placeholder is gone");
  assert.doesNotMatch(text, /\$ARGUMENTS/u, "the arguments placeholder is gone");
  assert.match(text, /If there's already a `CLAUDE\.md` at D:\\repo/u);
  assert.match(text, /If an `AGENTS\.md` already exists at D:\\repo/u);

  assert.equal(result.kind, "success");
  assert.match(result.text, /D:\\repo/u);
});

test("the handler falls back to the process directory when the session has no cwd", () => {
  const { command } = load();
  const agent = fakeAgent(undefined);

  command.handler({ agent, rawInput: "", signal: new AbortController().signal });

  assert.match(textOf(agent.steered[0]), new RegExp(process.cwd().replaceAll("\\", "\\\\"), "u"));
});

test("an aborted invocation steers nothing and settles as an error", () => {
  const { command } = load();
  const agent = fakeAgent("D:\\repo");
  const controller = new AbortController();
  controller.abort();

  const result = command.handler({ agent, rawInput: "", signal: controller.signal });

  assert.deepEqual(agent.steered, []);
  assert.deepEqual(result, { kind: "error", text: "/init cancelled." });
});

test("a configured template replaces the packaged prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-plugin-init-"));
  const templatePath = join(dir, "custom.txt");
  writeFileSync(templatePath, "Custom prompt for ${path}.");

  const { command } = load({ template: templatePath });
  const agent = fakeAgent("/repo");
  command.handler({ agent, rawInput: "", signal: new AbortController().signal });

  assert.equal(textOf(agent.steered[0]), "Custom prompt for /repo.");
});

test("a missing or empty template fails activation, not the first invocation", () => {
  assert.throws(() => load({ template: join(tmpdir(), "definitely-absent-initialize.txt") }), /cannot read prompt template/u);

  const dir = mkdtempSync(join(tmpdir(), "dsh-plugin-init-"));
  const emptyPath = join(dir, "empty.txt");
  writeFileSync(emptyPath, "   \n");
  assert.throws(() => load({ template: emptyPath }), /is empty/u);

  assert.throws(() => load({ template: "   " }), /non-empty path string/u);
});
