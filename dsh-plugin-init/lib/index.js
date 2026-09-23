/**
 * Human-facing `/init` command: point the agent at this repository and have it
 * write or refresh `AGENTS.md`.
 *
 * Ported from opencode's built-in `/init` command. opencode keeps the command
 * in a registry that also serves `GET /command`, and the TUI executes it as an
 * ordinary command whose template becomes a user message. The equivalent here
 * is `ctx.commands.register()`, which publishes the command to every composed
 * human-command adapter (Web composer included) and runs the handler against
 * the receiving agent.
 *
 * Two pieces of opencode's behavior are reproduced deliberately:
 *
 * - Template substitution. `${path}` becomes the session's working directory
 *   so the prompt can tell the agent where the existing `AGENTS.md` lives, and
 *   `$ARGUMENTS` becomes the user's raw input so `/init focus on CI` steers the
 *   investigation. Both are resolved at invocation time, never at load time.
 * - The command produces model work. `dsh-commands` commands are human-only and
 *   emit no model message, so the handler delivers the rendered prompt through
 *   `agent.steer()`. `steer` targets the next step and wakes an idle agent
 *   (`send(message, 'next-step', true)`), which is what makes `/init` from an
 *   idle session actually start a turn; from a busy session the prompt lands at
 *   the next safe step boundary instead of interrupting.
 *
 * Unlike opencode, no project-level "already initialized" timestamp is written.
 * DSH's `command/run` and `command/done` lifecycle events are already appended
 * to the session log by the registry, which is the durable record of the run.
 *
 * @module dsh-plugin-init
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Cordis plugin name, used in diagnostics and the profile tree. */
export const name = "init";

/** The command registry is the only service this plugin needs. */
export const inject = ["commands"];

const DESCRIPTION = "Create or update AGENTS.md for this repository";

/** The packaged prompt template, resolved next to this module. */
const DEFAULT_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "template", "initialize.txt");

/**
 * Deployment-owned configuration. `template` is optional: omit it to use the
 * packaged prompt, or point it at a file to override the prompt wholesale.
 */
export const Config = Schema.object({
  template: Schema.string().description("Absolute path of a prompt template file that replaces the packaged one")
});

/** Fail at plugin load rather than on the first invocation. */
function readTemplate(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`dsh-plugin-init: cannot read prompt template ${path}`, { cause });
  }
  if (text.trim().length === 0) throw new Error(`dsh-plugin-init: prompt template ${path} is empty`);
  return text;
}

/**
 * Resolve a configured template path against the host process directory.
 * @param configured - the raw `template` config value, when present.
 * @returns the absolute template path.
 */
function resolveTemplatePath(configured) {
  if (configured === void 0) return DEFAULT_TEMPLATE;
  if (typeof configured !== "string" || configured.trim().length === 0) {
    throw new Error("dsh-plugin-init: `template` must be a non-empty path string");
  }
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * Render the prompt for one invocation.
 *
 * `$ARGUMENTS` is replaced globally, matching opencode, so a template may
 * mention the user's input more than once. A template that does not mention it
 * gets the input appended instead of silently dropping it — `/init focus on CI`
 * must never lose the focus.
 *
 * @param template - the loaded prompt template.
 * @param worktree - the session's working directory.
 * @param args - the user's raw input, verbatim.
 * @returns the rendered prompt text.
 */
export function renderPrompt(template, worktree, args) {
  const rendered = template.replaceAll("${path}", worktree).replaceAll("$ARGUMENTS", args).trim();
  if (template.includes("$ARGUMENTS")) return rendered;
  const extra = args.trim();
  return extra.length === 0 ? rendered : `${rendered}\n\n${extra}`;
}

/**
 * The directory the agent should treat as the repository root.
 *
 * A session records its creation `cwd` in its durable header; a session created
 * without one falls back to the host process directory, which is where the
 * harness itself was started.
 *
 * @param agent - the receiving agent.
 * @returns an absolute directory path.
 */
function worktreeOf(agent) {
  const cwd = agent.session.header.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * Register `/init` for every composed human-command adapter.
 * @param ctx - context carrying the command registry.
 * @param config - validated deployment configuration.
 */
export function apply(ctx, config) {
  const template = readTemplate(resolveTemplatePath(config?.template));
  ctx.effect(
    function* () {
      yield ctx.commands.register({
        name: "init",
        description: DESCRIPTION,
        input: { hint: "[focus or constraints]" },
        handler: ({ agent, rawInput, signal }) => {
          if (signal.aborted) return { kind: "error", text: "/init cancelled." };
          const worktree = worktreeOf(agent);
          agent.steer(
            createUserMessage({
              content: [{ type: "text", text: renderPrompt(template, worktree, rawInput) }],
              source: { kind: "user" }
            })
          );
          return {
            kind: "success",
            text: `Investigating ${worktree} — the agent will create or update AGENTS.md.`
          };
        }
      });
    },
    "dsh-plugin-init: register /init"
  );
}
