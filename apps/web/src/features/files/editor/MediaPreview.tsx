import type { FileContent, Project } from '@agent-studio/protocol';
import { Download, ExternalLink, FileQuestion } from 'lucide-react';
import { useState } from 'react';
import { Stage, splitPath, startDownload } from '@/features/projects/tools/kit';
import { formatBytes } from '@/features/workbench/composer/attachments';
import { useT } from '@/i18n';
import { Button, EmptyState } from '@/ui';
import { filesApi } from '../api';

type Binary = Extract<FileContent, { kind: 'binary' }>;

/** Pictures smaller than this (on their longer side) are enlarged by a whole factor up to about this size. */
const SMALL_IMAGE = 128;

export type MediaKind = 'image' | 'pdf' | 'audio' | 'video' | 'none';

/** What kind of preview a file can have — only when the server says it is willing to serve it inline. */
export function mediaKind(content: Pick<Binary, 'previewable' | 'mediaType'>): MediaKind {
  if (!content.previewable) return 'none';
  const type = content.mediaType.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'none';
}

/**
 * A file that is not text. Pictures, PDF, sound and video are shown through
 * the server's preview address (which serves them sandboxed and only for the
 * kinds it trusts a browser with); everything else says plainly that it
 * cannot be shown and offers the download. Nothing plays by itself.
 */
export function MediaPreview({ project, path, content }: { project: Project; path: string; content: Binary }) {
  const t = useT();
  const { name } = splitPath(path);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const kind = failed ? 'none' : mediaKind(content);
  const inline = filesApi.rawUrl(project.id, path, 'inline');
  const download = () => startDownload(filesApi.rawUrl(project.id, path), name);
  const facts = [content.mediaType, formatBytes(content.size, t.number), size ? `${t.number(size.width)} × ${t.number(size.height)}` : null].filter(Boolean).join(' · ');
  // An icon-sized picture is drawn larger, its pixels kept square, rather than as a speck in the middle of the panel.
  const zoom = size && Math.max(size.width, size.height) < SMALL_IMAGE ? Math.max(1, Math.floor(SMALL_IMAGE / Math.max(size.width, size.height, 1))) : 1;

  if (kind === 'none') {
    return (
      <Stage>
        <EmptyState
          icon={<FileQuestion size={28} />}
          title={failed ? t('files.media.failed') : t('files.binary.title')}
          description={
            <>
              {failed ? t('files.media.failedDetail') : t('files.binary.description')}
              <br />
              <span className="u-mono">{facts}</span>
            </>
          }
          action={
            <Button variant="tinted" icon={<Download size={18} />} onClick={download}>
              {t('files.download')}
            </Button>
          }
        />
      </Stage>
    );
  }

  return (
    <div className="files-media" data-kind={kind}>
      <div className="files-media__stage">
        {kind === 'image' && (
          <img
            src={inline}
            alt={name}
            decoding="async"
            draggable={false}
            data-zoomed={zoom > 1 || undefined}
            style={zoom > 1 && size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
          />
        )}
        {kind === 'video' && <video src={inline} controls playsInline preload="metadata" aria-label={name} onError={() => setFailed(true)} />}
        {kind === 'audio' && <audio src={inline} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} />}
        {kind === 'pdf' && <iframe src={inline} title={name} sandbox="" referrerPolicy="no-referrer" />}
      </div>
      <footer className="files-media__bar">
        <span className="u-truncate u-mono">{facts}</span>
        {kind === 'pdf' && <p className="files-media__note">{t('files.media.pdfNote')}</p>}
        <div className="files-media__actions">
          {kind !== 'image' && (
            <a className="ui-button" data-variant="plain" data-size="sm" href={inline} target="_blank" rel="noopener noreferrer">
              <span className="ui-button__content">
                <ExternalLink size={16} aria-hidden="true" />
                <span className="ui-button__label">{t('files.media.openInTab')}</span>
              </span>
            </a>
          )}
          <Button size="sm" variant="neutral" icon={<Download size={16} />} onClick={download}>
            {t('files.download')}
          </Button>
        </div>
      </footer>
    </div>
  );
}
