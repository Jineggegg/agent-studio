/**
 * Links in what an agent wrote. A web address opens in a new tab, as
 * everywhere. Anything else an agent links to is a file of the project —
 * `src/app.ts`, `./docs/plan.md#L12`, `server/main.go:40` — and following it
 * as a web address would lead nowhere, so it is read as a file reference.
 */
export interface FileReference {
  path: string;
  line?: number;
}

/** The file a relative link points at, or null when it is not one (a heading on the same page, an address). */
export function parseFileReference(href: string): FileReference | null {
  let target = href.trim();
  if (target === '' || target.startsWith('#') || target.startsWith('?')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) || target.startsWith('//')) return null;

  let line: number | undefined;
  // "#L12", "#L12-L20", "#12"
  const hash = target.indexOf('#');
  if (hash !== -1) {
    const match = /^#L?(\d+)/.exec(target.slice(hash));
    if (match) line = Number(match[1]);
    target = target.slice(0, hash);
  }
  const query = target.indexOf('?');
  if (query !== -1) target = target.slice(0, query);
  // "file.ts:12" and "file.ts:12:5"
  const suffix = /:(\d+)(?::\d+)?$/.exec(target);
  if (suffix) {
    line ??= Number(suffix[1]);
    target = target.slice(0, suffix.index);
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    /* not percent-encoded after all: use it as written */
  }
  target = target.replace(/^\.\//, '');
  if (target === '' || target.length > 1024 || target.includes('\0')) return null;
  return line !== undefined && Number.isSafeInteger(line) && line > 0 ? { path: target, line } : { path: target };
}
