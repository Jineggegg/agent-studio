import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/http';
import { getTranslator } from '@/i18n';
import { collabProblem, describeCollabError } from './problems';

const en = getTranslator('en');
const zh = getTranslator('zh-CN');
const LATEST = '01jabcdefghjkmnpqrstvwxyz0';

describe('what the server says no to, in sentences', () => {
  it('says each handoff refusal in words, in both languages', () => {
    const cases: [string, number, RegExp, RegExp][] = [
      ['same_agent', 400, /already this conversation’s agent/, /已经是这段对话的智能体/],
      ['session_busy', 409, /still working in this conversation/, /.+/],
      ['not_latest_in_chain', 409, /Only the latest part/, /只有一段对话的最新部分/],
      ['handoff_in_progress', 409, /being handed over already/, /已在交接中/],
      ['agent_not_enabled', 422, /not offered in this project/, /.+/],
      ['project_required', 400, /Only a conversation in a project/, /只有项目中的对话/],
      ['too_many_tasks', 409, /as many multi-agent tasks in progress/, /已达上限/],
      ['task_needs_repository', 409, /Git repository with at least one commit/, /Git 仓库/],
      ['mode_requires_worktrees', 422, /only plans/, /只能做规划/],
      ['task_running', 409, /still working on this task/, /还有智能体在处理/],
      ['task_not_found', 404, /That task no longer exists/, /这个任务已不存在/],
    ];
    for (const [code, status, english, chinese] of cases) {
      const error = new ApiError(status, code, 'The server’s own English sentence.');
      expect(describeCollabError(error, en), code).toMatch(english);
      expect(describeCollabError(error, zh), code).toMatch(chinese);
      expect(describeCollabError(error, en), code).not.toBe('The server’s own English sentence.');
    }
  });

  it('points at the newest conversation of a chain when the server names it', () => {
    const problem = collabProblem(new ApiError(409, 'not_latest_in_chain', 'x', { latestSessionId: LATEST }), en);
    expect(problem.latestSessionId).toBe(LATEST);
    expect(problem.text).toMatch(/Only the latest part/);
    // Anything that is not an id is not followed.
    expect(collabProblem(new ApiError(409, 'not_latest_in_chain', 'x', { latestSessionId: '../../settings' }), en).latestSessionId).toBeNull();
    expect(collabProblem(new ApiError(409, 'same_agent', 'x', { latestSessionId: LATEST }), en).latestSessionId).toBeNull();
  });

  it('says when trying again may help', () => {
    expect(collabProblem(new ApiError(0, 'network_error', 'offline'), en).retryable).toBe(true);
    expect(collabProblem(new ApiError(409, 'handoff_in_progress', 'busy'), en).retryable).toBe(true);
    expect(collabProblem(new ApiError(400, 'same_agent', 'no'), en).retryable).toBe(false);
    expect(collabProblem(new Error('boom'), en)).toEqual({ text: en('errors.unknown'), latestSessionId: null, retryable: false });
  });
});
