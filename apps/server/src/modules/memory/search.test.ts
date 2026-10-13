import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextUnits, findHighlights, ftsExpression, ftsQuote, makeSnippet, mentions, parseQuery, scoreFields } from './search.js';

/** True when a string contains half of a surrogate pair on its own. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('escaping for the full-text index', () => {
  it('turns any text into one quoted string', () => {
    expect(ftsQuote('deploy')).toBe('"deploy"');
    expect(ftsQuote('say "hi"')).toBe('"say ""hi"""');
    expect(ftsQuote('"')).toBe('""""');
    expect(ftsQuote('a\u0000b\nc')).toBe('"a b c"');
  });

  it('joins strings any-of and leaves out those too short for the trigram index', () => {
    expect(ftsExpression(['deploy', 'ab', 'rules'])).toBe('"deploy" OR "rules"');
    expect(ftsExpression(['ab', '部署'])).toBeNull();
    expect(ftsExpression(['部署规'])).toBe('"部署规"');
    expect(ftsExpression([])).toBeNull();
  });

  describe('against a real index', () => {
    let db: DatabaseSync;
    const find = (query: string): number[] => {
      const match = parseQuery(query).match;
      if (match === null) return [];
      return db
        .prepare('SELECT rowid FROM notes WHERE notes MATCH ? ORDER BY rowid')
        .all(match)
        .map((row) => Number(row.rowid));
    };

    beforeAll(() => {
      db = new DatabaseSync(':memory:');
      db.exec("CREATE VIRTUAL TABLE notes USING fts5(title, body, tokenize = 'trigram')");
      const insert = db.prepare('INSERT INTO notes (rowid, title, body) VALUES (?, ?, ?)');
      insert.run(1, 'Alpha plan', 'The alpha service deploys on Tuesday.');
      insert.run(2, 'Beta plan', 'The beta service deploys on Friday.');
      insert.run(3, 'Operators', 'Write title:alpha OR "beta" NOT gamma, then NEAR(alpha beta) and a* literally.');
      insert.run(4, '部署规则', '我们的部署规则是先测试再上线。');
    });
    afterAll(() => db.close());

    it('finds substrings, prefixes and text without word spacing', () => {
      expect(find('alpha')).toEqual([1, 3]);
      expect(find('depl')).toEqual([1, 2]);
      expect(find('ALPHA')).toEqual([1, 3]);
      expect(find('部署规则')).toEqual([4]);
      expect(find('先测试')).toEqual([4]);
    });

    it.each([
      'alpha" OR "beta',
      '"alpha',
      'alpha"',
      '""',
      '"',
      'alpha NOT beta',
      'alpha AND',
      'OR',
      'NEAR(alpha beta)',
      'NEAR(alpha beta, 2',
      'title:alpha',
      'title : alpha',
      '{title body}:alpha',
      '-title:alpha',
      'alp*',
      '*',
      '^alpha',
      '(alpha OR beta',
      'alpha)',
      'alpha + beta',
      "alpha'; DROP TABLE notes; --",
      'a\u0000lpha',
      '\\',
      '%_%',
      'ａｌｐｈａ　ｂｅｔａ',
      '🚀🚀🚀',
      'x'.repeat(200),
    ])('never lets %j act as query syntax or fail', (query) => {
      expect(() => find(query)).not.toThrow();
    });

    it('treats operators as words to look for', () => {
      // As syntax this would exclude note 2; as text it is any-of "alpha", "not", "beta".
      expect(find('alpha NOT beta')).toEqual([1, 2, 3]);
      // As syntax this would look in the title column only; as text it finds the literal string.
      expect(find('title:alpha')).toEqual([3]);
      // A column filter on a column that does not exist would be an error.
      expect(find('nosuchcolumn:alpha')).toEqual([]);
      // Punctuation around a word is dropped before searching, so a trailing star changes nothing…
      expect(find('alp*')).toEqual(find('alp'));
      // …and inside a quoted string it is a character like any other, not a prefix operator.
      const literal = (text: string) =>
        db
          .prepare('SELECT rowid FROM notes WHERE notes MATCH ? ORDER BY rowid')
          .all(ftsExpression([text])!)
          .map((row) => Number(row.rowid));
      expect(literal('alp*')).toEqual([]);
      expect(literal('a* literally')).toEqual([3]);
      expect(literal('NEAR(alpha beta)')).toEqual([3]);
      expect(literal('alpha OR beta')).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 4 });
    });
  });
});

describe('reading a search-box query', () => {
  it('answers nothing for an empty query', () => {
    for (const empty of ['', '   ', '\n\t', '\u0000']) expect(parseQuery(empty)).toEqual({ text: '', units: [], match: null, short: [] });
  });

  it('looks for the whole phrase first, then each word', () => {
    const query = parseQuery('  Deploy   Rules ');
    expect(query.text).toBe('Deploy Rules');
    expect(query.units).toEqual([
      { text: 'deploy rules', weight: 3, typed: true },
      { text: 'deploy', weight: 2, typed: true },
      { text: 'rules', weight: 2, typed: true },
    ]);
    expect(query.match).toBe('"deploy rules" OR "deploy" OR "rules"');
    expect(query.short).toEqual([]);
  });

  it('strips quotes and brackets around words but keeps what is inside them', () => {
    expect(parseQuery('"deploy" (rules)').units.map((unit) => unit.text)).toEqual(['"deploy" (rules)', 'deploy', 'rules']);
    expect(parseQuery('node.js c++').units.map((unit) => unit.text)).toEqual(['node.js c++', 'node.js']);
    expect(parseQuery('c++').units.map((unit) => unit.text)).toEqual(['c']);
  });

  it('sends one- and two-character words to the short-word scan', () => {
    const query = parseQuery('部署');
    expect(query.match).toBeNull();
    expect(query.short).toEqual(['部署']);
    expect(parseQuery('db').short).toEqual(['db']);
    expect(parseQuery('猫').short).toEqual(['猫']);
  });

  it('drops single characters when there are other words', () => {
    const query = parseQuery('a deploy b');
    expect(query.units.map((unit) => unit.text)).toEqual(['a deploy b', 'deploy']);
  });

  it('also looks for the pieces of a long word in an unspaced script, at a low weight', () => {
    const query = parseQuery('部署规则');
    expect(query.units[0]).toEqual({ text: '部署规则', weight: 2, typed: true });
    expect(query.units.filter((unit) => !unit.typed).map((unit) => unit.text)).toEqual(['部署规', '署规则', '部署', '署规', '规则']);
    expect(query.match).toBe('"部署规则" OR "部署规" OR "署规则"');
    expect(query.short).toEqual(['部署', '署规', '规则']);
    // A Latin word is not cut up.
    expect(parseQuery('deployment').units).toHaveLength(1);
  });

  it('bounds the number of words and their length', () => {
    const query = parseQuery(Array.from({ length: 30 }, (_, index) => `word${index}`).join(' '));
    expect(query.units.filter((unit) => unit.typed)).toHaveLength(11); // the phrase and ten words
    expect(parseQuery('x'.repeat(500)).text).toHaveLength(200);
    expect(parseQuery('y'.repeat(150)).units[0]!.text).toHaveLength(64);
  });

  it('searches for punctuation when that is all there is', () => {
    expect(parseQuery('-->').units).toEqual([{ text: '-->', weight: 2, typed: true }]);
  });
});

describe('reading a chat message', () => {
  it('keeps the telling words and drops filler', () => {
    const units = contextUnits('How should we deploy the staging database after the migration?').units.map((unit) => unit.text);
    expect(units).toEqual(expect.arrayContaining(['deploy', 'staging', 'database', 'migration']));
    for (const filler of ['how', 'should', 'the', 'after', 'we']) expect(units).not.toContain(filler);
  });

  it('cuts unspaced text into three-character pieces and keeps short runs whole', () => {
    const query = contextUnits('部署规则是什么？另外 API 怎么鉴权');
    const texts = query.units.map((unit) => unit.text);
    expect(texts).toEqual(expect.arrayContaining(['部署规', '署规则', 'api']));
    expect(texts).toContain('另外');
    expect(query.short).toContain('另外');
  });

  it('is bounded however long the message is', () => {
    const query = contextUnits(`${'unique'.repeat(3)} ${Array.from({ length: 5_000 }, (_, index) => `term${index}`).join(' ')} ${'汉字'.repeat(5_000)}`);
    expect(query.units.length).toBeLessThanOrEqual(36);
    expect(query.match!.length).toBeLessThan(2_000);
  });

  it('finds nothing to look for in an empty or filler-only message', () => {
    expect(contextUnits('').units).toEqual([]);
    expect(contextUnits('ok').units).toEqual([]);
    expect(contextUnits('and the for you').units).toEqual([]);
  });
});

describe('finding a keyword in a message', () => {
  it('needs a whole word where words are spaced', () => {
    expect(mentions('how do we call the api today', 'api')).toBe(true);
    expect(mentions('api', 'api')).toBe(true);
    expect(mentions('the (api) is down', 'api')).toBe(true);
    expect(mentions('the capital of france', 'api')).toBe(false);
    expect(mentions('rapid apis', 'api')).toBe(false);
    expect(mentions('therapist; api-first', 'api')).toBe(true);
    expect(mentions('use node.js here', 'node.js')).toBe(true);
    expect(mentions('about c++ and more', 'c++')).toBe(true);
  });

  it('takes any occurrence in text without spaces', () => {
    expect(mentions('我们什么时候可以部署新版本', '部署')).toBe(true);
    expect(mentions('部署', '部署')).toBe(true);
    expect(mentions('用api部署', 'api')).toBe(true);
    expect(mentions('我们吃饭', '部署')).toBe(false);
  });

  it('finds nothing for an empty word', () => {
    expect(mentions('anything', '')).toBe(false);
    expect(mentions('', 'word')).toBe(false);
  });
});

describe('ranking', () => {
  const fields = (overrides: Partial<{ title: string; tags: string; keywords: string; body: string }>) => ({ title: '', tags: '', keywords: '', body: '', ...overrides });

  it('puts a title hit above a keyword hit above a tag hit above a body hit', () => {
    const query = parseQuery('deploy');
    const inTitle = scoreFields(fields({ title: 'deploy rules' }), query);
    const inKeywords = scoreFields(fields({ keywords: 'deploy release' }), query);
    const inTags = scoreFields(fields({ tags: 'deploy ops' }), query);
    const inBody = scoreFields(fields({ body: 'we deploy on tuesdays' }), query);
    expect(inTitle).toBeGreaterThan(inKeywords);
    expect(inKeywords).toBeGreaterThan(inTags);
    expect(inTags).toBeGreaterThan(inBody);
    expect(inBody).toBeGreaterThan(0);
  });

  it('prefers a note that has all the words to one that repeats a single word', () => {
    const query = parseQuery('deploy rollback');
    const both = scoreFields(fields({ body: 'how to deploy and how to rollback' }), query);
    const one = scoreFields(fields({ body: 'deploy deploy deploy deploy deploy deploy' }), query);
    expect(both).toBeGreaterThan(one);
  });

  it('scores nothing when nothing matches', () => {
    expect(scoreFields(fields({ title: 'unrelated', body: 'nothing here' }), parseQuery('deploy'))).toBe(0);
  });
});

describe('snippets and highlights', () => {
  it('marks every occurrence, whatever its case', () => {
    const text = 'Deploy on Tuesday; never deploy on Friday.';
    const highlights = findHighlights(text, parseQuery('deploy').units);
    expect(highlights.map(([from, to]) => text.slice(from, to))).toEqual(['Deploy', 'deploy']);
  });

  it('merges overlapping matches', () => {
    const text = 'deploy rules';
    expect(findHighlights(text, parseQuery('deploy rules').units)).toEqual([[0, 12]]);
    expect(findHighlights('部署规则', parseQuery('部署规则').units)).toEqual([[0, 4]]);
  });

  it('shows the text around the first match of the most important unit', () => {
    const text = `${'Intro sentence. '.repeat(40)}The deploy rules say Tuesday. ${'Closing words. '.repeat(40)}`;
    const snippet = makeSnippet(text, parseQuery('deploy rules').units, 120);
    expect(snippet.text.length).toBeLessThanOrEqual(122);
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    expect(snippet.text).toContain('deploy rules');
    expect(snippet.highlights.map(([from, to]) => snippet.text.slice(from, to))).toContain('deploy rules');
  });

  it('starts at the beginning when the match is in the title or tags only', () => {
    const snippet = makeSnippet('Nothing about it here, only other things.', parseQuery('deploy').units, 20);
    expect(snippet).toEqual({ text: 'Nothing about it her…', highlights: [] });
  });

  it('works in text without spaces', () => {
    const text = `${'前言。'.repeat(60)}我们的部署规则是先测试再上线。${'结语。'.repeat(60)}`;
    const snippet = makeSnippet(text, parseQuery('部署').units, 60);
    expect(snippet.highlights.map(([from, to]) => snippet.text.slice(from, to))).toEqual(['部署']);
  });

  it('never cuts a character in half', () => {
    const text = `${'🚀'.repeat(100)} deploy ${'🎉'.repeat(100)}`;
    for (const size of [10, 11, 12, 13, 40, 41]) {
      const snippet = makeSnippet(text, parseQuery('deploy').units, size);
      expect(hasLoneSurrogate(snippet.text), `size ${size}`).toBe(false);
    }
  });

  it('gives an empty snippet for an empty text', () => {
    expect(makeSnippet('', parseQuery('deploy').units)).toEqual({ text: '', highlights: [] });
  });
});
