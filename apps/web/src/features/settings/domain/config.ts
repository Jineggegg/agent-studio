/** Only DNS hostnames can reach the copyable proxy configuration. No URLs, IPs or shell syntax. */
export function domainHostname(input: string): string | null {
  const hostname = input.trim().toLowerCase();
  if (hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) return null;
  const labels = hostname.split('.');
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  const suffix = labels.at(-1)!;
  if (
    !/^[a-z]/.test(suffix) ||
    ['local', 'localhost', 'internal', 'invalid', 'test'].includes(suffix)
  )
    return null;
  return hostname;
}

export function servicePort(input: string): number | null {
  if (!/^\d{1,5}$/.test(input)) return null;
  const port = Number(input);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** Templates are data to copy, never executed or sent to a domain from the app. */
export function domainConfig(domain: string, localPort: string) {
  const hostname = domainHostname(domain);
  const port = servicePort(localPort);
  if (!hostname || port === null) return null;
  const origin = `https://${hostname}`;
  return {
    hostname,
    origin,
    service: `http://127.0.0.1:${port}`,
    environment: `AGENT_STUDIO_HOST=127.0.0.1\nAGENT_STUDIO_PORT=${port}\nAGENT_STUDIO_PUBLIC_ORIGINS=${origin}\nAGENT_STUDIO_TRUST_PROXY=on`,
    caddyfile: `${hostname} {\n    reverse_proxy 127.0.0.1:${port}\n}`,
    healthCheck: `curl --fail --show-error ${origin}/api/health`,
  };
}
