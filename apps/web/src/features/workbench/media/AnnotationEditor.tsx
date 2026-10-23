import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '@/i18n';
import {
  copyImage,
  downloadImage,
  drawAnnotation,
  isLocalImageUrl,
  shareImage,
  type Annotation,
  type DrawingTool,
  type Point,
} from './annotations';
import './media.css';

export interface ImageUse {
  file: File;
  instruction: string;
}
export interface AnnotationEditorProps {
  image: { id: string; name: string; url: string };
  onClose(): void;
  onUseImage?: ((value: ImageUse) => Promise<void>) | undefined;
}

export function AnnotationEditor({ image, onClose, onUseImage }: AnnotationEditorProps) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLImageElement | null>(null);
  const active = useRef<Annotation | null>(null);
  const cursor = useRef<Point>({ x: 40, y: 40 });
  const pointerId = useRef<number | null>(null);
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [ready, setReady] = useState(false);
  const [colour, setColour] = useState('#e23b45');
  const [width, setWidth] = useState(5);
  const [instruction, setInstruction] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const local = isLocalImageUrl(image.url);

  function paint(annotations = marks, pending = active.current) {
    const target = canvas.current;
    const original = source.current;
    if (!target || !original) return;
    const context = target.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(original, 0, 0, target.width, target.height);
    for (const mark of annotations) drawAnnotation(context, mark);
    if (pending) drawAnnotation(context, pending);
  }

  useEffect(() => {
    mounted.current = true;
    if (!local) return;
    const original = new Image();
    original.onload = () => {
      const target = canvas.current;
      if (!mounted.current || !target) return;
      // Bound decoded canvas memory; the original file is never changed.
      const factor = Math.min(1, 4096 / Math.max(original.naturalWidth, original.naturalHeight));
      target.width = Math.max(1, Math.round(original.naturalWidth * factor));
      target.height = Math.max(1, Math.round(original.naturalHeight * factor));
      source.current = original;
      target.getContext('2d')?.drawImage(original, 0, 0, target.width, target.height);
      setReady(true);
    };
    original.onerror = () => {
      if (mounted.current) setNotice(t('media.failed'));
    };
    original.src = image.url;
    return () => {
      mounted.current = false;
      original.onload = null;
      original.onerror = null;
      source.current = null;
    };
  }, [image.url, local, t]);

  useEffect(() => {
    paint();
  }, [marks]); // eslint-disable-line react-hooks/exhaustive-deps

  const point = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          event.currentTarget.width,
          ((event.clientX - rect.left) * event.currentTarget.width) / rect.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          event.currentTarget.height,
          ((event.clientY - rect.top) * event.currentTarget.height) / rect.height,
        ),
      ),
    };
  };
  const begin = (at: Point) => {
    active.current = { tool, colour, width, points: [at, at] };
  };
  const move = (at: Point) => {
    const mark = active.current;
    if (!mark) return;
    if (mark.tool === 'pen') mark.points.push(at);
    else mark.points[1] = at;
    paint();
  };
  const finish = () => {
    const mark = active.current;
    active.current = null;
    pointerId.current = null;
    if (mark) setMarks((old) => [...old, mark]);
  };
  const keyboard = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (active.current) finish();
      else begin(cursor.current);
    }
    if (event.key === 'Escape' && active.current) {
      event.preventDefault();
      event.stopPropagation();
      active.current = null;
      paint();
    }
    const shifts: Record<string, Point> = {
      ArrowLeft: { x: -10, y: 0 },
      ArrowRight: { x: 10, y: 0 },
      ArrowUp: { x: 0, y: -10 },
      ArrowDown: { x: 0, y: 10 },
    };
    const shift = shifts[event.key];
    if (!shift) return;
    event.preventDefault();
    cursor.current = {
      x: Math.max(0, Math.min(event.currentTarget.width, cursor.current.x + shift.x)),
      y: Math.max(0, Math.min(event.currentTarget.height, cursor.current.y + shift.y)),
    };
    move(cursor.current);
  };

  async function makeFile(): Promise<File> {
    const target = canvas.current;
    if (!target || !ready || !local) throw new Error('image_unavailable');
    const blob = await new Promise<Blob>((resolve, reject) =>
      target.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('canvas_export_failed'))),
        'image/png',
      ),
    );
    return new File([blob], `${image.name.replace(/\.[^.]+$/, '')}-annotated.png`, {
      type: 'image/png',
    });
  }
  async function act(kind: 'export' | 'copy' | 'share' | 'reply' | 'edit') {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const file = await makeFile();
      if (!mounted.current) return;
      if (kind === 'reply' || kind === 'edit') {
        if (!onUseImage) throw new Error('images_unsupported');
        await onUseImage({ file, instruction: kind === 'edit' ? instruction.trim() : '' });
        if (mounted.current) onClose();
      } else if (kind === 'copy') {
        const result = await copyImage(file);
        if (mounted.current) setNotice(t(result === 'copied' ? 'media.copied' : 'media.saved'));
      } else if (kind === 'share') {
        const result = await shareImage(file);
        if (result === 'saved' && mounted.current) setNotice(t('media.saved'));
      } else {
        downloadImage(file);
        setNotice(t('media.saved'));
      }
    } catch {
      if (mounted.current) setNotice(t('media.failed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div
      className="wb-annotation"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="wb-annotation__tools" role="group" aria-label={t('media.annotate')}>
        {(['pen', 'arrow', 'rectangle', 'circle'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={tool === value}
            onClick={() => setTool(value)}
          >
            {t(`media.${value}`)}
          </button>
        ))}
        <label>
          {t('media.colour')}
          <input type="color" value={colour} onChange={(event) => setColour(event.target.value)} />
        </label>
        <label>
          {t('media.width')}
          <input
            type="range"
            min="2"
            max="20"
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={!marks.length}
          onClick={() => setMarks((old) => old.slice(0, -1))}
        >
          {t('media.undo')}
        </button>
        <button type="button" disabled={!marks.length} onClick={() => setMarks([])}>
          {t('media.clear')}
        </button>
      </div>
      <p className="text-caption" id="annotation-keyboard">
        {t(local ? 'media.keyboard' : 'media.remote')}
      </p>
      <div className="wb-annotation__stage">
        <canvas
          ref={canvas}
          tabIndex={0}
          role="img"
          aria-label={image.name}
          aria-describedby="annotation-keyboard"
          onKeyDown={keyboard}
          onPointerDown={(event) => {
            if (!ready || pointerId.current !== null) return;
            event.preventDefault();
            pointerId.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            begin(point(event));
          }}
          onPointerMove={(event) => {
            if (pointerId.current === event.pointerId) move(point(event));
          }}
          onPointerUp={(event) => {
            if (pointerId.current === event.pointerId) {
              move(point(event));
              finish();
            }
          }}
          onPointerCancel={() => {
            active.current = null;
            pointerId.current = null;
            paint();
          }}
        />
      </div>
      <p className="text-caption">{t('media.original')}</p>
      <div className="wb-annotation__tools">
        {(['export', 'copy', 'share', 'reply'] as const).map((action) => (
          <button
            type="button"
            key={action}
            disabled={!ready || busy || (action === 'reply' && !onUseImage)}
            onClick={() => void act(action)}
          >
            {t(`media.${action}`)}
          </button>
        ))}
      </div>
      <label className="wb-annotation__instruction">
        {t('media.instruction')}
        <textarea
          value={instruction}
          maxLength={4000}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <p className="text-caption">{t(onUseImage ? 'media.editHint' : 'media.unsupported')}</p>
      <button
        type="button"
        disabled={!ready || busy || !onUseImage || !instruction.trim()}
        onClick={() => void act('edit')}
      >
        {t('media.edit')}
      </button>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
