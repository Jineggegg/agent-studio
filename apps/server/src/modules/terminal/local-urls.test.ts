import { describe, expect, it } from 'vitest';
import { ControlSequenceStripper, LocalUrlScanner, parseLocalUrl } from './local-urls.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** Feeds text as one chunk and reports the addresses found, including one at the very end. */
function scan(text: string): string[] {
  const scanner = new LocalUrlScanner();
  return [...scanner.push(Buffer.from(text, 'utf8')), ...scanner.flush()].map((url) => url.url);
}

describe('recognising local development servers', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000', 'localhost', 3000],
    ['http://localhost:3000/', 'http://localhost:3000/', 'localhost', 3000],
    ['https://localhost:8443/app?x=1#top', 'https://localhost:8443/app?x=1#top', 'localhost', 8443],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080', '127.0.0.1', 8080],
    ['http://127.1.2.3:9/', 'http://127.1.2.3:9/', '127.1.2.3', 9],
    ['http://0.0.0.0:5000', 'http://0.0.0.0:5000', '0.0.0.0', 5000],
    ['http://[::1]:5173/', 'http://[::1]:5173/', '[::1]', 5173],
    ['http://[::]:4000', 'http://[::]:4000', '[::]', 4000],
    ['http://app.localhost:3000/', 'http://app.localhost:3000/', 'app.localhost', 3000],
    ['HTTP://LOCALHOST:3000/Path', 'http://localhost:3000/Path', 'localhost', 3000],
    ['http://localhost', 'http://localhost', 'localhost', 80],
    ['https://localhost/', 'https://localhost/', 'localhost', 443],
    ['http://localhost.:3000/', 'http://localhost:3000/', 'localhost', 3000],
    ['http://localhost:65535', 'http://localhost:65535', 'localhost', 65535],
  ])('accepts %s', (candidate, url, host, port) => {
    expect(parseLocalUrl(candidate)).toEqual({ url, scheme: url.startsWith('https') ? 'https' : 'http', host, port });
    expect(scan(`  Local:   ${candidate}\n`)).toEqual([url]);
  });

  it.each([
    ['a public site', 'https://example.com/'],
    ['a public site with a port', 'http://example.com:3000/'],
    ['a private network address', 'http://192.168.1.5:3000/'],
    ['a name that only starts with localhost', 'http://localhost.evil.example:3000/'],
    ['a name that only starts with a loopback address', 'http://127.0.0.1.nip.io:3000/'],
    ['an address just outside the loopback range', 'http://128.0.0.1:80/'],
    ['an address with an octet out of range', 'http://127.0.0.256:80/'],
    ['another IPv6 address', 'http://[::2]:80/'],
    ['localhost used as a user name', 'http://localhost:3000@evil.example/'],
    ['localhost used as a user name without a port', 'http://localhost@evil.example/'],
    ['credentials in front of localhost', 'http://user:pw@localhost:3000/'],
    ['a port that is too large', 'http://localhost:99999/'],
    ['port zero', 'http://localhost:0/'],
    ['a port followed by letters', 'http://localhost:3000abc'],
    ['a port with too many digits', 'http://localhost:300000'],
    ['an underscore continuing the name', 'http://localhost_evil.example/'],
    ['another scheme', 'ftp://localhost:21/'],
    ['a websocket address', 'ws://localhost:3000/'],
    ['no scheme at all', 'localhost:3000'],
    ['a local address inside the query of a public one', 'https://example.com/login?next=http://localhost:3000/'],
  ])('ignores %s', (_what, candidate) => {
    expect(scan(`see ${candidate} for details\n`)).toEqual([]);
    expect(scan(candidate)).toEqual([]);
  });

  it.each([
    ['(http://localhost:3000)', 'http://localhost:3000'],
    ['(http://localhost:3000/)', 'http://localhost:3000/'],
    ['http://localhost:3000.', 'http://localhost:3000'],
    ['http://localhost:3000/.', 'http://localhost:3000/'],
    ['http://localhost:3000/docs, then', 'http://localhost:3000/docs'],
    ['"http://localhost:3000/"', 'http://localhost:3000/'],
    ["'http://localhost:3000/a'", 'http://localhost:3000/a'],
    ['<http://localhost:3000/>', 'http://localhost:3000/'],
    ['[docs](http://localhost:3000/docs)', 'http://localhost:3000/docs'],
    ['http://localhost:3000/a(b)', 'http://localhost:3000/a(b)'],
    ['`http://localhost:3000/`', 'http://localhost:3000/'],
    ['open http://localhost:3000/!', 'http://localhost:3000/'],
    ['**http://localhost:3000/**', 'http://localhost:3000/'],
    ['http://localhost:3000/?a=1&b=2;', 'http://localhost:3000/?a=1&b=2'],
  ])('trims the punctuation around %s', (text, url) => {
    expect(scan(`${text}\n`)).toEqual([url]);
  });

  it('reads through the colours a development server prints', () => {
    const vite = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\r\n`;
    expect(scan(vite)).toEqual(['http://localhost:5173/']);
    const titled = `${ESC}]0;dev server${BEL}ready on ${ESC}[4mhttp://127.0.0.1:3000${ESC}[24m\r\n`;
    expect(scan(titled)).toEqual(['http://127.0.0.1:3000']);
    // A window title that mentions an address is not output.
    expect(scan(`${ESC}]0;http://localhost:1234/${BEL}plain text\n`)).toEqual([]);
    // The target of a terminal hyperlink counts, whatever its label says.
    expect(scan(`${ESC}]8;;http://localhost:6006/?path=/story${ESC}\\Storybook${ESC}]8;;${ESC}\\\n`)).toEqual(['http://localhost:6006/?path=/story']);
    expect(scan(`${ESC}]8;;https://example.com/${ESC}\\public${ESC}]8;;${ESC}\\\n`)).toEqual([]);
  });

  it('finds an address wherever the output happens to be cut', () => {
    const output = Buffer.from(`\r\n  ${ESC}[1mLocal${ESC}[22m: ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/app${ESC}[39m — 世界 ready\r\n`, 'utf8');
    for (let cut = 0; cut <= output.length; cut += 1) {
      const scanner = new LocalUrlScanner();
      const found = [...scanner.push(output.subarray(0, cut)), ...scanner.push(output.subarray(cut))];
      expect(found.map((url) => url.url), `cut at byte ${cut}`).toEqual(['http://localhost:5173/app']);
    }
    // And when it arrives one byte at a time.
    const scanner = new LocalUrlScanner();
    const found = [...output].flatMap((byte) => scanner.push(Buffer.from([byte])));
    expect(found.map((url) => url.url)).toEqual(['http://localhost:5173/app']);
    expect(scanner.urls.map((url) => url.url)).toEqual(['http://localhost:5173/app']);
  });

  it('waits for the rest of an address that ends exactly where the output stops', () => {
    const scanner = new LocalUrlScanner();
    expect(scanner.push(Buffer.from('listening on http://localhost:30'))).toEqual([]);
    expect(scanner.push(Buffer.from('00/'))).toEqual([]);
    expect(scanner.push(Buffer.from('\n')).map((url) => url.url)).toEqual(['http://localhost:3000/']);

    // When nothing follows, a flush takes it as it stands.
    const quiet = new LocalUrlScanner();
    expect(quiet.push(Buffer.from('listening on http://localhost:3000'))).toEqual([]);
    expect(quiet.flush().map((url) => url.url)).toEqual(['http://localhost:3000']);
    expect(quiet.flush()).toEqual([]);
  });

  it('reports each address once', () => {
    const scanner = new LocalUrlScanner();
    const line = Buffer.from('GET http://localhost:3000/ 200\n');
    expect(scanner.push(line)).toHaveLength(1);
    expect(scanner.push(line)).toEqual([]);
    expect(scanner.push(Buffer.from('GET http://localhost:3000/other 200\n')).map((url) => url.url)).toEqual(['http://localhost:3000/other']);
    expect(scanner.urls.map((url) => url.url)).toEqual(['http://localhost:3000/', 'http://localhost:3000/other']);
  });

  it('remembers a bounded number of addresses', () => {
    const scanner = new LocalUrlScanner({ maxUrls: 3 });
    for (let port = 3000; port < 3010; port += 1) scanner.push(Buffer.from(`http://localhost:${port}/\n`));
    expect(scanner.urls.map((url) => url.port)).toEqual([3000, 3001, 3002]);
  });

  it('copes with endless text that never becomes an address', () => {
    const scanner = new LocalUrlScanner();
    for (let round = 0; round < 200; round += 1) scanner.push(Buffer.from('http://localhost:3000/'.padEnd(4096, 'a')));
    scanner.push(Buffer.from(`${ESC}]0;${'t'.repeat(100_000)}`)); // a title that is never closed
    expect(scanner.push(Buffer.from(' ok http://localhost:4000/ done\n')).map((url) => url.url)).toEqual(['http://localhost:4000/']);
    expect(scanner.urls.every((url) => url.url.length <= 2048)).toBe(true);
  });
});

