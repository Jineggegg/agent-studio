import { describe, expect, it } from 'vitest';
import { domainConfig, domainHostname, servicePort } from './config';

describe('domain setup configuration boundary', () => {
  it('normalises DNS hostnames without interpreting URLs or shell syntax', () => {
    expect(domainHostname(' Harness.Example.com ')).toBe('harness.example.com');
    expect(domainHostname('xn--bcher-kva.example.com')).toBe('xn--bcher-kva.example.com');
  });

  it.each([
    '',
    'localhost',
    'app.localhost',
    'app.local',
    'app.internal',
    'app.test',
    '127.0.0.1',
    '[::1]',
    'https://harness.example.com',
    'harness.example.com:443',
    'harness.example.com/path',
    'harness.example.com?x=1',
    'name@harness.example.com',
    '*.example.com',
    'a..example.com',
    '-a.example.com',
    'a-.example.com',
    'harness.example.com\nreverse_proxy evil.example.com',
    'x.example.com;id',
    '$(id).example.com',
    '`id`.example.com',
    'x.example.com {',
    '工作台.example.com',
    `${'a'.repeat(64)}.example.com`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
  ])('refuses unsafe or unsupported hostname %j before creating any output', (domain) => {
    expect(domainHostname(domain)).toBeNull();
    expect(domainConfig(domain, '7420')).toBeNull();
  });

  it.each(['', '0', '65536', '-1', '1.5', '7420\nX=1', '80;id', '1e3', ' 80'])(
    'refuses invalid local port %j',
    (port) => {
      expect(servicePort(port)).toBeNull();
      expect(domainConfig('harness.example.com', port)).toBeNull();
    },
  );

  it('keeps upstream loopback and the health check on the validated HTTPS address', () => {
    const config = domainConfig('harness.example.com', '8123')!;
    expect(config.service).toBe('http://127.0.0.1:8123');
    expect(config.caddyfile).toBe('harness.example.com {\n    reverse_proxy 127.0.0.1:8123\n}');
    expect(config.environment).toContain('AGENT_STUDIO_HOST=127.0.0.1');
    expect(config.environment).toContain('AGENT_STUDIO_PUBLIC_ORIGINS=https://harness.example.com');
    expect(config.healthCheck).toBe(
      'curl --fail --show-error https://harness.example.com/api/health',
    );
  });
});
