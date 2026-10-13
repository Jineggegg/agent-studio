import { describe, expect, it } from 'vitest';
import { parseCommandLine, runsOtherCommands } from './command-line.js';

const simple = (argv: string[]) => ({ kind: 'simple', argv });

describe('parseCommandLine', () => {
  it.each([
    ['npm test', ['npm', 'test']],
    ['  git   status --short  ', ['git', 'status', '--short']],
    ["grep -n 'two words' src/app.ts", ['grep', '-n', 'two words', 'src/app.ts']],
    ['echo "a b"  c', ['echo', 'a b', 'c']],
    ['echo "say \\"hi\\""', ['echo', 'say "hi"']],
    ['echo "back\\slash \\n stays"', ['echo', 'back\\slash \\n stays']],
    ['echo a\\ b', ['echo', 'a b']],
    ["echo 'it'\\''s'", ['echo', "it's"]],
    ['echo ""', ['echo', '']],
    ["printf '%s\\n' '$HOME' '*' '|' ';' '`x`'", ['printf', '%s\\n', '$HOME', '*', '|', ';', '`x`']],
    ['node --max-old-space-size=512 script.js', ['node', '--max-old-space-size=512', 'script.js']],
    ['./run.sh a~b c#d', ['./run.sh', 'a~b', 'c#d']],
    ['git commit -m "fix: don\'t panic"', ['git', 'commit', '-m', "fix: don't panic"]],
  ])('reads %s as a plain command', (line, argv) => {
    expect(parseCommandLine(line)).toEqual(simple(argv));
  });

  it.each([
    'ls | wc -l',
    'npm test && npm run build',
    'make; make install',
    'echo hi > out.txt',
    'sort < in.txt',
    'echo $HOME',
    'echo "$HOME"',
    'echo "today is `date`"',
    'echo $(whoami)',
    'ls *.ts',
    'ls file?.txt',
    'ls [ab].txt',
    'echo {a,b}',
    'ls ~/projects',
    'sleep 5 &',
    '(cd src && ls)',
    'FOO=bar node app.js',
    'cd src',
    'export A=1',
    'if true; then echo x; fi',
    'echo one\necho two',
    'echo a \\\n b',
    '# just a comment',
    'echo hi # trailing comment',
    '! true',
    'time make',
  ])('says %s needs a shell', (line) => {
    expect(parseCommandLine(line).kind).toBe('shell');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ["echo 'unclosed", 'single quote'],
    ['echo "unclosed', 'double quote'],
    ['echo trailing\\', 'backslash'],
    ['echo a\0b', 'NUL'],
    [`echo ${'x'.repeat(9000)}`, 'longer'],
  ])('refuses %j', (line, reason) => {
    const parsed = parseCommandLine(line);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain(reason);
  });

  it('does not let quotes hide what a shell would still act on', () => {
    // The quotes end before the pipe: it is a pipe.
    expect(parseCommandLine("echo 'a' | cat").kind).toBe('shell');
    // An escaped dollar inside double quotes is a literal dollar.
    expect(parseCommandLine('echo "cost: \\$5"')).toEqual(simple(['echo', 'cost: $5']));
  });
});

describe('runsOtherCommands', () => {
  it.each([['sh', '-c', 'id'], ['/bin/bash', 'script.sh'], ['env', 'A=1', 'node', 'x.js'], ['xargs', 'rm'], ['sudo', 'ls'], ['timeout', '5', 'ls'], ['BusyBox', 'sh']])(
    'recognises %s',
    (...argv) => {
      expect(runsOtherCommands(argv)).toBe(true);
    },
  );

  it.each([['npm', 'test'], ['git', 'status'], ['node', 'x.js'], ['./sh-helper'], ['shellcheck', 'a.sh']])('leaves %s alone', (...argv) => {
    expect(runsOtherCommands(argv)).toBe(false);
  });
});
