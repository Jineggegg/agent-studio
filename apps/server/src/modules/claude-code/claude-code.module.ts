import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from './adapter.js';

/**
 * Claude Code, driven through the official `claude` command-line program the
 * person running this Studio has installed and signed in to (ADR 0005).
 *
 * - `cli.ts`         finding the program; its version, options and sign-in status
 * - `invocation.ts`  the command line of a turn and the messages written to it
 * - `run.ts`         one turn: the process, steering, stopping, resuming
 * - `translate.ts`   the CLI's JSON lines → the runtime's normalised events
 * - `tools.ts`       what each of the CLI's tools does, for titles and the permission engine
 * - `errors.ts`      failures a person can act on
 * - `adapter.ts`     the `AgentAdapter` that ties them together
 *
 * The Studio never reads, copies or proxies the CLI's credentials and never
 * changes its configuration files: everything is set per invocation, on the
 * command line. `claude auth status --json` is the only thing it asks about
 * the sign-in, and signing in is the terminal launcher `claude-login`.
 *
 * ## Whose settings apply inside the Studio
 *
 * Every turn runs with `--setting-sources ""` and `--strict-mcp-config`: the
 * CLI loads neither `~/.claude/settings.json`, nor a project's
 * `.claude/settings.json` and `.claude/settings.local.json`, nor any MCP
 * server other than the Studio's bridge. (Settings an administrator manages
 * for the whole machine still apply; the CLI offers no way around them, and
 * should not.)
 *
 * The reason is ADR 0004: one permission engine, on the server, decides. A
 * settings file may hold `permissions.allow` rules, a default permission mode
 * and hooks, and the CLI answers a request that such a rule allows by itself,
 * without asking — the Studio would never see it. (Observed with Claude Code
 * 2.1.283: with an allow rule for `Write` loaded, a file was written and the
 * permission prompt tool was not called; with no settings loaded the same
 * request arrived at the prompt tool. A project's file is the worse case: it
 * comes with a cloned repository, and in non-interactive mode the CLI skips
 * its workspace-trust question.) The same goes for MCP servers: those of the
 * account that runs the service would be started for every member's run.
 *
 * What this costs: `CLAUDE.md` files are not loaded (verified: an instruction
 * in one was followed with the project's settings source on and ignored with
 * none), and with the settings files go the hooks, plugins and MCP servers
 * configured in them. Rules belong in the Studio's permission rules; standing
 * knowledge in shared memory, whose conventions are the one thing appended
 * to the CLI's system prompt.
 *
 * What the CLI still decides alone is what it considers free of side
 * effects. Observed with 2.1.283: reading files in a folder named with
 * `--add-dir` (reads inside the project are documented to be treated the
 * same), a shell command it classifies as read-only (`pwd`), its tool lookup
 * and to-do tools, and writing the plan file it keeps under its own
 * configuration directory while in plan mode. Everything else that was tried
 * — file writes, another shell command (`mkdir`, also from inside a
 * sub-agent), the question tool and the plan tool — arrived at the permission
 * prompt tool, and so at the engine.
 *
 * ## Event on the bus: `internal:usage` / `rate-limit.observed`
 *
 * Published whenever the CLI reports the state of the account's usage limits
 * (observed: once per process, after its first model request — so once per
 * turn). Server-side only; browsers never see `internal:` topics. Payload
 * ({@link RateLimitObserved}):
 *
 * ```
 * { agentId: 'claude-code',
 *   userId,        // whose run observed it — the limits themselves belong to the
 *                  // account the CLI is signed in to, shared by everyone here
 *   observedAt,    // milliseconds since the epoch
 *   info }         // the CLI's `rate_limit_info`, unchanged
 * ```
 *
 * `info` as printed by Claude Code 2.1.283 (treat every field as optional;
 * times are **seconds** since the epoch, utilisation is a fraction 0–1):
 *
 * ```
 * { status: 'allowed' | 'allowed_warning' | 'rejected',
 *   rateLimitType: 'five_hour' | 'seven_day' | …,   // the window that decided `status`
 *   resetsAt,
 *   overageStatus, overageDisabledReason, isUsingOverage,
 *   unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: { utilization, resetsAt } } }
 * ```
 */

export function createClaudeCodeModule(options: ClaudeCodeOptions = {}): StudioModule {
  // One module object may serve several Studios in one process (tests do this).
  const adapters = new WeakMap<ModuleContext, ClaudeCodeAdapter>();
  return {
    name: 'claude-code',

    setup(context) {
      const adapter = new ClaudeCodeAdapter(context, options);
      adapters.set(context, adapter);
      context.services.agents.registerAdapter(adapter);
    },

    start(context) {
      // Asking the CLI whether it is signed in takes seconds: have the answer ready for the first screen.
      // (Not under test: a test Studio is started and thrown away many times a minute, and each would
      // otherwise start whatever `claude` the machine has. Tests ask for the status when they want it.)
      if (context.config.env === 'test') return;
      void adapters
        .get(context)
        ?.status()
        .catch(() => {});
    },
  };
}

export const claudeCodeModule: StudioModule = createClaudeCodeModule();

export { ClaudeCodeAdapter, type ClaudeCodeOptions, type RateLimitObserved, CLAUDE_CODE_AGENT_ID, RATE_LIMIT_OBSERVED, USAGE_TOPIC } from './adapter.js';
