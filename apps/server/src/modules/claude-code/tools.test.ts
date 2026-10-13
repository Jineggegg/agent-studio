import { describe, expect, it } from 'vitest';
import { describeTool, diffsFromResult, parseMcpToolName, shownPath, toolResultText } from './tools.js';

const CWD = '/work/demo';

describe('describing the CLI\'s tools', () => {
  it('names reads and searches, with the files they touch', () => {
    expect(describeTool('Read', { file_path: '/work/demo/src/app.ts' }, CWD)).toEqual({ kind: 'read', title: 'Read src/app.ts', paths: ['/work/demo/src/app.ts'] });
    expect(describeTool('Read', { file_path: '/etc/passwd' }, CWD)).toEqual({ kind: 'read', title: 'Read /etc/passwd', paths: ['/etc/passwd'] });
    expect(describeTool('LS', { path: '/work/demo' }, CWD)).toEqual({ kind: 'read', title: 'List .', paths: ['/work/demo'] });
    expect(describeTool('Grep', { pattern: 'TODO', path: '/work/demo/src' }, CWD)).toEqual({ kind: 'search', title: 'Search for "TODO"', paths: ['/work/demo/src'] });
    // A search without a path looks in the project.
    expect(describeTool('Glob', { pattern: '**/*.ts' }, CWD)).toEqual({ kind: 'search', title: 'Find files matching **/*.ts', paths: [CWD] });
  });

  it('gives edits a preview of the change', () => {
    expect(describeTool('Write', { file_path: '/work/demo/a.txt', content: 'one\ntwo\n' }, CWD)).toEqual({
      kind: 'edit',
      title: 'Write a.txt',
      paths: ['/work/demo/a.txt'],
      diff: '--- a/a.txt\n+++ b/a.txt\n@@\n+one\n+two',
    });
    expect(describeTool('Edit', { file_path: '/work/demo/a.txt', old_string: 'one', new_string: 'uno\ndos' }, CWD).diff).toBe('--- a/a.txt\n+++ b/a.txt\n@@\n-one\n+uno\n+dos');
    const multi = describeTool('MultiEdit', { file_path: '/work/demo/a.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }, 'junk'] }, CWD);
    expect(multi).toMatchObject({ kind: 'edit', title: 'Edit a.txt', diff: '--- a/a.txt\n+++ b/a.txt\n@@\n-a\n-c\n+b\n+d' });
    expect(describeTool('NotebookEdit', { notebook_path: '/work/demo/n.ipynb', new_source: 'print(1)' }, CWD)).toMatchObject({ kind: 'edit', title: 'Edit n.ipynb', paths: ['/work/demo/n.ipynb'] });
    // A huge file does not make a huge approval.
    expect(describeTool('Write', { file_path: '/work/demo/big.txt', content: 'x\n'.repeat(100_000) }, CWD).diff!.length).toBeLessThanOrEqual(20_000);
    expect(describeTool('Edit', {}, CWD)).toEqual({ kind: 'edit', title: 'Edit a file' });
  });

  it('hands the engine the exact command line and the address', () => {
    expect(describeTool('Bash', { command: 'npm test -- --watch=false', description: 'Run the tests' }, CWD)).toEqual({ kind: 'execute', title: 'Run npm test -- --watch=false', command: 'npm test -- --watch=false' });
    const long = describeTool('Bash', { command: `echo start\n${'x'.repeat(5000)}` }, CWD);
    expect(long.title).toBe('Run echo start');
    expect(long.command).toHaveLength(11 + 5000);
    expect(describeTool('Bash', {}, CWD)).toEqual({ kind: 'execute', title: 'Run a command' });
    expect(describeTool('WebFetch', { url: 'https://example.test/page', prompt: 'summarise' }, CWD)).toEqual({ kind: 'fetch', title: 'Fetch https://example.test/page', url: 'https://example.test/page' });
    expect(describeTool('WebSearch', { query: 'vitest 5' }, CWD)).toEqual({ kind: 'fetch', title: 'Search the web for "vitest 5"' });
  });

  it('knows sub-agents, the to-do tools, questions, plans and MCP tools', () => {
    expect(describeTool('Agent', { description: 'Find the bug', prompt: '…' }, CWD)).toEqual({ kind: 'agent', title: 'Sub-agent: Find the bug' });
    expect(describeTool('Task', {}, CWD)).toEqual({ kind: 'agent', title: 'Start a sub-agent' });
    expect(describeTool('TaskCreate', { subject: 'Write tests' }, CWD)).toEqual({ kind: 'other', title: 'Add to-do: Write tests' });
    expect(describeTool('TaskUpdate', { taskId: '3', status: 'in_progress' }, CWD)).toEqual({ kind: 'other', title: 'Update to-do #3 → in progress' });
    expect(describeTool('TodoWrite', { todos: [] }, CWD)).toEqual({ kind: 'other', title: 'Update the to-do list' });
    expect(describeTool('AskUserQuestion', { questions: [{ question: 'Red or blue?' }] }, CWD)).toEqual({ kind: 'other', title: 'Ask: Red or blue?' });
    expect(describeTool('ExitPlanMode', { plan: '1. …' }, CWD)).toEqual({ kind: 'other', title: 'Present the plan' });
    expect(describeTool('mcp__studio__memory_search', { query: 'deploy' }, CWD)).toEqual({ kind: 'other', title: 'memory search (studio)' });
  });

  it('treats a tool it has never heard of as unknown — or as a command, when it carries one', () => {
    expect(describeTool('Teleport', { destination: 'mars' }, CWD)).toEqual({ kind: 'other', title: 'Teleport' });
    expect(describeTool('PowerShellCore', { command: 'Remove-Item x' }, CWD)).toEqual({ kind: 'execute', title: 'PowerShellCore: Remove-Item x', command: 'Remove-Item x' });
    expect(describeTool('Mystery', 'not an object', CWD)).toEqual({ kind: 'other', title: 'Mystery' });
    expect(describeTool('Mystery', { file_path: '/work/demo/x' }, null)).toEqual({ kind: 'other', title: 'Mystery', paths: ['/work/demo/x'] });
  });
});

describe('helpers', () => {
  it('shows a path relative to the project only when it is inside it', () => {
    expect(shownPath('/work/demo/src/a.ts', CWD)).toBe('src/a.ts');
    expect(shownPath('/work/demo', CWD)).toBe('.');
    expect(shownPath('/work/demo-other/a.ts', CWD)).toBe('/work/demo-other/a.ts');
    expect(shownPath('/work/a.ts', CWD)).toBe('/work/a.ts');
    expect(shownPath('relative/a.ts', CWD)).toBe('relative/a.ts');
    expect(shownPath('/work/demo/a.ts', null)).toBe('/work/demo/a.ts');
  });

  it('splits MCP tool names', () => {
    expect(parseMcpToolName('mcp__studio__memory_search')).toEqual({ server: 'studio', tool: 'memory_search' });
    expect(parseMcpToolName('mcp__my_server__do__thing')).toEqual({ server: 'my_server', tool: 'do__thing' });
    for (const name of ['Bash', 'mcp__', 'mcp__studio', 'mcp__studio__', 'mcp____tool']) expect(parseMcpToolName(name), name).toBeNull();
  });

  it('reads the text of a tool result in either form', () => {
    expect(toolResultText('plain')).toBe('plain');
    expect(toolResultText([{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'tool_reference', tool_name: 'Edit' }, { type: 'resource' }, 'bare', 7, null])).toBe('one\n[image]\n[tool: Edit]\n[resource]\nbare');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText({ text: 'object' })).toBe('');
  });

  it('builds diffs only from what the result really carries', () => {
    expect(diffsFromResult({ type: 'create', filePath: '/work/demo/n.txt', content: 'a\nb\n', structuredPatch: [], originalFile: null }, CWD)).toEqual([
      { path: 'n.txt', added: 2, removed: 0, patch: '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n' },
    ]);
    expect(diffsFromResult({ type: 'create', filePath: '/work/demo/empty.txt', content: '', structuredPatch: [] }, CWD)).toEqual([{ path: 'empty.txt', added: 0, removed: 0 }]);
    expect(
      diffsFromResult({ filePath: '/elsewhere/x.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more', '\\ No newline at end of file'] }, { oldStart: 'x' }, null] }, CWD),
    ).toEqual([{ path: '/elsewhere/x.ts', added: 2, removed: 1, patch: '--- a/elsewhere/x.ts\n+++ b/elsewhere/x.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+more\n\\ No newline at end of file\n' }]);
    // An update without hunks changed nothing; no structured result means nothing is invented.
    expect(diffsFromResult({ type: 'update', filePath: '/work/demo/n.txt', content: 'a', structuredPatch: [] }, CWD)).toEqual([]);
    expect(diffsFromResult('Error: refused', CWD)).toEqual([]);
    expect(diffsFromResult({ stdout: 'x' }, CWD)).toEqual([]);
    expect(diffsFromResult(undefined, CWD)).toEqual([]);
    // A patch too large to be worth storing keeps its counts.
    const lines = Array.from({ length: 30_000 }, (_unused, index) => `+line ${index}`);
    expect(diffsFromResult({ filePath: '/work/demo/big.txt', structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 30_000, lines }] }, CWD)).toEqual([{ path: 'big.txt', added: 30_000, removed: 0 }]);
  });
});
