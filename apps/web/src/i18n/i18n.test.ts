import { describe, expect, it } from 'vitest';
import { en } from './en';
import { LANGUAGES, dictionaries, getTranslator, hasMessage, matchLanguage, translate } from './index';
import { zhCN } from './zh-CN';

const variables = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

describe('the dictionaries', () => {
  it('define exactly the same keys in every language', () => {
    const reference = Object.keys(en).sort();
    for (const { code } of LANGUAGES) {
      const keys = Object.keys(dictionaries[code]).sort();
      const missing = reference.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !reference.includes(key));
      expect({ language: code, missing, extra }).toEqual({ language: code, missing: [], extra: [] });
    }
  });

  it('leave no message empty', () => {
    for (const { code } of LANGUAGES) {
      const empty = Object.entries(dictionaries[code])
        .filter(([, text]) => text.trim() === '')
        .map(([key]) => key);
      expect({ language: code, empty }).toEqual({ language: code, empty: [] });
    }
  });

  it('use the same variables in every translation of a message', () => {
    const mismatched = Object.keys(en).filter((key) => variables(en[key as keyof typeof en]).join() !== variables(zhCN[key as keyof typeof en]).join());
    expect(mismatched).toEqual([]);
  });

  it('give every plural message both forms', () => {
    const keys = Object.keys(en);
    const ones = keys.filter((key) => key.endsWith('.one')).map((key) => key.slice(0, -4));
    for (const base of ones) expect(keys, base).toContain(`${base}.other`);
  });

  it('have actually been translated', () => {
    // Product names, units and a few identical words aside, Chinese text should not equal the English.
    const same = Object.keys(en).filter((key) => en[key as keyof typeof en] === zhCN[key as keyof typeof en]);
    expect(same).toEqual(['about.node']);
  });
});

describe('the translator', () => {
  it('fills variables and leaves unknown ones visible', () => {
    expect(translate('en', 'nav.backTo', { name: 'Settings' })).toBe('Back to Settings');
    expect(translate('zh-CN', 'nav.backTo', { name: '设置' })).toBe('返回设置');
    expect(translate('en', 'nav.backTo')).toBe('Back to {name}');
  });

  it('chooses plural forms by the rules of the language', () => {
    const t = getTranslator('en');
    expect(t.plural('people.count', 1)).toBe('1 person');
    expect(t.plural('people.count', 2)).toBe('2 people');
    expect(t.plural('people.count', 1200)).toBe('1,200 people');
    expect(getTranslator('zh-CN').plural('people.count', 3)).toBe('3 位成员');
  });

  it('formats numbers, dates, durations and relative times through Intl', () => {
    const t = getTranslator('en');
    const moment = new Date(2026, 9, 13, 14, 5).getTime();
    expect(t.number(1234.5)).toBe('1,234.5');
    expect(t.date(moment, 'weekday')).toBe('Tuesday');
    expect(t.date(moment, 'monthDay')).toBe('October 13');
    expect(t.duration(45)).toBe('45 seconds');
    expect(t.duration(600)).toBe('10 minutes');
    expect(t.relative(moment - 20_000, moment)).toBe('just now');
    expect(t.relative(moment - 5 * 60_000, moment)).toBe('5 minutes ago');
    expect(t.relative(moment + 2 * 3600_000, moment)).toBe('in 2 hours');
    expect(t.list(['a', 'b', 'c'])).toBe('a, b, and c');

    const zh = getTranslator('zh-CN');
    expect(zh.date(moment, 'weekday')).toBe('星期二');
    expect(zh.relative(moment - 5 * 60_000, moment)).toBe('5分钟前');
  });

  it('returns the same translator while the language stays the same', () => {
    expect(getTranslator('en')).toBe(getTranslator('en'));
    expect(getTranslator('en').language).toBe('en');
  });

  it('knows which keys exist, for messages looked up by server code', () => {
    expect(hasMessage('errors.project_exists')).toBe(true);
    expect(hasMessage('errors.something_new')).toBe(false);
    expect(hasMessage('toString')).toBe(false);
  });

  it("picks the language from the browser's list, in its order", () => {
    expect(matchLanguage(['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(matchLanguage(['zh-TW'])).toBe('zh-CN');
    expect(matchLanguage(['en-GB', 'zh-CN'])).toBe('en');
    expect(matchLanguage(['fr-FR', 'zh-CN'])).toBe('zh-CN');
    expect(matchLanguage(['de-DE'])).toBe('en');
    expect(matchLanguage([])).toBe('en');
  });
});
