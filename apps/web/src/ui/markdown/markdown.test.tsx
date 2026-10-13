import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from './index';
import { classifyUrl, isInlineImageData } from './url';

const show = (source: string, props: Partial<React.ComponentProps<typeof Markdown>> = {}) => render(<Markdown {...props}>{source}</Markdown>);

describe('Markdown safety', () => {
  it('never turns a script tag into a script', () => {
    const { container } = show('Before <script>window.__pwned = true</script> after\n\n<script src="https://evil.example/x.js"></script>');
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(container).toHaveTextContent('Before');
    expect(container).toHaveTextContent('after');
  });

  it('drops raw HTML instead of interpreting it', () => {
    const { container } = show(
      [
        'Hello <b>bold</b> <img src="https://evil.example/pixel.gif" onerror="alert(1)"> <iframe src="https://evil.example"></iframe>',
        '',
        '<div onclick="alert(1)" style="position:fixed;inset:0">overlay</div>',
        '',
        '<form action="https://evil.example"><input name="password"></form>',
        '',
        '<a href="https://evil.example" onclick="alert(1)">raw link</a>',
      ].join('\n'),
    );
    for (const tag of ['b', 'img', 'iframe', 'form', 'input', 'style', 'object', 'embed']) expect(container.querySelector(tag)).toBeNull();
    expect(container.querySelector('[onclick], [onerror], [style]')).toBeNull();
    // the only anchors are ones Markdown syntax produced — none here
    expect(container.querySelector('a')).toBeNull();
  });

  it('drops javascript: and other script-capable or non-web link targets', () => {
    const { container } = show(
      [
        '[a](javascript:alert(1))',
        '[b](JaVaScRiPt:alert(1))',
        '[c](java\tscript:alert(1))',
        '[d](vbscript:msgbox(1))',
        '[e](data:text/html,<script>alert(1)</script>)',
        '[f](file:///etc/passwd)',
        '[g](//evil.example/path)',
        '[h](mailto:someone@example.com)',
        '[i](blob:https://x/y)',
      ].join('\n\n'),
    );
    expect(container.querySelectorAll('a')).toHaveLength(0);
    // the text stays readable
    for (const label of ['a', 'b', 'd', 'f', 'g', 'h', 'i']) expect(container).toHaveTextContent(label);
    expect(container.innerHTML).not.toMatch(/javascript:|vbscript:|data:text/i);
  });

  it('keeps http(s) and relative links, opened safely', () => {
    show('[docs](https://example.com/docs?a=1#top) and [file](./README.md) and [section](#usage) and <https://example.org>');
    const docs = screen.getByRole('link', { name: 'docs' });
    expect(docs).toHaveAttribute('href', 'https://example.com/docs?a=1#top');
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs.getAttribute('rel')).toContain('noopener');
    expect(docs.getAttribute('rel')).toContain('noreferrer');

    const file = screen.getByRole('link', { name: 'file' });
    expect(file).toHaveAttribute('href', './README.md');
    expect(file.getAttribute('rel')).toContain('noopener');

    // a link to a place on the same page stays on the page
    expect(screen.getByRole('link', { name: 'section' })).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: 'https://example.org' })).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('rejects links that hide another host behind credentials', () => {
    const { container } = show('[bank](https://bank.example@evil.example/login)');
    expect(container.querySelector('a')).toBeNull();
  });

  it('does not load a remote image until it is tapped', async () => {
    const user = userEvent.setup();
    const { container } = show('![A diagram](https://images.example/diagram.png)', { remoteImages: 'inline' });
    expect(container.querySelector('img')).toBeNull();
    const placeholder = screen.getByRole('button', { name: /A diagram/ });
    expect(placeholder).toHaveTextContent('images.example');

    await user.click(placeholder);
    const image = container.querySelector('img')!;
    expect(image).toHaveAttribute('src', 'https://images.example/diagram.png');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('alt', 'A diagram');
  });

  it('by default offers a remote image as a safe link rather than fetching it', () => {
    const { container } = show('![Chart](https://images.example/chart.png)');
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: /Chart/ });
    expect(link).toHaveAttribute('href', 'https://images.example/chart.png');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows only the alternative text for images it will not load', () => {
    const { container } = show('![tracker](javascript:alert(1)) ![local](./logo.png) ![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('tracker');
    expect(container).toHaveTextContent('local');
    expect(container).toHaveTextContent('svg');
  });

  it('shows embedded bitmap data and images the feature resolves itself', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const { container } = show(`![inline](${png}) ![local](./shot.png)`, { resolveImage: (src) => (src === './shot.png' ? '/api/projects/p1/files/raw?path=shot.png' : null) });
    const sources = [...container.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(sources).toEqual([png, '/api/projects/p1/files/raw?path=shot.png']);
  });

  it('renders GitHub-flavoured Markdown: tables, task lists, strikethrough', () => {
    const { container } = show('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~');
    expect(screen.getByRole('table')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeDisabled();
    expect(container.querySelector('del')).toHaveTextContent('gone');
  });

  it('gives code blocks a language label, highlighting and a copy button', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const { container } = show('```ts\nconst answer: number = 42;\n```');
    expect(container.querySelector('.ui-code__language')).toHaveTextContent('ts');
    expect(container.querySelector('pre code')).toHaveTextContent('const answer: number = 42;');
    expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const');

    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const answer: number = 42;');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('does not choke on a language it does not know', () => {
    const { container } = show('```made-up-lang\nhello <world>\n```');
    expect(container.querySelector('pre code')).toHaveTextContent('hello <world>');
  });
});

describe('the URL policy', () => {
  it('classifies what may stay', () => {
    expect(classifyUrl('https://example.com/a')).toMatchObject({ kind: 'remote', host: 'example.com' });
    expect(classifyUrl('HTTP://Example.com')).toMatchObject({ kind: 'remote' });
    expect(classifyUrl('/settings/account')).toEqual({ kind: 'relative', href: '/settings/account' });
    expect(classifyUrl('docs/guide.md#install')).toEqual({ kind: 'relative', href: 'docs/guide.md#install' });
    expect(classifyUrl('#top')).toEqual({ kind: 'relative', href: '#top' });
    expect(classifyUrl('path/with:colon')).toMatchObject({ kind: 'relative' });
  });

  it('refuses everything else', () => {
    for (const url of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'jav​ascript:alert(1)',
      'vbscript:x',
      'data:text/html;base64,AAAA',
      'file:///etc/passwd',
      'ftp://example.com',
      'ws://example.com',
      'chrome://settings',
      'about:blank',
      'intent://scan/#Intent;scheme=zxing;end',
      '//evil.example',
      '\\\\evil.example\\share',
      '/\\evil.example',
      'https://user:pass@example.com',
      'http://',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect(classifyUrl(url as string), String(url)).toBeNull();
    }
  });

  it('accepts only bitmap data for inline images', () => {
    expect(isInlineImageData('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isInlineImageData('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isInlineImageData('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isInlineImageData('data:image/png,<script>')).toBe(false);
  });
});
