/**
 * Best-effort removal of credentials from text that is about to be logged or
 * shown. This is a safety net, not a boundary: secrets should not reach logs
 * in the first place.
 */
const PATTERNS: readonly RegExp[] = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, // API keys in the common "sk-..." shape
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bast_[A-Za-z0-9_-]{20,}\b/g, // this service's own API tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(["']?)([^\s"']{6,})\3/gi;

export const REDACTED = '[redacted]';

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
  result = result.replace(
    ASSIGNMENT,
    (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}${REDACTED}${quote}`,
  );
  return result;
}

/**
 * What stands in for a stored secret wherever one is described: a fixed
 * marker that says "a value is saved" and nothing else. It never contains any
 * character of the secret, however long the secret is — a read must not
 * return any part of a saved key.
 */
export const SECRET_HINT = '••••';

/** The marker shown for a stored secret. The secret itself is not looked at. */
export function secretHint(_value?: string): string {
  return SECRET_HINT;
}

/** 203.0.113.42 → 203.0.113.x; IPv6 keeps its /48. For logs and records that must not identify a person. */
export function maskAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const value = mapped ? mapped[1]! : address;
  if (value.includes('.')) return value.split('.').slice(0, 3).join('.') + '.x';
  if (value === '::1') return value;
  return value.split(':').slice(0, 3).join(':') + '::/48';
}
