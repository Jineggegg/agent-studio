import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailBody } from './MailBody';

afterEach(() => vi.restoreAllMocks());

describe('mail body text rendering', () => {
  it('keeps HTML, Markdown and links inert without starting requests', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const text = [
      '<script src="https://tracker.invalid/script.js">alert(1)</script>',
      '<img src="https://tracker.invalid/pixel" onerror="alert(1)">',
      '<iframe src="https://tracker.invalid/frame"></iframe>',
      '<style>@import "https://tracker.invalid/style";</style>',
      '<a href="javascript:alert(1)">HTML link</a>',
      '![Tracking image](https://tracker.invalid/markdown-pixel)',
      '[Markdown link](https://tracker.invalid/link)',
      '<https://tracker.invalid/autolink>',
      '![Inline image](data:image/png;base64,c3ludGhldGlj)',
      '**Literal formatting**',
      '  Spaces and\n\nline breaks',
    ].join('\n');
    const { container } = render(<MailBody text={text} />);
    const body = container.querySelector('.mail-body')!;

    expect(body.textContent).toBe(text);
    // No descendant element can load a resource, execute code, or become a link.
    expect(body.childElementCount).toBe(0);
    expect(container.querySelector('img, script, iframe, style, a, object, embed')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  });

  it('keeps replacement messages as text too', () => {
    const { container, rerender } = render(<MailBody text="First message" />);
    const next = '<svg onload="alert(1)">New mail</svg>\n[Open](https://tracker.invalid)';
    rerender(<MailBody text={next} />);
    const body = container.querySelector('.mail-body')!;
    expect(body.textContent).toBe(next);
    expect(body.childElementCount).toBe(0);
  });
});
