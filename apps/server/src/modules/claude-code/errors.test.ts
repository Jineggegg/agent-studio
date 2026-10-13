import { describe, expect, it } from 'vitest';
import { errorFromExit, errorFromResult, isResumeNotFound, presentable, stderrTail } from './errors.js';
import type { CliResult } from './translate.js';

const result = (fields: Partial<CliResult> = {}): CliResult => ({ subtype: 'success', isError: true, text: '', errors: [], apiErrorStatus: null, terminalReason: 'api_error', ...fields });
const exit = (fields: Partial<Parameters<typeof errorFromExit>[0]> = {}) => ({ code: 1, signal: null, stderr: '', strayLine: null, spawnError: null, ...fields });
const said = (error: { code: string; message: string }) => ({ code: error.code, message: error.message });

describe('a turn that ended with an error result', () => {
  it('recognises what the real CLI printed in each case', () => {
    // Captured: signed out.
    expect(said(errorFromResult(result({ text: 'Not logged in · Please run /login' }), { kind: 'authentication_failed', text: 'Not logged in · Please run /login' }, { model: null }))).toEqual({
      code: 'not_signed_in',
      message: expect.stringContaining('claude-login'),
    });
    // Captured: an unknown model (API status 404).
    const model = errorFromResult(
      result({ text: "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.", apiErrorStatus: 404 }),
      { kind: 'model_not_found', text: "There's an issue with the selected model (no-such-model-xyz)." },
      { model: 'no-such-model-xyz' },
    );
    expect(said(model)).toEqual({ code: 'model_unavailable', message: 'The model "no-such-model-xyz" is not available to this Claude Code account. Choose another model and send the message again.' });
    // The CLI's advice to "run --model" would mislead someone using the Studio: it is not repeated.
    expect(model.message).not.toContain('--model');
  });

  it('tells the other failures apart by the CLI\'s label, the API status, or its sentence', () => {
    const code = (fields: Partial<CliResult>, kind: string | null = null, text = fields.text ?? '') => errorFromResult(result(fields), kind === null && text === '' ? null : { kind, text }, { model: null }).code;
    expect(code({}, 'rate_limit', "You've hit your limit · resets 3pm (UTC)")).toBe('rate_limited');
    expect(code({ text: 'Claude usage limit reached. Your limit will reset at 3pm.' })).toBe('rate_limited');
    expect(code({ apiErrorStatus: 429, text: 'API Error: 429' })).toBe('rate_limited');
    expect(code({}, 'billing_error', 'Credit balance is too low')).toBe('billing');
    expect(code({ apiErrorStatus: 529, text: 'API Error: 529 Overloaded' })).toBe('overloaded');
    expect(code({}, 'server_error', 'API Error: 500')).toBe('overloaded');
    expect(code({ apiErrorStatus: 401, text: 'API Error: 401' })).toBe('not_signed_in');
    expect(code({ text: 'OAuth token has expired. Please run /login' })).toBe('not_signed_in');
    expect(code({ apiErrorStatus: 404, text: 'model: claude-nope' })).toBe('model_unavailable');
    expect(code({ subtype: 'error_max_turns' })).toBe('agent_error');
    expect(code({ subtype: 'error_during_execution', errors: ['Tool crashed'] })).toBe('agent_error');
  });

  it('keeps the CLI\'s sentence where it helps, masked and bounded', () => {
    const limit = errorFromResult(result(), { kind: 'rate_limit', text: "You've hit your limit · resets 3pm (UTC)" }, { model: null });
    expect(limit.message).toBe("Claude's usage limit has been reached — Claude Code says: You've hit your limit · resets 3pm (UTC)");
    const leaked = errorFromResult(result({ subtype: 'error_during_execution', errors: [`request failed: Authorization: Bearer abcdefghijklmnop12345 ${'x'.repeat(2000)}`] }), null, { model: null });
    expect(leaked.message).not.toContain('abcdefghijklmnop12345');
    expect(leaked.message).toContain('[redacted]');
    expect(leaked.message.length).toBeLessThan(700);
    expect(errorFromResult(result({ subtype: 'error_during_execution' }), null, { model: null }).message).toBe('Claude Code reported a problem and gave no detail.');
    expect(errorFromResult(result(), { kind: 'model_not_found', text: '' }, { model: null }).message).toContain('The model chosen for this session is not available');
  });
});

