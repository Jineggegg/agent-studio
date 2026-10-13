import { CornerLeftUp, Folder, FolderCheck, HardDrive } from 'lucide-react';
import { useState } from 'react';
import { useFolderListing } from '@/data/projects';
import { useT } from '@/i18n';
import { Badge, Button, EmptyState, ErrorState, List, ListRow, LoadingRow, Sheet } from '@/ui';

export interface FolderPickerProps {
  open: boolean;
  onClose: () => void;
  onChoose: (path: string) => void;
}

/** Walk the server's workspace folders and pick one, instead of typing a path on a phone keyboard. */
export function FolderPicker({ open, onClose, onChoose }: FolderPickerProps) {
  const t = useT();
  const [path, setPath] = useState<string | null>(null);
  const listing = useFolderListing(path, open);
  const data = listing.data;
  const entries = data ? (data.path === null ? data.roots : data.entries) : [];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('home.folder.title')}
      flush
      fill
      leading={
        <Button variant="plain" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button
          variant="plain"
          disabled={!data?.selectable || !data.path}
          onClick={() => {
            if (data?.path) onChoose(data.path);
          }}
        >
          {t('home.folder.choose')}
        </Button>
      }
    >
      <p className="folder-picker__path">{data?.path ?? t('home.folder.roots')}</p>
      <div className="folder-picker__list">
        {listing.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : listing.isError && !data ? (
          <ErrorState
            error={listing.error}
            compact
            onRetry={() => void listing.refetch()}
            actions={
              path !== null ? (
                <Button variant="plain" onClick={() => setPath(null)}>
                  {t('home.folder.backToRoots')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <List aria-label={t('home.folder.title')}>
            {data && data.path !== null && (data.parent !== null || data.roots.length > 1) && (
              <ListRow
                leading={<CornerLeftUp size={20} />}
                title={data?.parent ? t('home.folder.up') : t('home.folder.backToRoots')}
                onPress={() => setPath(data?.parent ?? null)}
              />
            )}
            {entries.map((entry) => (
              <ListRow
                key={entry.path}
                leading={data?.path === null ? <HardDrive size={20} /> : entry.projectId ? <FolderCheck size={20} /> : <Folder size={20} />}
                title={data?.path === null ? entry.path : entry.name}
                trailing={entry.projectId ? <Badge>{t('home.folder.isProject')}</Badge> : undefined}
                chevron
                onPress={() => setPath(entry.path)}
              />
            ))}
            {entries.length === 0 && (
              <EmptyState compact title={data?.path === null ? t('home.folder.noRoots') : t('home.folder.empty')} description={data?.selectable ? t('home.folder.emptyHint') : undefined} />
            )}
          </List>
        )}
        {data?.truncated && <p className="ui-list__footer">{t('home.folder.truncated')}</p>}
      </div>
    </Sheet>
  );
}
