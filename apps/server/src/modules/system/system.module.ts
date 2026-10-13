import { statSync } from 'node:fs';
import type { ConfigWarning, SystemInfo } from '@agent-studio/protocol';
import { isLoopbackHostname, type StudioConfig } from '../../kernel/config.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import type { SandboxStatus } from '../../kernel/process.js';
import { VERSION } from '../../kernel/version.js';

/**
 * Looks at the configuration the way an attacker would and says, in plain
 * words, what the owner might not have intended. Nothing here blocks start-up:
 * settings that are actually invalid are rejected by `loadConfig`.
 */
export function configWarnings(config: StudioConfig, sandbox: SandboxStatus): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const listensBeyondLoopback = !isLoopbackHostname(config.host);

  if (listensBeyondLoopback && !config.tls) {
    warnings.push({
      code: 'plain-http-exposed',
      severity: 'danger',
      message: 'This Studio accepts unencrypted connections from other machines.',
      detail:
        'AGENT_STUDIO_HOST is not a loopback address and no TLS certificate is configured. Bind to 127.0.0.1 and put a tunnel or reverse proxy that terminates TLS in front, or set AGENT_STUDIO_TLS_CERT and AGENT_STUDIO_TLS_KEY.',
    });
  }
  for (const origin of config.publicOrigins) {
    if (origin.startsWith('http://') && !isLoopbackHostname(new URL(origin).hostname)) {
      warnings.push({
        code: 'insecure-public-origin',
        severity: 'warning',
        message: `Sign-ins through ${origin} are not encrypted by the browser.`,
        detail:
          'This origin uses http. Session cookies cannot be marked Secure there and passkeys are unavailable. Acceptable only on a network that encrypts traffic itself (a mesh VPN); otherwise serve it over https.',
      });
    }
  }
  if (config.trustProxy && config.publicOrigins.length === 0) {
    warnings.push({
      code: 'trust-proxy-without-origin',
      severity: 'warning',
      message: 'Proxy headers are trusted, but no public address is configured.',
      detail: 'AGENT_STUDIO_TRUST_PROXY is on while AGENT_STUDIO_PUBLIC_ORIGINS is empty. Turn the former off or list the address the proxy serves.',
    });
  }
  if (sandbox.mode === 'none') {
    warnings.push({
      code: 'sandbox-off',
      severity: 'warning',
      message: 'Agents run without a sandbox, so an approved command could read the Studio\'s own data.',
      detail: `${sandbox.reason ?? 'No sandbox is available.'} On Linux, install bubblewrap and allow unprivileged user namespaces, then leave AGENT_STUDIO_SANDBOX on "auto".`,
    });
  }
  if (!config.masterKey) {
    warnings.push({
      code: 'master-key-on-disk',
      severity: 'info',
      message: 'The key that protects stored credentials lives in the data directory.',
      detail:
        'That is fine for a personal machine. To keep the key apart from the data (and from backups of it), supply it through AGENT_STUDIO_MASTER_KEY from a secret manager.',
    });
  }
  try {
    if (process.platform !== 'win32' && (statSync(config.dataDir).mode & 0o077) !== 0) {
      warnings.push({
        code: 'data-dir-permissions',
        severity: 'danger',
        message: 'Other accounts on this machine can read the Studio\'s data directory.',
        detail: `Run: chmod 700 ${config.dataDir}`,
      });
    }
  } catch {
    /* the directory is created before this runs; nothing to report if it vanished */
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    warnings.push({
      code: 'running-as-root',
      severity: 'danger',
      message: 'This Studio runs as root, so every agent and terminal does too.',
      detail: 'Run the service under a dedicated, unprivileged account.',
    });
  }
  return warnings;
}

/** Liveness for load balancers and tunnels, and a description of the instance for signed-in clients. */
export const systemModule: StudioModule = {
  name: 'system',

  setup(context: ModuleContext) {
    const { http, config, sandbox } = context;
    const startedAt = Date.now();

    // Deliberately says nothing an anonymous visitor could use.
    http.route({
      method: 'GET',
      url: '/api/health',
      access: 'public',
      handler: () => ({ status: 'ok' }),
    });

    http.route({
      method: 'GET',
      url: '/api/system/info',
      access: 'user',
      handler: ({ user }): SystemInfo => ({
        version: VERSION,
        startedAt,
        sandbox: sandbox.status,
        terminalEnabled: config.terminalEnabled,
        ...(user.role === 'owner'
          ? {
              node: process.version,
              platform: process.platform,
              publicOrigins: [...config.publicOrigins],
              workspaceRoots: [...config.workspaceRoots],
              dataDir: config.dataDir,
              warnings: configWarnings(config, sandbox.status),
            }
          : {}),
      }),
    });
  },

  start(context) {
    for (const warning of configWarnings(context.config, context.sandbox.status)) {
      if (warning.severity === 'danger') context.log.warn({ code: warning.code }, `${warning.message} ${warning.detail}`);
    }
  },
};
