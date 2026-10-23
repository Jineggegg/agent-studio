import { libraryListSchema } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { Slash } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/data/api';
import { useT } from '@/i18n';
import { Button, ErrorState, IconButton, Sheet } from '@/ui';
import { getDraft, setDraft, type DraftKey } from '../workbench/composer/drafts';
import './library.css';
export function CommandPicker({
  projectId,
  draftKey,
}: {
  projectId: string | null;
  draftKey: DraftKey;
}) {
  const t = useT(),
    [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['tool-library', projectId ?? ''],
    queryFn: () =>
      api.get('/api/tool-library', {
        schema: libraryListSchema,
        query: projectId ? { projectId } : {},
      }),
    enabled: open,
  });
  return (
    <>
      <IconButton
        icon={<Slash size={18} />}
        label={t('library.shortcut')}
        onClick={() => setOpen(true)}
      />
      <Sheet open={open} onClose={() => setOpen(false)} title={t('library.choose')}>
        <div className="library-form">
          {query.error && <ErrorState error={query.error} />}
          <p>{t('library.templateHint')}</p>
          {query.data?.items
            .filter((item) => item.enabled && item.kind !== 'mcp')
            .map((item) => (
              <Button
                variant="neutral"
                key={item.id}
                onClick={() => {
                  setDraft(
                    draftKey,
                    `/${item.kind === 'skill' ? 'skill:' : ''}${item.name} ${getDraft(draftKey)}`,
                  );
                  setOpen(false);
                }}
              >
                {item.name}
              </Button>
            ))}
        </div>
      </Sheet>
    </>
  );
}
