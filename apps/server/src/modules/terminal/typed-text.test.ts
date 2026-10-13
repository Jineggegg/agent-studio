import { describe, expect, it } from 'vitest';
import { sanitizeTypedText } from './typed-text.js';

const char = (code: number) => String.fromCodePoint(code);
const ESC = char(0x1b);

describe('text typed on the user\'s behalf', () => {
  it('passes an ordinary command through untouched', () => {
    expect(sanitizeTypedText('npm run dev -- --port 5173')).toEqual({ text: 'npm run dev -- --port 5173', removed: 0, multiline: false });
    expect(sanitizeTypedText('echo "héllo 世界 🙂" | wc -c')).toEqual({ text: 'echo "héllo 世界 🙂" | wc -c', removed: 0, multiline: false });
    expect(sanitizeTypedText('ls\t-la')).toEqual({ text: 'ls\t-la', removed: 0, multiline: false });
  });

  it('never presses Enter: line breaks at the end are dropped', () => {
    expect(sanitizeTypedText('make test\n')).toEqual({ text: 'make test', removed: 1, multiline: false });
    expect(sanitizeTypedText('make test\r\n\r\n')).toEqual({ text: 'make test', removed: 4, multiline: false });
    expect(sanitizeTypedText(`make test${char(0x2028)}`)).toEqual({ text: 'make test', removed: 1, multiline: false });
    expect(sanitizeTypedText('\n\n')).toEqual({ text: '', removed: 2, multiline: false });
  });

  it.each([
    ['a line feed', 'cd /tmp\nrm -rf *'],
    ['a carriage return', 'cd /tmp\rrm -rf *'],
    ['both', 'one\r\ntwo\n'],
    ['a next-line character', `one${char(0x85)}two`],
    ['a line separator', `one${char(0x2028)}two`],
    ['a paragraph separator', `one${char(0x2029)}two`],
  ])('marks text with %s inside as multi-line', (_what, input) => {
    const result = sanitizeTypedText(input);
    expect(result.multiline).toBe(true);
    // Whatever a caller does with it, no line break survives.
    expect(result.text).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['escape', ESC, 'the start of every escape sequence'],
    ['an escape sequence', `${ESC}[2J`, 'clear screen'],
    ['a bracketed-paste end marker', `${ESC}[201~`, 'would end a paste early'],
    ['Ctrl+C', char(0x03), 'interrupt'],
    ['Ctrl+D', char(0x04), 'end of input'],
    ['Ctrl+Z', char(0x1a), 'suspend'],
    ['Ctrl+U', char(0x15), 'kill line'],
    ['NUL', char(0x00), ''],
    ['bell', char(0x07), ''],
    ['backspace', char(0x08), 'would erase what the user sees'],
    ['delete', char(0x7f), ''],
    ['vertical tab', char(0x0b), ''],
    ['form feed', char(0x0c), ''],
    ['a one-byte CSI', char(0x9b), 'C1 control'],
    ['a one-byte OSC', char(0x9d), 'C1 control'],
    ['a right-to-left override', char(0x202e), 'reorders what is displayed'],
    ['a left-to-right isolate', char(0x2066), ''],
    ['a pop directional isolate', char(0x2069), ''],
    ['a right-to-left mark', char(0x200f), ''],
    ['an Arabic letter mark', char(0x061c), ''],
    ['a byte-order mark', char(0xfeff), ''],
  ])('removes %s', (_what, hostile) => {
    const result = sanitizeTypedText(`echo a${hostile}b`);
    expect(result.multiline).toBe(false);
    // Only the control character itself goes; what followed it is now plain, visible text.
    const visible = hostile.startsWith(ESC) ? hostile.slice(1) : '';
    expect(result.text).toBe(`echo a${visible}b`);
    expect(result.removed).toBe(hostile.length - visible.length);
    // What is left is the visible text, with nothing a terminal would act on.
    for (const unit of result.text) {
      const code = unit.codePointAt(0)!;
      expect(code === 0x09 || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))).toBe(true);
    }
    expect(result.text.startsWith('echo a')).toBe(true);
    expect(result.text.endsWith('b')).toBe(true);
    expect(result.text).not.toContain(ESC);
  });

  it('leaves no control character in any input', () => {
    let all = '';
    for (let code = 0; code <= 0x9f; code += 1) all += char(code);
    const result = sanitizeTypedText(`start${all}end`);
    const printable = Array.from({ length: 0x7f - 0x20 }, (_unused, index) => char(0x20 + index)).join('');
    expect(result.text).toBe(`start\t${printable}end`);
    expect(Buffer.from(result.text, 'utf8').some((byte) => byte < 0x20 && byte !== 0x09)).toBe(false);
  });

  it('drops half of a surrogate pair instead of sending a replacement character', () => {
    const lone = String.fromCharCode(0xd83d);
    expect(sanitizeTypedText(`a${lone}b`)).toEqual({ text: 'ab', removed: 1, multiline: false });
    expect(sanitizeTypedText('a🙂b').text).toBe('a🙂b');
  });
});
