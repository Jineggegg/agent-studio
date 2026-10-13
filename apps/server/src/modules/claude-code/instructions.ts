import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isStudioError } from '../../kernel/errors.js';
import { confine } from '../../kernel/paths.js';

/**
 * The project's own instruction file.
 *
 * Claude Code would load `CLAUDE.md` itself, together with every settings
 * file — and the settings files are exactly what the Studio switches off
 * (`--setting-sources ""`, see the module's header). So the one thing people
 * expect to keep is read here instead, on purpose and narrowly:
 *
 * - only `CLAUDE.md`, only in the root of the project folder — no other name,
 *   no parent or sub-folder, nothing from the CLI's own configuration directory;
 * - through the kernel's path check: a link is followed only when it stays
 *   inside the project; one that leaves it is not read;
 * - a regular file, of valid UTF-8 text, at most 48 KiB — beyond that only the
 *   beginning is used, and the user is told.
 *
 * It is text for the model and nothing more: it cannot allow a tool, change
 * the permission mode or start a program, whatever it says.
 */

export const PROJECT_INSTRUCTIONS_FILE = 'CLAUDE.md';
export const PROJECT_INSTRUCTIONS_BYTES = 48 * 1024;

export type ProjectInstructions =
  /** There is no such file, or it is empty. */
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly text: string; readonly truncated: boolean }
  /** There is something by that name which must not or cannot be used. `reason` completes "…: it …". */
  | { readonly kind: 'unreadable'; readonly reason: string };

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

export async function readProjectInstructions(projectRoot: string, limitBytes = PROJECT_INSTRUCTIONS_BYTES): Promise<ProjectInstructions> {
  let file: string;
  try {
    file = await confine(projectRoot, PROJECT_INSTRUCTIONS_FILE);
  } catch (error) {
    // The path check refuses a link whose target lies outside the project, existing or not.
    if (isStudioError(error)) return { kind: 'unreadable', reason: 'it is a link that leads outside the project folder' };
    if (errorCode(error) === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', reason: 'it could not be opened' };
  }

  let handle: FileHandle;
  try {
    // The path is the real one already. Refusing a link here closes the gap between the check and the
    // open; not blocking keeps a named pipe by that name from holding the turn up.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'unreadable', reason: 'it is a link that leads outside the project folder' };
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'unreadable', reason: 'the Studio is not allowed to read it' };
    return { kind: 'unreadable', reason: 'it could not be opened' };
  }
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'unreadable', reason: 'it is not a regular file' };
    // One byte more than the limit tells a file that fits from one that does not.
    const buffer = Buffer.alloc(limitBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const truncated = filled > limitBytes;
    let end = Math.min(filled, limitBytes);
    // Cut between characters, not inside one.
    if (truncated) while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    const start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(Math.min(start, end), end));
    } catch {
      return { kind: 'unreadable', reason: 'it is not UTF-8 text' };
    }
    if (text.includes('\0')) return { kind: 'unreadable', reason: 'it is not a text file' };
    text = text.replace(/\r\n?/g, '\n').trim();
    return text === '' ? { kind: 'none' } : { kind: 'loaded', text, truncated };
  } catch {
    return { kind: 'unreadable', reason: 'it could not be read' };
  } finally {
    await handle.close().catch(() => {});
  }
}
