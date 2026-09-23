/**
 * Manual verification against the real Cordis runtime.
 *
 * Not part of `node --test`: it needs the harness packages resolvable, so run it
 * from a profile directory that has this plugin installed (or with this
 * package's own `node_modules` links in place):
 *
 *   cd "$DSH_HOME/profiles/web" && node "D:\path\to\dsh-plugin-init\test\lifecycle.manual.mjs"
 *
 * It mounts the plugin through a real `Context.plugin()` fiber, so it proves
 * activation (including the `ctx.effect` lifecycle and disposal) rather than the
 * stub context the unit tests use.
 */

import { Context, Service } from "@deepseek-ai/cordis";

class Commands extends Service {
  constructor(ctx) {
    super(ctx, "commands");
    this.definitions = [];
  }
  register(definition) {
    this.definitions.push(definition);
    return () => {
      this.definitions = this.definitions.filter((item) => item !== definition);
    };
  }
}

const root = new Context();
const commands = new Commands(root);
const mod = await import("dsh-plugin-init");

const fiber = root.plugin(mod, {});
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("registered after plugin():", commands.definitions.map((item) => item.name).join(","));

const definition = commands.definitions[0];
const steered = [];
const agent = {
  session: { header: { cwd: "D:\\Workspace\\OpenSouces\\opencode" } },
  steer: (message) => steered.push(message)
};
const result = definition.handler({ agent, rawInput: "focus on CI", signal: new AbortController().signal });
const text = steered[0].content[0].text;

console.log("result.kind:", result.kind);
console.log("steered messages:", steered.length);
console.log("prompt names the worktree:", text.includes("OpenSouces\\opencode"));
console.log("prompt honors user input:", text.includes("focus on CI"));
console.log("placeholders all resolved:", !text.includes("${path}") && !text.includes("$ARGUMENTS"));

await fiber.dispose();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("registered after dispose:", commands.definitions.length);
