import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { CodexAdapter } from './adapter.js';
import { CodexLauncher } from './launch.js';
import { CodexProbe } from './status.js';

/**
 * Codex: the official Codex CLI the user has installed and signed in to,
 * driven through `codex app-server` — the CLI's own interface for programs
 * (line-delimited JSON on standard input and output; the CLI prints its schema
 * with `codex app-server generate-json-schema`). The Studio never reads,
 * copies or proxies the CLI's sign-in, and changes nothing in the CLI's home
 * directory: everything it sets, it sets for one process.
 *
 * Where to read on:
 *
 * - `adapter.ts`   a run from start to finish, and how Codex's approval requests reach the permission engine
 * - `launch.ts`    the command line, the environment, and what the process is not shown: the account's own
 *                  Codex settings and instructions, its credentials, and when Codex may run without a sandbox
 * - `translate.ts` Codex's items and notifications → the Studio's events
 * - `client.ts`    the connection; `protocol.ts` the messages; `errors.ts` failures in words
 * - `status.ts`    installed? signed in? which models?
 * - `docs/guides/agent-smoke-test.md` the check against the real CLI
 *
 * ## Event on `internal:usage`
 *
 * For the usage module; browsers never see this topic. Codex reports the state
 * of the account's rate limits while it works, and each report is passed on:
 *
 *   context.bus.onTopic('internal:usage', (event) => { if (event.type === 'rate-limit.observed') … })
 *
 * `rate-limit.observed`
 *
 *   {
 *     agentId: 'codex',
 *     userId: string,        // whose run saw it (the limits themselves belong to the Codex account, which all users share)
 *     observedAt: number,    // milliseconds since the epoch
 *     info: {
 *       limitId: string | null,       // the metered bucket, e.g. "codex"
 *       limitName: string | null,
 *       planType: string | null,      // "plus", "pro", "team", … as Codex names it
 *       primary:   { usedPercent: number, windowMinutes: number | null, resetsAt: number | null } | null,
 *       secondary: { usedPercent: number, windowMinutes: number | null, resetsAt: number | null } | null,
 *       credits:   { hasCredits: boolean, unlimited: boolean, balance: string | null } | null,
 *       reached: string | null        // set when a limit has been hit, e.g. "rate_limit_reached"
 *     }
 *   }
 *
 * `usedPercent` is 0–100. `windowMinutes` is the length of the window (300 is
 * five hours, 10080 a week); `resetsAt` is when it starts again, in
 * milliseconds. A report is sparse: a window Codex did not mention is null,
 * which does not mean it was reset. Reports with nothing in them are not
 * published.
 */
/**
 * Whether an agent working in this project may see the credentials of the
 * account the Studio runs as: the project's `agentCredentials` feature, which
 * only the owner can switch on. A session outside any project never may.
 */
export function agentCredentialsAllowed(context: ModuleContext, projectId: string | null): boolean {
  if (projectId === null) return false;
  const projects = context.services.projects;
  const project = projects.find(projectId);
  return project !== null && projects.isFeatureEnabled(project, 'agentCredentials');
}

export const codexModule: StudioModule = {
  name: 'codex',

  setup(context: ModuleContext) {
    const launcher = new CodexLauncher({ processes: context.processes, sandbox: context.sandbox, allowWithoutSandbox: context.config.codexWithoutSandbox });
    const log = context.log.child({ module: 'codex' });
    const probe = new CodexProbe({ launcher, processes: context.processes, log });
    context.services.agents.registerAdapter(
      new CodexAdapter({
        launcher,
        probe,
        processes: context.processes,
        bus: context.bus,
        log,
        credentialsAllowed: (projectId) => agentCredentialsAllowed(context, projectId),
        // The memory module is set up after this one, so it is looked up when a run starts.
        standingInstructions: () => context.services.memory?.agentGuide() ?? null,
      }),
    );
  },
};
