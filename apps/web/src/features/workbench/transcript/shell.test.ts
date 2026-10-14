import { describe, expect, it } from 'vitest';
import { shellCommands } from './shell';

describe('which code blocks can be run', () => {
  it('takes a fence tagged as a shell language at its word', () => {
    expect(shellCommands('bash', 'echo hi')).toEqual(['echo hi']);
    expect(shellCommands('sh', 'npm install\nnpm test\n')).toEqual(['npm install', 'npm test']);
    expect(shellCommands('ZSH', 'ls')).toEqual(['ls']);
    for (const language of ['shell', 'console', 'shellsession', 'terminal']) expect(shellCommands(language, 'pwd'), language).toEqual(['pwd']);
  });

  it('never offers another language, or an empty block', () => {
    expect(shellCommands('python', 'print("git status")')).toBeNull();
    expect(shellCommands('json', '{"a": 1}')).toBeNull();
    expect(shellCommands('text', 'git status')).toBeNull();
    expect(shellCommands('bash', '   \n')).toBeNull();
    expect(shellCommands('bash', '# only a comment')).toBeNull();
  });

  it('runs only the lines after a prompt in a transcript of a session', () => {
    expect(shellCommands('console', '$ git status\nOn branch main\nnothing to commit\n$ git log --oneline\nabc1234 first')).toEqual(['git status', 'git log --oneline']);
  });

  it('drops comments and blank lines, and makes one line of a command broken with backslashes', () => {
    expect(shellCommands('bash', '# install\nnpm ci\n\n# build\nnpm run build')).toEqual(['npm ci', 'npm run build']);
    expect(shellCommands('bash', 'docker run \\\n  -p 8080:80 \\\n  nginx')).toEqual(['docker run -p 8080:80 nginx']);
    expect(shellCommands('console', '$ curl -s \\\n> https://example.com \\\n> | jq .\nok')).toEqual(['curl -s https://example.com | jq .']);
  });

  it('offers an untagged block only when it is plainly nothing but commands', () => {
    expect(shellCommands(undefined, 'git status')).toEqual(['git status']);
    expect(shellCommands(undefined, './scripts/build.sh --fast')).toEqual(['./scripts/build.sh --fast']);
    expect(shellCommands(undefined, 'NODE_ENV=test npm test')).toEqual(['NODE_ENV=test npm test']);
    expect(shellCommands(undefined, '# first\nnpm install\nnpm run dev')).toEqual(['npm install', 'npm run dev']);
  });

  it('does not offer an untagged block that mixes commands with output, or that is long', () => {
    expect(shellCommands(undefined, 'git status\nOn branch main')).toBeNull();
    expect(shellCommands(undefined, 'src/\n  app.ts\n  index.ts')).toBeNull();
    expect(shellCommands(undefined, 'const x = 1;')).toBeNull();
    expect(shellCommands(undefined, 'Remember to run the tests.')).toBeNull();
    expect(shellCommands(undefined, Array.from({ length: 9 }, () => 'git status').join('\n'))).toBeNull();
    expect(shellCommands(undefined, Array.from({ length: 8 }, () => 'git status').join('\n'))).toHaveLength(8);
    expect(shellCommands(undefined, '# just a note')).toBeNull();
  });

  it('gives the terminal one line per command, never a line break', () => {
    for (const block of ['a\r\nnpm test\r\n', 'git add .\ngit commit -m "x"']) {
      for (const command of shellCommands('bash', block) ?? []) expect(command).not.toMatch(/[\r\n]/);
    }
  });
});
