import { type MouseEvent, memo, useCallback } from 'react';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { toast } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { useInspectorAction } from '../inspector/scope';
import { parseFileReference } from './links';

/**
 * Markdown written by an agent (or quoted from a plan). The only difference
 * from plain `<Markdown>` is what a link to a file does: it opens the file in
 * the project's tools when a panel for that is installed, and otherwise
 * copies the path — never a new tab on an address that does not exist.
 */
export const Prose = memo(function Prose({ children, compact }: { children: string; compact?: boolean }) {
  const t = useT();
  const openFile = useInspectorAction('open-file');
  const onLinkClick = useCallback(
    (href: string, event: MouseEvent<HTMLAnchorElement>) => {
      const reference = parseFileReference(href);
      if (!reference) return;
      event.preventDefault();
      if (openFile) {
        openFile({ type: 'open-file', ...reference });
        return;
      }
      void copyText(reference.path).then((copied) => {
        if (copied) toast.info(t('workbench.link.pathCopied', { path: reference.path }), { id: 'workbench-path-copied' });
      });
    },
    [openFile, t],
  );
  return (
    <Markdown onLinkClick={onLinkClick} {...(compact ? { compact } : {})}>
      {children}
    </Markdown>
  );
});
