import type { MemoryCredentialKind } from '@agent-studio/protocol';

/**
 * Decides whether text looks like it contains a credential.
 *
 * Memory is read by every assistant and may be sent to hosted models, so it
 * must not hold secrets. The check runs in two places: a write through the
 * product is refused when it matches, and a note that matches anyway (a file
 * edited by hand) is never handed to an assistant.
 *
 * The answer names a *kind* of credential and nothing else — the matched
 * value is never returned, logged or echoed.
 *
 * This is deliberately stricter and more careful than the log redactor in
 * `kernel/redact.ts`: that one may over-redact freely, whereas a false alarm
 * here refuses somebody's note. The well-known token formats are the same
 * (a unit test keeps the two in step); the assignment rule is narrower so
 * that ordinary sentences about credentials ("the token is stored in the
 * vault", "max_tokens: 128000", "a password is mandatory") pass.
 */

export interface CredentialFinding {
  readonly kind: MemoryCredentialKind;
}

const KIND_LABELS: Record<MemoryCredentialKind, string> = {
  private_key: 'a private key',
  api_key: 'an API key',
  access_token: 'an access token',
  cloud_key: 'a cloud access key',
  signed_token: 'a signed token',
  bearer_token: 'a bearer token',
  webhook: 'a secret webhook address',
  url_password: 'an address with a password in it',
  password: 'a password',
  secret_value: 'a secret value',
  random_string: 'a long random-looking string',
};

/** A phrase for messages: "a private key", "an API key"… */
export function describeCredentialKind(kind: MemoryCredentialKind): string {
  return KIND_LABELS[kind];
}

const hasDigit = (text: string) => /\d/.test(text);
const hasLetter = (text: string) => /[A-Za-z]/.test(text);
const hasUpper = (text: string) => /[A-Z]/.test(text);
const hasLower = (text: string) => /[a-z]/.test(text);

/** True when some hyphen/underscore-separated part is long and mixes character classes the way generated keys do. */
function hasGeneratedPart(text: string): boolean {
  return text.split(/[-_]/).some((part) => part.length >= 10 && ((hasDigit(part) && hasLetter(part)) || (hasUpper(part) && hasLower(part))));
}

interface Format {
  readonly kind: MemoryCredentialKind;
  readonly pattern: RegExp;
  /** Extra condition on the matched text, to keep ordinary words out. */
  readonly accept?: (match: RegExpExecArray) => boolean;
}

const PLACEHOLDER_PASSWORD = /^(?:pass(?:word|wd)?|pwd|secret|user|username|xxx+|\*+|\.{3,}|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%|changeme|example|redacted|your[-_]?password)$/i;

