import { FILE_LIMITS, type UploadResult } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/en';
import { zhCN } from '@/i18n/zh-CN';
import { brokenNameRule, checkUpload, isClutter, matchRuns, nameRuleKey, summarizeUpload, toProjectPath } from './rules';

const file = (name: string, size: number) => ({ file: { name, size } as File });

describe('names', () => {
  it('finds the rule a name breaks, in the order the server checks them', () => {
    expect(brokenNameRule('')).toBe('blank');
    expect(brokenNameRule('   ')).toBe('blank');
    expect(brokenNameRule('a/b')).toBe('characters');
    expect(brokenNameRule('what?.txt')).toBe('characters');
    expect(brokenNameRule('tab\there')).toBe('characters');
    expect(brokenNameRule('..')).toBe('dots');
    expect(brokenNameRule(' padded')).toBe('spaces');
    expect(brokenNameRule('CON')).toBe('reserved');
    expect(brokenNameRule('lpt9')).toBe('reserved');
    expect(brokenNameRule('.git')).toBe('git');
    expect(brokenNameRule('x'.repeat(256))).toBe('tooLong');
  });

  it('accepts ordinary names, dot-files and names that only resemble reserved ones', () => {
    for (const name of ['app.ts', '.env', 'CONSOLE.md', 'com10', '数据.json', 'a b.txt', '...rc']) expect(brokenNameRule(name), name).toBeNull();
  });

  it('has words for every rule in both languages', () => {
    for (const rule of ['blank', 'tooLong', 'characters', 'dots', 'spaces', 'reserved', 'git'] as const) {
      expect(en[nameRuleKey(rule)], rule).toBeTruthy();
      expect(zhCN[nameRuleKey(rule)], rule).toBeTruthy();
    }
  });
});

describe('paths an agent wrote', () => {
  const root = '/srv/work/demo';
  it('turns an absolute path inside the project into a project-relative one', () => {
    expect(toProjectPath(root, '/srv/work/demo/src/app.ts')).toEqual({ path: 'src/app.ts' });
    expect(toProjectPath(`${root}/`, '/srv/work/demo/src/app.ts')).toEqual({ path: 'src/app.ts' });
    expect(toProjectPath(root, root)).toEqual({ path: '' });
  });

  it('leaves a relative path alone, tidied', () => {
    expect(toProjectPath(root, './src//app.ts')).toEqual({ path: 'src/app.ts' });
    expect(toProjectPath(root, 'src\\lib\\x.ts')).toEqual({ path: 'src/lib/x.ts' });
    expect(toProjectPath(root, 'docs/')).toEqual({ path: 'docs' });
  });

  it('refuses what lies outside the project — never a same-named file inside it', () => {
    expect(toProjectPath(root, '/etc/passwd')).toEqual({ outside: true });
    expect(toProjectPath(root, '/srv/work/demo-other/a.ts')).toEqual({ outside: true });
    expect(toProjectPath(root, '../secrets.txt')).toEqual({ outside: true });
    expect(toProjectPath(root, 'src/../../x')).toEqual({ outside: true });
    expect(toProjectPath(root, '~/x')).toEqual({ outside: true });
    expect(toProjectPath(root, 'C:\\Users\\x')).toEqual({ outside: true });
  });
});

describe('uploads', () => {
  it('refuses, before anything is sent, what the server would refuse', () => {
    expect(checkUpload([], FILE_LIMITS)).toEqual({ reason: 'empty' });
    expect(checkUpload(Array.from({ length: 101 }, (_, index) => file(`f${index}`, 1)), FILE_LIMITS)).toEqual({ reason: 'tooMany', limit: 100, count: 101 });
    expect(checkUpload([file('small', 10), file('huge.iso', FILE_LIMITS.maxUploadFileBytes + 1)], FILE_LIMITS)).toEqual({ reason: 'fileTooLarge', limit: FILE_LIMITS.maxUploadFileBytes, name: 'huge.iso' });
    expect(checkUpload([file('a', 190 * 1024 * 1024), file('b', 190 * 1024 * 1024), file('c', 190 * 1024 * 1024)], FILE_LIMITS)).toEqual({ reason: 'totalTooLarge', limit: FILE_LIMITS.maxUploadTotalBytes });
    expect(checkUpload([file('a', 1), file('b', 2)], FILE_LIMITS)).toBeNull();
  });

  it('uses the limits the server reports, not the defaults', () => {
    expect(checkUpload([file('a', 1), file('b', 1), file('c', 1)], { maxUploadFiles: 2, maxUploadFileBytes: 10, maxUploadTotalBytes: 10 })).toEqual({ reason: 'tooMany', limit: 2, count: 3 });
  });

  it('separates files that could be replaced from files that were refused', () => {
    const result: UploadResult = {
      target: '',
      requested: 4,
      stored: [{ path: 'a.txt', size: 1, replaced: false }],
      skipped: [
        { name: 'b.txt', reason: 'exists' },
        { name: 'c?.txt', reason: 'invalid_name' },
        { name: '../d.txt', reason: 'outside_project' },
      ],
    };
    expect(summarizeUpload(result)).toEqual({
      stored: 1,
      requested: 4,
      existing: ['b.txt'],
      refused: [
        { name: 'c?.txt', reason: 'invalid_name' },
        { name: '../d.txt', reason: 'outside_project' },
      ],
    });
  });

  it('leaves operating-system clutter out of a dropped folder', () => {
    expect(isClutter('.DS_Store')).toBe(true);
    expect(isClutter('Thumbs.db')).toBe(true);
    expect(isClutter('._photo.jpg')).toBe(true);
    expect(isClutter('.env')).toBe(false);
  });
});

describe('marking what a content search found', () => {
  it('marks every occurrence, whatever its case, and keeps the text whole', () => {
    const runs = matchRuns('export const Answer = answer + ANSWER;', 'answer');
    expect(runs.filter((run) => run.match).map((run) => run.text)).toEqual(['Answer', 'answer', 'ANSWER']);
    expect(runs.map((run) => run.text).join('')).toBe('export const Answer = answer + ANSWER;');
  });

  it('marks nothing when there is nothing to mark', () => {
    expect(matchRuns('plain line', 'zzz')).toEqual([{ text: 'plain line', match: false }]);
    expect(matchRuns('plain line', '')).toEqual([{ text: 'plain line', match: false }]);
    expect(matchRuns('aaaa', 'aa').filter((run) => run.match)).toHaveLength(2);
  });
});
