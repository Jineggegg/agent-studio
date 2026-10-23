import { constants } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { badRequest, forbidden, payloadTooLarge } from '../../kernel/errors.js';
import { confine, openInside, withDirectoryInside } from '../../kernel/paths.js';
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
export interface AppArtifact {
  path: string;
  mime: string;
  bytes: Buffer;
}
/** Snapshot through checked descriptors. Later project mutations cannot alter a published preview. */
export async function collectArtifacts(
  root: string,
  output: string,
  excluded: readonly string[],
): Promise<AppArtifact[]> {
  const start = await confine(root, output),
    artifacts: AppArtifact[] = [];
  let total = 0,
    visited = 0;
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > 12) throw payloadTooLarge('App output is nested too deeply.');
    const entries = await withDirectoryInside(
      root,
      dir,
      (p) => readdir(p, { withFileTypes: true }),
      { excluded },
    );
    for (const entry of entries) {
      visited += 1;
      if (visited > 1000) throw payloadTooLarge('App output contains too many files.');
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink())
        throw forbidden('Symbolic links cannot be published.', 'app_output_symlink');
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9._@ -]*$/.test(entry.name))
        throw badRequest('App asset names must be portable file names.');
      const child = await confine(root, path.relative(root, path.join(dir, entry.name))),
        name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(child, name, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw forbidden('Only regular files can be published.');
      const mime = TYPES[path.extname(entry.name).toLowerCase()];
      if (!mime) continue;
      const handle = await openInside(root, child, constants.O_RDONLY, { excluded });
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
          throw payloadTooLarge('An app asset exceeds 5 MB.');
        total += stat.size;
        if (total > 20 * 1024 * 1024 || artifacts.length >= 500)
          throw payloadTooLarge('App output exceeds 20 MB or 500 assets.');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of handle.createReadStream({ autoClose: false })) {
          const chunk = Buffer.from(value as Uint8Array);
          size += chunk.length;
          if (size > 5 * 1024 * 1024 || total - stat.size + size > 20 * 1024 * 1024)
            throw payloadTooLarge('An app asset grew beyond the publication limit.');
          chunks.push(chunk);
        }
        total += size - stat.size;
        artifacts.push({ path: name, mime, bytes: Buffer.concat(chunks) });
      } finally {
        await handle.close();
      }
    }
  };
  await walk(start, '', 0);
  if (!artifacts.some((a) => a.path === 'index.html'))
    throw badRequest(
      'The output directory must contain index.html.',
      undefined,
      'app_index_required',
    );
  return artifacts;
}
