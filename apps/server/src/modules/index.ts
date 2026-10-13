import type { StudioModule } from '../kernel/module.js';
import { agentsModule } from './agents/agents.module.js';
import { auditModule } from './audit/audit.module.js';
import { authModule } from './auth/auth.module.js';
import { automationModule } from './automation/automation.module.js';
import { claudeCodeModule } from './claude-code/claude-code.module.js';
import { codexModule } from './codex/codex.module.js';
import { filesModule } from './files/files.module.js';
import { gitModule } from './git/git.module.js';
import { githubModule } from './github/github.module.js';
import { homeModule } from './home/home.module.js';
import { inboxModule } from './inbox/inbox.module.js';
import { memoryModule } from './memory/memory.module.js';
import { pluginsModule } from './plugins/plugins.module.js';
import { preferencesModule } from './preferences/preferences.module.js';
import { projectsModule } from './projects/projects.module.js';
import { providersModule } from './providers/providers.module.js';
import { remotesModule } from './remotes/remotes.module.js';
import { systemModule } from './system/system.module.js';
import { terminalModule } from './terminal/terminal.module.js';
import { usageModule } from './usage/usage.module.js';

/**
 * Every module of the server, in set-up order. A module may rely on the
 * services of the modules listed before it during `setup`, and on any service
 * from `start` onwards.
 */
export const modules: readonly StudioModule[] = [
  // foundation
  auditModule,
  authModule,
  systemModule,
  preferencesModule,
  projectsModule,
  // agent runtime, then the adapters that plug into it
  agentsModule,
  claudeCodeModule,
  codexModule,
  providersModule,
  // project tools
  filesModule,
  gitModule,
  githubModule,
  terminalModule,
  remotesModule,
  // knowledge, notifications, automation
  memoryModule,
  inboxModule,
  automationModule,
  usageModule,
  // extensions and the launcher
  pluginsModule,
  homeModule,
];