describe('removing control sequences', () => {
  const strip = (text: string) => new ControlSequenceStripper().push(text);

  it.each([
    ['colours', `${ESC}[1;31mred${ESC}[0m`, 'red'],
    ['cursor movement', `a${ESC}[2K${ESC}[1Gb`, 'ab'],
    ['a private mode', `${ESC}[?25lhidden${ESC}[?25h`, 'hidden'],
    ['a title ended by a bell', `${ESC}]0;title${BEL}text`, 'text'],
    ['a title ended by a string terminator', `${ESC}]2;title${ESC}\\text`, 'text'],
    ['a device control string', `${ESC}Pq#0;2;0;0;0${ESC}\\text`, 'text'],
    ['a character set selection', `${ESC}(Bplain`, 'plain'],
    ['a two-character sequence', `${ESC}7saved${ESC}8`, 'saved'],
    ['a one-byte CSI', `${String.fromCharCode(0x9b)}31mred`, 'red'],
    ['bells and backspaces', `a${BEL}b${String.fromCharCode(8)}c`, 'abc'],
    ['line structure, which is kept', 'one\r\n\ttwo', 'one\r\n\ttwo'],
    ['an escape that interrupts another', `${ESC}[12${ESC}[1mbold`, 'bold'],
  ])('removes %s', (_what, input, output) => {
    expect(strip(input)).toBe(output);
  });

  it('remembers an unfinished sequence between chunks', () => {
    const stripper = new ControlSequenceStripper();
    expect(stripper.push(`a${ESC}`)).toBe('a');
    expect(stripper.push('[3')).toBe('');
    expect(stripper.push('1mb')).toBe('b');
    expect(stripper.push(`${ESC}]0;ti`)).toBe('');
    expect(stripper.push(`tle${BEL}c`)).toBe('c');
  });

  it('gives up on a sequence that never ends rather than swallowing output forever', () => {
    const stripper = new ControlSequenceStripper();
    stripper.push(`${ESC}]0;`);
    stripper.push('x'.repeat(5000));
    expect(stripper.push('visible')).toBe('visible');
  });
});
