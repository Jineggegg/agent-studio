import type { ConfigWarning } from '@agent-studio/protocol';
import { useState } from 'react';
import { useSession } from '@/data/session';
import { useT } from '@/i18n';
import { clearCachedFiles } from '@/pwa/register';
import { BUILD_ID, BUILD_TIME, checkForUpdate } from '@/pwa/update';
import { Badge, Banner, ErrorState, List, ListRow, LoadingRow, LogoMark, StaleNotice, confirm, toast } from '@/ui';
import { useSystemInfo } from '../api';

const WARNING_TONE = { info: 'info', warning: 'warning', danger: 'danger' } as const;
const SEVERITY_ORDER: ConfigWarning['severity'][] = ['danger', 'warning', 'info'];

/** What this Studio is, how it is running, and anything about its configuration the owner should know. */
export default function AboutPage() {
  const t = useT();
  const info = useSystemInfo();
  const isOwner = useSession((state) => state.user?.role === 'owner');
  const [checking, setChecking] = useState(false);
  const data = info.data;
  const warnings = [...(data?.warnings ?? [])].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      if (BUILD_ID === 'dev') toast.info(t('about.update.dev'));
      else if (!(await checkForUpdate())) toast.success(t('about.update.current'));
    } finally {
      setChecking(false);
    }
  };

  const clear = async () => {
    if (!(await confirm({ title: t('about.cache.confirm.title'), message: t('about.cache.confirm.message'), confirmLabel: t('about.cache.clear') }))) return;
    try {
      const removed = await clearCachedFiles();
      toast.success(removed > 0 ? t('about.cache.cleared') : t('about.cache.nothing'));
    } catch {
      toast.error(t('about.cache.failed'));
    }
  };

  return (
    <>
      <div className="about-head">
        <LogoMark size={76} plated />
        <p className="about-head__name">Agent Studio</p>
        <p className="text-secondary">{t('about.tagline')}</p>
      </div>

      {warnings.length > 0 && (
        <section className="about-warnings" aria-label={t('about.warnings')}>
          {warnings.map((warning) => (
            <Banner key={warning.code} tone={WARNING_TONE[warning.severity]} role="status">
              <p>{warning.message}</p>
              <details className="about-warning__detail">
                <summary>{t('about.warnings.howToFix')}</summary>
                <p>{warning.detail}</p>
              </details>
            </Banner>
          ))}
        </section>
      )}

      {info.isPending ? (
        <LoadingRow label={t('common.loading')} />
      ) : !data ? (
        <ErrorState error={info.error} onRetry={() => void info.refetch()} retrying={info.isFetching} compact />
      ) : (
        <>
          {info.isError && <StaleNotice since={info.dataUpdatedAt} />}
          <List header={t('about.section.studio')}>
            <ListRow title={t('about.version')} value={<span className="u-tabular">{data.version}</span>} />
            <ListRow
              title={t('about.build')}
              subtitle={BUILD_TIME > 0 ? t('about.builtAt', { when: t.date(BUILD_TIME, 'dateTime') }) : t('about.build.devHint')}
              value={<span className="u-mono">{BUILD_ID === 'dev' ? t('about.build.dev') : BUILD_ID}</span>}
            />
            <ListRow title={t('about.started')} subtitle={t.date(data.startedAt, 'dateTime')} value={t.relative(data.startedAt)} />
            <ListRow
              title={t('about.sandbox')}
              subtitle={data.sandbox.mode === 'bwrap' ? t('about.sandbox.on') : `${t('about.sandbox.off')}${data.sandbox.reason ? ` ${data.sandbox.reason}` : ''}`}
              trailing={<Badge tone={data.sandbox.mode === 'bwrap' ? 'positive' : 'warning'}>{data.sandbox.mode === 'bwrap' ? t('common.on') : t('common.off')}</Badge>}
            />
            <ListRow title={t('about.terminal')} subtitle={data.terminalEnabled ? t('about.terminal.on') : t('about.terminal.off')} trailing={<Badge>{data.terminalEnabled ? t('common.on') : t('common.off')}</Badge>} />
          </List>

          {isOwner && data.node && (
            <List header={t('about.section.host')} footer={t('about.host.hint')}>
              <ListRow title={t('about.node')} value={<span className="u-mono">{data.node}</span>} />
              <ListRow title={t('about.platform')} value={<span className="u-mono">{data.platform}</span>} />
              {data.dataDir && <ListRow title={t('about.dataDir')} subtitle={<span className="u-mono">{data.dataDir}</span>} />}
              <ListRow
                title={t('about.workspaceRoots')}
                subtitle={
                  <span className="settings-multiline">
                    {(data.workspaceRoots ?? []).map((root) => (
                      <span key={root} className="u-mono">
                        {root}
                      </span>
                    ))}
                  </span>
                }
              />
              <ListRow
                title={t('about.publicOrigins')}
                subtitle={
                  data.publicOrigins && data.publicOrigins.length > 0 ? (
                    <span className="settings-multiline">
                      {data.publicOrigins.map((origin) => (
                        <span key={origin} className="u-mono">
                          {origin}
                        </span>
                      ))}
                    </span>
                  ) : (
                    t('about.publicOrigins.none')
                  )
                }
              />
            </List>
          )}
        </>
      )}

      <List header={t('about.section.maintenance')} footer={t('about.cache.hint')}>
        <ListRow title={t('about.update.check')} onPress={() => void check()} disabled={checking} tone="accent" />
        <ListRow title={t('about.cache.clear')} onPress={() => void clear()} tone="accent" />
      </List>

      <List header={t('about.section.licence')} footer={t('about.licence.hint')}>
        <ListRow title={t('about.licence')} value="MIT" />
      </List>
    </>
  );
}
