import { memo, useMemo } from 'react';
import { useT } from '@/i18n';
import { type DiffLine, parseUnifiedDiff } from './diff';

/** Changed lines shown before "N more": enough to judge a change, not enough to stall a phone. */
export const DIFF_LINE_LIMIT = 300;

const SIGNS: Record<DiffLine['kind'], string> = { add: '+', remove: '−', context: ' ', hunk: '', file: '', note: '' };

function Line({ line, numbered }: { line: DiffLine; numbered: boolean }) {
  const t = useT();
  if (line.kind === 'hunk' || line.kind === 'file' || line.kind === 'note') {
    return (
      <div className="wb-diff__line" data-kind={line.kind}>
        {numbered && <span className="wb-diff__number" aria-hidden="true" />}
        <span className="wb-diff__sign" aria-hidden="true" />
        <span className="wb-diff__text">{line.kind === 'note' ? `\\ ${line.text}` : line.text}</span>
      </div>
    );
  }
  return (
    <div className="wb-diff__line" data-kind={line.kind}>
      {numbered && (
        <span className="wb-diff__number" aria-hidden="true">
          {line.kind === 'remove' ? line.oldLine : line.newLine}
        </span>
      )}
      {/* The sign carries the meaning for anyone who cannot tell the tints apart; the words carry it for a screen reader. */}
      <span className="wb-diff__sign" aria-hidden="true">
        {SIGNS[line.kind]}
      </span>
      {line.kind !== 'context' && <span className="visually-hidden">{line.kind === 'add' ? t('workbench.diff.added') : t('workbench.diff.removed')}</span>}
      <span className="wb-diff__text">{line.text === '' ? ' ' : line.text}</span>
    </div>
  );
}

export interface DiffViewProps {
  patch: string;
  /** Changed lines to show before the rest is summarised. */
  limit?: number;
  /** Leave out file headers and line numbers (a short preview). */
  compact?: boolean;
  label?: string;
}

/**
 * A unified diff. Added and removed lines differ in their sign, in a bar at
 * the leading edge (solid for added, dashed for removed) and in tint — never
 * in colour alone — and the block scrolls sideways inside itself, so a long
 * line never widens the page.
 */
export const DiffView = memo(function DiffView({ patch, limit = DIFF_LINE_LIMIT, compact, label }: DiffViewProps) {
  const t = useT();
  const diff = useMemo(() => parseUnifiedDiff(patch, { maxChangedLines: limit }), [patch, limit]);
  const lines = compact ? diff.lines.filter((line) => line.kind !== 'file') : diff.lines;
  if (lines.length === 0) return null;
  const numbered = !compact && lines.some((line) => line.oldLine !== null || line.newLine !== null);
  return (
    <div className="wb-diff" data-compact={compact || undefined} role="group" aria-label={label ?? t('workbench.diff.label')}>
      <div className="wb-diff__scroll" tabIndex={0}>
        <div className="wb-diff__lines">
          {lines.map((line, index) => (
            <Line key={index} line={line} numbered={numbered} />
          ))}
        </div>
      </div>
      {diff.hiddenChanges > 0 && <p className="wb-diff__more">{t.plural('workbench.diff.more', diff.hiddenChanges)}</p>}
    </div>
  );
});

/** "+4 −2", with the words for assistive technology. */
export function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  const t = useT();
  return (
    <span className="wb-counts" aria-label={t('workbench.diff.counts', { added: t.number(added), removed: t.number(removed) })}>
      <span data-kind="add" aria-hidden="true">
        +{t.number(added)}
      </span>
      <span data-kind="remove" aria-hidden="true">
        −{t.number(removed)}
      </span>
    </span>
  );
}