const FORMATS: readonly Format[] = [
  { kind: 'private_key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  // "sk-…" style keys. Kebab-case words that merely start with "sk-" are not keys.
  { kind: 'api_key', pattern: /(?<![A-Za-z0-9])(?:sk|rk|pk)-([A-Za-z0-9_-]{16,})/g, accept: (match) => hasGeneratedPart(match[1]!) },
  { kind: 'api_key', pattern: /(?<![A-Za-z0-9])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'api_key', pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'access_token', pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'access_token', pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'access_token', pattern: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'access_token', pattern: /(?<![A-Za-z0-9])ast_[A-Za-z0-9_-]{20,}/g },
  { kind: 'access_token', pattern: /(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'access_token', pattern: /(?<![A-Za-z0-9])(?:npm|hf)_[A-Za-z0-9]{30,}/g },
  { kind: 'cloud_key', pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { kind: 'signed_token', pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'webhook', pattern: /hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g },
  { kind: 'webhook', pattern: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'bearer_token',
    pattern: /(?<![A-Za-z0-9])(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/=-]{16,})/gi,
    accept: (match) => hasDigit(match[1]!) && hasLetter(match[1]!),
  },
  {
    kind: 'url_password',
    pattern: /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,64}:([^\s/@]{3,128})@[^\s/@]/g,
    accept: (match) => !PLACEHOLDER_PASSWORD.test(match[1]!),
  },
];

// ---- "password = …" and "the token is …" -------------------------------------

/**
 * Words that name a credential. `pass` words are chosen by people, so their
 * value counts when it has a digit or a symbol; `key` words name generated
 * values, which count when they mix letters and digits.
 */
const NOUN =
  /(pass(?:word|wd|phrase|code)|pwd|密码|口令)|((?:client|app)[_ -]?secret|(?:secret|access|private|api|app|encryption|signing|master|license)[_ -]?key|(?:auth|access|refresh)[_ -]?token|secret|token|authorization|credentials?|密钥|秘钥|令牌)/giu;

/**
 * Last words that turn the name into something that is not the secret itself:
 * `token_limit`, `password_file`, `secretName`, `api-key-id`.
 */
const DESCRIPTORS = new Set(
  (
    'name names id ids file filename path dir url uri endpoint type types length len size limit limits count counts ttl ' +
    'expiry expires expiration lifetime policy rules env var variable field header prefix suffix format hint rotation ' +
    'manager store storage budget usage required enabled strength reset prompt label placeholder input param parameter ' +
    'scope scopes kind source provider status state version bucket window rate price cost counter estimate estimator'
  ).split(' '),
);

/** The last word of the rest of an identifier: `_file` → file, `RotationPolicy` → policy. */
function lastWord(tail: string): string {
  const words = tail
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_-]+/)
    .filter((word) => word.length > 0);
  return (words[words.length - 1] ?? '').toLowerCase();
}

const HAN = /\p{Script=Han}/u;

/** `=`, `:`, `==`, `:=`, `=>` and the words that state a value in a sentence. */
const CONNECTOR = /^[ \t]*(?:={1,3}>?|:(?!:)=?|：|(?:is|was|are|to|equals)(?=[ \t])|是|为|设为|改为|改成|设置为|就是)[ \t]*/iu;

/** A short phrase between the word and "is": "the password for the staging box is …". */
const QUALIFIER = /^[ \t]+(?:for|of|on|to|in)[ \t]+[^\n.:=!?]{1,40}?(?=[ \t]+(?:is|was)[ \t])/i;

const OPENING_QUOTES: Record<string, string> = { '"': '"', "'": "'", '`': '`', '“': '”', '‘': '’', '「': '」', '『': '』' };

