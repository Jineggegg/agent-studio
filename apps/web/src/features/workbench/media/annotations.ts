export type DrawingTool = 'pen' | 'arrow' | 'rectangle' | 'circle';
export interface Point {
  x: number;
  y: number;
}
export interface Annotation {
  tool: DrawingTool;
  points: Point[];
  colour: string;
  width: number;
}

/** Only already-owned attachment URLs and local blobs are eligible. Never fetch remote URLs. */
export function isLocalImageUrl(raw: string, origin = window.location.origin): boolean {
  try {
    const url = new URL(raw, origin);
    if (url.protocol === 'blob:') return url.origin === origin;
    return (
      url.origin === origin &&
      /^\/api\/sessions\/[a-zA-Z0-9_-]+\/attachments\/[a-zA-Z0-9_-]+$/.test(url.pathname) &&
      !url.search
    );
  } catch {
    return false;
  }
}

export function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation): void {
  const first = annotation.points[0];
  const last = annotation.points.at(-1);
  if (!first || !last) return;
  context.strokeStyle = annotation.colour;
  context.lineWidth = annotation.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (annotation.tool === 'rectangle') context.rect(first.x, first.y, dx, dy);
  else if (annotation.tool === 'circle')
    context.ellipse(
      (first.x + last.x) / 2,
      (first.y + last.y) / 2,
      Math.abs(dx) / 2,
      Math.abs(dy) / 2,
      0,
      0,
      Math.PI * 2,
    );
  else {
    context.moveTo(first.x, first.y);
    for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y);
    if (annotation.tool === 'arrow') {
      const angle = Math.atan2(dy, dx);
      const head = Math.max(annotation.width * 4, 12);
      context.moveTo(
        last.x - head * Math.cos(angle - Math.PI / 6),
        last.y - head * Math.sin(angle - Math.PI / 6),
      );
      context.lineTo(last.x, last.y);
      context.lineTo(
        last.x - head * Math.cos(angle + Math.PI / 6),
        last.y - head * Math.sin(angle + Math.PI / 6),
      );
    }
  }
  context.stroke();
}

export function downloadImage(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function shareImage(file: File): Promise<'shared' | 'saved'> {
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  downloadImage(file);
  return 'saved';
}

export async function copyImage(file: File): Promise<'copied' | 'saved'> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
      return 'copied';
    } catch {
      /* Download is the fallback. */
    }
  }
  downloadImage(file);
  return 'saved';
}
