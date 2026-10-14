import type { MemoryReindexResponse, MemoryStatus } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CircleAlert, CircleCheck, DatabaseZap, FileWarning, KeyRound, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { describeError } from '@/data/errors';
import { useIsOwner } from '@/data/session';
import { type Translator, useT } from '@/i18n';
import { useScreenActive } from '@/shell/ScreenStack';
import { Button, ErrorState, Glyph, List, ListRow, LoadingRow, StaleNotice, Switch, confirm, toast } from '@/ui';
import { memoryApi, memoryKeys } from './api';

/** The service line in plain words: working, or what is wrong and what it means. */
export function statusLine(status: MemoryStatus, t: Translator): { title: string; text: string; tone: 'positive' | 'danger' | 'warning' } {
  if (!status.healthy) {
    return status.problem === 'store_unreadable'
      ? { title: t('memory.status.unreadable.title'), text: t('memory.status.unreadable.text'), tone: 'danger' }
      : { title: t('memory.status.index.title'), text: t('memory.status.index.text'), tone: 'danger' };
  }
  if (status.indexStale) return { title: t('memory.status.stale.title'), text: t('memory.status.stale.text'), tone: 'warning' };
  return { title: t('memory.status.ok.title'), text: t.plural('memory.status.ok.text', status.notes, { folders: t.number(status.folders) }), tone: 'positive' };
}

/**
 * How memory is doing, in plain words — and, for the owner, the two things
 * only they decide: whether assistants may use memory at all, and rebuilding
 * the search index from the note files.
 */
export function StatusCard({ onRebuilt, listShowsUnavailable }: { onRebuilt: () => void; listShowsUnavailable: boolean }) {
  const t = useT();
  const isOwner = useIsOwner();
  const active = useScreenActive();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuilt, setRebuilt] = useState<MemoryReindexResponse | null>(null);
  const status = useQuery({ queryKey: memoryKeys.status, queryFn: ({ signal }) => memoryApi.status(signal), enabled: active, meta: { live: true } });

  const setAccess = async (on: boolean) => {
    if (!on) {
      const confirmed = await confirm({ title: t('memory.access.offTitle'), message: t('memory.access.offText'), confirmLabel: t('memory.access.offConfirm'), tone: 'danger' });
      if (!confirmed) return;
    }
    setSwitching(true);
    try {
      queryClient.setQueryData(memoryKeys.status, await memoryApi.setAgentAccess(on));
      toast.success(on ? t('memory.access.onDone') : t('memory.access.offDone'));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setSwitching(false);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    setRebuilt(null);
    try {
      setRebuilt(await memoryApi.reindex());
      void status.refetch();
      onRebuilt();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setRebuilding(false);
    }
  };

  const data = status.data;
  const about = (
    <details className="mem-about">
      <summary>{t('memory.about.title')}</summary>
      <ul>
        <li>{t('memory.about.folders')}</li>
        <li>{t('memory.about.agents')}</li>
        <li>{t('memory.about.untrusted')}</li>
        <li>{t('memory.about.secrets')}</li>
        <li>{t('memory.about.files')}</li>
      </ul>
    </details>
  );

  if (!data) {
    return (
      <div className="mem-status">
        {status.isError ? (
          <ErrorState error={status.error} title={t('memory.status.failed')} onRetry={() => void status.refetch()} retrying={status.isFetching} compact />
        ) : (
          <LoadingRow label={t('memory.status.loading')} />
        )}
        {about}
      </div>
    );
  }

  const line = statusLine(data, t);
  return (
    <div className="mem-status">
      {!(listShowsUnavailable && !data.healthy) && (
        <div className="mem-status__card" data-tone={line.tone}>
          <div className="mem-status__head">
            <Glyph icon={line.tone === 'positive' ? <CircleCheck size={18} /> : <CircleAlert size={18} />} tint={line.tone === 'positive' ? 'green' : line.tone === 'warning' ? 'amber' : 'red'} size={34} />
            <div>
              <p className="mem-status__title">{line.title}</p>
              <p className="mem-status__text">{line.text}</p>
            </div>
          </div>
          <dl className="mem-status__facts">
            <div>
              <dt>{t('memory.status.indexed')}</dt>
              <dd>{data.indexedAt ? t.relative(data.indexedAt) : t('memory.status.never')}</dd>
            </div>
            <div>
              <dt>{t('memory.status.assistants')}</dt>
              <dd>{data.agentAccess ? t('memory.status.assistantsOn') : t('memory.status.assistantsOff')}</dd>
            </div>
            {data.location && (
              <div>
                <dt>{t('memory.status.location')}</dt>
                <dd className="u-mono">{data.location}</dd>
              </div>
            )}
          </dl>
          {data.withheld > 0 && (
            <p className="mem-status__flag">
              <KeyRound size={15} aria-hidden="true" />
              {t.plural('memory.status.withheld', data.withheld)}
            </p>
          )}
          {data.unreadable > 0 && (
            <p className="mem-status__flag">
              <FileWarning size={15} aria-hidden="true" />
              {t.plural('memory.status.unreadableFiles', data.unreadable)}
            </p>
          )}
          {data.skippedFiles !== null && data.skippedFiles > 0 && <p className="mem-status__flag">{t.plural('memory.status.skipped', data.skippedFiles)}</p>}
          {status.isError && <StaleNotice since={status.dataUpdatedAt} />}
          {!data.healthy && (
            <Button size="sm" variant="tinted" loading={status.isFetching} onClick={() => void status.refetch()}>
              {t('memory.status.check')}
            </Button>
          )}
        </div>
      )}

      {isOwner && (
        <List header={t('memory.owner.header')} footer={t('memory.owner.footer')}>
          <ListRow
            leading={<Glyph icon={<Bot size={18} />} tint="purple" />}
            title={t('memory.access.title')}
            subtitle={data.agentAccess ? t('memory.access.on') : t('memory.access.off')}
            control={<Switch checked={data.agentAccess} disabled={switching} onChange={(on) => void setAccess(on)} />}
          />
          <ListRow
            leading={<Glyph icon={<DatabaseZap size={18} />} tint="slate" />}
            title={t('memory.rebuild.title')}
            subtitle={
              rebuilt
                ? t('memory.rebuild.done', { notes: t.number(rebuilt.notes), ms: t.number(Math.round(rebuilt.tookMs)) })
                : t('memory.rebuild.text')
            }
            trailing={
              <Button size="sm" variant="neutral" icon={<RefreshCw size={16} />} loading={rebuilding} onClick={() => void rebuild()}>
                {t('memory.rebuild.action')}
              </Button>
            }
          />
        </List>
      )}
      {about}
    </div>
  );
}