const PLACEHOLDER_VALUE =
  /^(?:<.*|\[.*|\{.*|\*+|x{3,}|\.{3,}|…+|-+|_+|#+|none|null|nil|undefined|true|false|yes|no|n\/a|tbd|todo|unset|empty|redacted|removed|hidden|masked|changeme|example|required|optional|your[-_ ].*)$/i;

/** Where a secret lives rather than the secret: paths, addresses, variable references. */
const REFERENCE_VALUE =
  /^(?:~|\.{0,2}\/|[A-Za-z]:\\|[a-z][a-z0-9+.-]*:\/\/|\$|%[A-Za-z_]|@|process\.env|os\.environ|env[.:[(]|secrets?[.:/[]|vault[.:/]|op:\/\/|keychain|keyring)/i;

const NUMBER_VALUE = /^[-+]?\d[\d.,_:/-]*[A-Za-z%]{0,3}$/;

const ALGORITHM_VALUE =
  /^(?:(?:rsa|dsa|ecdsa|eddsa|ecdh|secp|curve|aes|des|3des|chacha|xchacha|sha|md|blake|hmac|hs|rs|es|ps|argon|bcrypt|scrypt|pbkdf|base|utf|oauth|totp|hotp|tls|ssl|pkcs|fido|ripemd|poly|salsa|keccak|sm|gost)[-_]?\d[A-Za-z0-9._-]{0,20}|x25519|x448|x509|ed25519|ed448|p-?256|p-?384|p-?521)$/i;

/** One or more ordinary words: letters only, joined by spaces, hyphens, dots, underscores, slashes or apostrophes. */
const WORDS_VALUE = /^\p{L}+(?:[-_.'/ ]\p{L}+)*$/u;

/** An identifier followed by "(" — a call in a code sample, not a literal. */
const CALL_VALUE = /^[A-Za-z_$][\w$.]*\(/;

function valueIsSecret(raw: string, nounIsPassword: boolean): boolean {
  const value = raw.trim().replace(/[.,;:!?)\]}>，。；、）】》]+$/u, '');
  if (value.length < (nounIsPassword ? 6 : 8)) return false;
  if (PLACEHOLDER_VALUE.test(value) || REFERENCE_VALUE.test(value)) return false;
  if (NUMBER_VALUE.test(value) || ALGORITHM_VALUE.test(value)) return false;
  if (HAN.test(value) || WORDS_VALUE.test(value) || CALL_VALUE.test(value)) return false;
  if (nounIsPassword) return hasDigit(value) || /[^\p{L}\p{N}\s._-]/u.test(value);
  return hasDigit(value) && hasLetter(value);
}

function findStatedCredential(text: string): MemoryCredentialKind | null {
  NOUN.lastIndex = 0;
  for (let match = NOUN.exec(text); match; match = NOUN.exec(text)) {
    const nounIsPassword = match[1] !== undefined;
    const nounStart = match.index;
    let cursor = nounStart + match[0].length;

    // "tokens", "tokenizer", "passwordless", "secretary": another word.
    const next = text[cursor] ?? '';
    const ascii = /^[A-Za-z]/.test(match[0]);
    if (ascii && /[a-z]/.test(next) && !/[A-Z]$/.test(match[0])) continue;
    if (ascii && /^(?:S|ES)(?![A-Za-z])/.test(text.slice(cursor, cursor + 3))) continue;
    // "keyword", "mytoken" is fine, but a letter right before a short noun such as "pwd" is another word too.
    if (match[0].length <= 3 && /[A-Za-z]/.test(text[nounStart - 1] ?? '')) continue;

    // The rest of the identifier: `_file`, `Hash`, `-id`…
    const tail = /^[A-Za-z0-9_-]{0,40}/.exec(text.slice(cursor, cursor + 40))![0].replace(/-+$/, '');
    if (tail && DESCRIPTORS.has(lastWord(tail))) continue;
    cursor += tail.length;

    // What may close the name before the value starts: the quote of a quoted key (`"password": "…"`), Markdown emphasis (`**Password**: …`).
    cursor += /^[*_`"']{0,3}/.exec(text.slice(cursor, cursor + 3))![0].length;

    let rest = text.slice(cursor, cursor + 320);
    const lineEnd = rest.search(/[\n\r]/);
    if (lineEnd !== -1) rest = rest.slice(0, lineEnd);

    const qualifier = QUALIFIER.exec(rest);
    if (qualifier) rest = rest.slice(qualifier[0].length);
    const connector = CONNECTOR.exec(rest);
    if (!connector) continue;
    // Markdown emphasis that closes after the colon: `**Password:** …`.
    rest = rest.slice(connector[0].length).replace(/^[*_]{1,3}[ \t]*/, '');
    if (rest === '') continue;

    const closing = OPENING_QUOTES[rest[0]!];
    let value: string;
    if (closing !== undefined) {
      const end = rest.indexOf(closing, 1);
      value = rest.slice(1, end === -1 ? Math.min(rest.length, 200) : Math.min(end, 200));
    } else {
      value = /^\S{1,200}/.exec(rest)?.[0] ?? '';
      // Text without word spacing: the value ends where the prose resumes.
      const prose = value.search(/[\p{Script=Han}，。；、！？（）]/u);
      if (prose > 0) value = value.slice(0, prose);
    }
    if (valueIsSecret(value, nounIsPassword)) return nounIsPassword ? 'password' : 'secret_value';
  }
  return null;
}

// ---- long random-looking strings ----------------------------------------------

const RANDOM_RUN = /[A-Za-z0-9_-]{32,}/g;

const characterClass = (code: number): number => (code >= 48 && code <= 57 ? 0 : code >= 65 && code <= 90 ? 1 : 2);

/**
 * Tells generated strings from long identifiers. Both mix upper case, lower
 * case and digits; what differs is their texture. In a generated string the
 * character class (upper, lower, digit) changes at well over half of the
 * positions, vowels are rare and few characters repeat. In an identifier such
 * as `handleUserAuthenticationCallbackV2` the class changes only at word
 * boundaries and vowels make up about four letters in ten.
 *
 * Measured on random 32–64 character keys this misses fewer than 1 in 100,
 * and it passes camel-case identifiers unless they are mostly acronyms and
 * digits. The sample is bounded so a very long run costs no more than a long one.
 */
export function looksGenerated(run: string): boolean {
  const sample = run.replace(/[-_]/g, '').slice(0, 256);
  if (sample.length < 24) return false;
  let changes = 0;
  let letters = 0;
  let vowels = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (index > 0 && characterClass(code) !== characterClass(sample.charCodeAt(index - 1))) changes += 1;
    if (characterClass(code) !== 0) {
      letters += 1;
      if ('aeiouAEIOU'.includes(sample[index]!)) vowels += 1;
    }
  }
  const changeRate = changes / (sample.length - 1);
  if (changeRate >= 0.5) return true;
  if (changeRate >= 0.34 && vowels / Math.max(letters, 1) < 0.3) return true;
  // Hardly any character repeats: an alphabet-like sequence rather than words.
  const head = sample.slice(0, 40);
  return new Set(head).size / head.length >= 0.8;
}

function findRandomString(text: string): boolean {
  RANDOM_RUN.lastIndex = 0;
  for (let match = RANDOM_RUN.exec(text); match; match = RANDOM_RUN.exec(text)) {
    const run = match[0].replace(/^[-_]+|[-_]+$/g, '');
    if (run.length < 32 || !hasUpper(run) || !hasLower(run) || !hasDigit(run)) continue;
    // Words joined by hyphens or underscores ("Release-Notes-2026-Final-…") are not random.
    if (run.split(/[-_]/).every((part) => /^(?:[A-Za-z]*|\d+)$/.test(part))) continue;
    // Published checksums ("sha512-…", "sha256:…") are not secrets. The label may be part of the run or sit just before it.
    if (/^sha(?:1|256|384|512)[-_]/i.test(run) || /sha(?:1|256|384|512)[:=][ \t]?$/i.test(text.slice(Math.max(0, match.index - 8), match.index))) continue;
    if (looksGenerated(run)) return true;
  }
  return false;
}

/**
 * Looks for a credential in `text`. Returns the kind of the first one found,
 * or null. Runs in time proportional to the length of the text.
 */
export function findCredential(text: string): CredentialFinding | null {
  if (text.length === 0) return null;
  for (const format of FORMATS) {
    format.pattern.lastIndex = 0;
    for (let match = format.pattern.exec(text); match; match = format.pattern.exec(text)) {
      if (!format.accept || format.accept(match)) return { kind: format.kind };
    }
  }
  const stated = findStatedCredential(text);
  if (stated) return { kind: stated };
  if (findRandomString(text)) return { kind: 'random_string' };
  return null;
}

/** Checks everything about a note that is stored or shown: title, body, tags and keywords. */
export function findCredentialInNote(note: { title: string; body: string; tags: readonly string[]; keywords: readonly string[] }): CredentialFinding | null {
  return findCredential([note.title, note.tags.join(' '), note.keywords.join(' '), note.body].join('\n'));
}
