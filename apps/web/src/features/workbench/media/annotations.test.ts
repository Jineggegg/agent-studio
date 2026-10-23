import { describe, expect, it, vi } from 'vitest';
import { copyImage, drawAnnotation, isLocalImageUrl, shareImage } from './annotations';
import { speechText } from './ReadAloud';

describe('image provenance', () => {
  it('allows only owned attachment URLs or local blobs', () => {
    const origin = 'https://studio.example';
    expect(isLocalImageUrl('/api/sessions/session-1/attachments/image-1', origin)).toBe(true);
    expect(isLocalImageUrl('blob:https://studio.example/id', origin)).toBe(true);
    for (const url of [
      'https://external.example/image.png',
      'blob:https://external.example/id',
      'data:image/png;base64,abc',
      '/api/users',
      '/api/sessions/a/attachments/b?token=secret',
    ])
      expect(isLocalImageUrl(url, origin)).toBe(false);
  });
  it('draws all annotation shapes without changing the source', () => {
    const context = {
      beginPath: vi.fn(),
      stroke: vi.fn(),
      rect: vi.fn(),
      ellipse: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    for (const tool of ['pen', 'arrow', 'rectangle', 'circle'] as const)
      drawAnnotation(context, {
        tool,
        points: [
          { x: 10, y: 10 },
          { x: 50, y: 70 },
        ],
        colour: '#ff0000',
        width: 4,
      });
    expect(context.stroke).toHaveBeenCalledTimes(4);
    expect(context.rect).toHaveBeenCalledWith(10, 10, 40, 60);
    expect(context.ellipse).toHaveBeenCalledWith(30, 40, 20, 30, 0, 0, Math.PI * 2);
  });
  it('downloads a copy when native share or image clipboard is missing', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local'), revokeObjectURL: vi.fn() }),
    );
    const file = new File(['pixels'], 'annotated.png', { type: 'image/png' });
    expect(await copyImage(file)).toBe('saved');
    expect(await shareImage(file)).toBe('saved');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
it('read aloud strips markup and link destinations', () => {
  expect(speechText('# Hello **world** [docs](https://example.com) <script>text</script>')).toBe(
    'Hello world docs text',
  );
});
