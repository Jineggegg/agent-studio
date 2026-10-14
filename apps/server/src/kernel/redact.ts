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
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab tokens
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
  // https://user:password@host — the password part of a URL.
  result = result.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`);
  // ?key=… and similar query parameters that carry a credential.
  result = result.replace(/([?&](?:key|sig|signature|code|auth)=)[^&\s#"']+/gi, `$1${REDACTED}`);
  result = result.replace(
    ASSIGNMENT,
    (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}${REDACTED}${quote}`,
  );
  return result;
}

const LOG_ERROR_KEYS = new Set(['err', 'error', 'cause', 'reason', 'detail', 'details', 'stderr', 'stdout', 'output']);
const MAX_DEPTH = 4;

/**
 * Applied to every object handed to the server log, whatever the call site
 * did: top-level strings and anything under an error-like key are passed
 * through {@link redactSecrets}. Errors become `{ type, message, stack }`
 * with both message and stack redacted — a stack starts with the message, so
 * redacting only the message is not enough. Other values (request and reply
 * objects in particular) are left to their serializers untouched.
 */
export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  let result: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(fields)) {
    const redacted =
      typeof value === 'string' ? redactSecrets(value) : LOG_ERROR_KEYS.has(key) ? redactDeep(value, 0, new WeakSet()) : value;
    if (redacted !== value) {
      result ??= { ...fields };
      result[key] = redacted;
    }
  }
  return result ?? fields;
}

function redactDeep(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[nested]';
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = { type: value.name, message: redactSecrets(value.message) };
    if (value.stack) out.stack = redactSecrets(value.stack);
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out.code = code;
    if (value.cause !== undefined) out.cause = redactDeep(value.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, depth + 1, seen);
  return out;
}

/** An error as text for a terminal or a crash report: the stack when there is one, redacted. */
export function redactedErrorText(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.stack ?? `${error.name}: ${error.message}`);
  return redactSecrets(typeof error === 'string' ? error : String(error));
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