describe('a CLI that ended without a result', () => {
  it('says what a person can do about it', () => {
    expect(said(errorFromExit(exit({ spawnError: 'spawn claude ENOENT' })))).toEqual({ code: 'not_installed', message: expect.stringMatching(/not installed/) });
    expect(errorFromExit(exit({ spawnError: 'spawn EACCES' })).code).toBe('agent_error');
    // Captured from the real CLI.
    const option = errorFromExit(exit({ stderr: "error: unknown option '--no-such-flag'\n" }));
    expect(said(option)).toEqual({ code: 'cli_incompatible', message: "The installed Claude Code does not understand how the Studio starts it (error: unknown option '--no-such-flag'). Update Claude Code and try again." });
    expect(errorFromExit(exit({ stderr: "error: option '--permission-mode <mode>' argument 'manual' is invalid. Allowed choices are acceptEdits, default, plan.\n" })).code).toBe('cli_incompatible');
    expect(errorFromExit(exit({ stderr: 'Not logged in. Run claude auth login to authenticate.\n' })).code).toBe('not_signed_in');
    expect(errorFromExit(exit({ stderr: 'Error: MCP tool mcp__studio__permission_prompt (passed via --permission-prompt-tool) not found. Available MCP tools: none\n' })).code).toBe('bridge_unavailable');
    expect(said(errorFromExit(exit({ code: 0, strayLine: 'Segmentation fault' })))).toEqual({ code: 'agent_protocol', message: 'Claude Code printed something the Studio could not read and then stopped: "Segmentation fault"' });
    expect(said(errorFromExit(exit({ code: null, signal: 'SIGKILL' })))).toEqual({ code: 'agent_crashed', message: 'Claude Code was stopped by the system (SIGKILL) before it finished.' });
    expect(said(errorFromExit(exit({ code: 3, stderr: 'line 1\nfatal: out of memory\n' })))).toEqual({ code: 'agent_crashed', message: 'Claude Code ended with an error (exit code 3): line 1 · fatal: out of memory' });
    expect(errorFromExit(exit({ code: 2 })).message).toBe('Claude Code ended with an error (exit code 2) and said nothing about why.');
    expect(said(errorFromExit(exit({ code: 0 })))).toEqual({ code: 'agent_crashed', message: 'Claude Code ended without finishing its answer.' });
  });
});

describe('text from the CLI', () => {
  it('is masked, stripped of control characters and colour, put on one line and bounded', () => {
    expect(presentable('\u001b[31mfatal:\u001b[0m api_key=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\r\n  next\tline\u0007')).toBe('fatal: api_key=[redacted] · next line');
    expect(presentable('x'.repeat(1000)).length).toBe(600);
    expect(presentable('  spaced   out  ')).toBe('spaced out');
    expect(stderrTail(`${Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`).join('\n')}\n`)).toBe('line 15 · line 16 · line 17 · line 18 · line 19 · line 20');
    expect(stderrTail('')).toBe('');
  });

  it('recognises "no such conversation" in a result or, without one, in the error output', () => {
    const sentence = 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555';
    expect(isResumeNotFound(result({ subtype: 'error_during_execution', errors: [sentence] }), '')).toBe(true);
    expect(isResumeNotFound(null, `${sentence}\n`)).toBe(true);
    expect(isResumeNotFound(null, 'Error: --resume requires a valid session ID or session title when used with --print.')).toBe(true);
    // A turn that ran and failed for another reason is not a lost conversation, whatever the error output says.
    expect(isResumeNotFound(result({ subtype: 'error_during_execution', errors: ['Tool crashed'] }), sentence)).toBe(false);
    expect(isResumeNotFound(result({ isError: false, errors: [sentence] }), '')).toBe(false);
    expect(isResumeNotFound(null, 'something else')).toBe(false);
  });
});
