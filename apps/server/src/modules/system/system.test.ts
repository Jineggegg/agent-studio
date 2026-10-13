import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../kernel/config.js';
import { configWarnings } from './system.module.js';

const codes = (env: NodeJS.ProcessEnv, sandbox: { mode: 'bwrap' | 'none'; reason?: string } = { mode: 'bwrap' }) =>
  configWarnings(loadConfig({ AGENT_STUDIO_DATA_DIR: '/nonexistent/studio-data', AGENT_STUDIO_MASTER_KEY: Buffer.alloc(32).toString('base64'), ...env }), sandbox).map(
    (warning) => warning.code,
  );

describe('configWarnings', () => {
  it('is quiet for the default, loopback-only configuration', () => {
    expect(codes({})).toEqual([]);
  });

  it('flags listening beyond loopback without TLS as dangerous', () => {
    expect(codes({ AGENT_STUDIO_HOST: '0.0.0.0' })).toContain('plain-http-exposed');
    expect(codes({ AGENT_STUDIO_HOST: '0.0.0.0', AGENT_STUDIO_TLS_CERT: '/c.pem', AGENT_STUDIO_TLS_KEY: '/k.pem' })).not.toContain('plain-http-exposed');
  });

  it('flags plain-http public origins but not loopback or https ones', () => {
    expect(codes({ AGENT_STUDIO_PUBLIC_ORIGINS: 'http://100.101.102.103:7420' })).toContain('insecure-public-origin');
    expect(codes({ AGENT_STUDIO_PUBLIC_ORIGINS: 'https://studio.example.com,http://localhost:7420' })).not.toContain('insecure-public-origin');
  });

  it('flags trusting a proxy that serves no configured address, a missing sandbox, and a key on disk', () => {
    expect(codes({ AGENT_STUDIO_TRUST_PROXY: 'on' })).toContain('trust-proxy-without-origin');
    expect(codes({}, { mode: 'none', reason: 'bubblewrap is not installed.' })).toContain('sandbox-off');
    expect(codes({ AGENT_STUDIO_MASTER_KEY: undefined })).toContain('master-key-on-disk');
  });
});
