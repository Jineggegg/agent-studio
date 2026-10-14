import type { PluginSummary } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { Plus, Puzzle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useStaleness } from '@/data/connection';
import { useT } from '@/i18n';
import { settingsPath } from '@/registry';
import { Badge, Button, DelayedSkeleton, EmptyState, ErrorState, Glyph, List, ListRow, Skeleton, StaleNotice, tintFor } from '@/ui';
import { pluginKeys, pluginsApi } from './api';
import { usePluginContributions } from './contributions';
import { pluginIcon } from './icons';
import { InstallSheet } from './InstallSheet';
import { PluginSheet } from './PluginSheet';
import { ReviewSheet } from './ReviewSheet';
import { ISOLATION_LABELS, type PluginChange, isolationFacts, pluginState } from './words';
import './plugins.css';

const TONE_BADGE = { neutral: 'neutral', positive: 'positive', warning: 'warning', danger: 'danger' } as const;

/**
 * Settings → Plugins (the owner): how well this machine contains plugins,
 * what is installed and in what state, installing, reviewing and approving,
 * and the pages plugins add to settings.
 */
export default function PluginsPage() {
  const t = useT();
  const list = useQuery({ queryKey: pluginKeys.list, queryFn: ({ signal }) => pluginsApi.list(signal), meta: { live: true } });
  const contributions = usePluginContributions();
  const staleness = useStaleness(list);
  const [installing, setInstalling] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [review, setReview] = useState<{ plugin: PluginSummary; changes: PluginChange[] | null } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [lastOpened, setLastOpened] = useState<PluginSummary | null>(null);
  /** A review asked for while another sheet is up: it opens once that sheet has gone, never on top of it. */
  const [queued, setQueued] = useState<{ plugin: PluginSummary; changes: PluginChange[] | null } | null>(null);

  if (list.isPending) {
    return (
      <DelayedSkeleton label={t('common.loading')}>
        <List>
          {[0, 1].map((index) => (
            <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="45%" height={12} />} subtitle={<Skeleton width="70%" height={10} />} />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }
  if (!list.data) return <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />;

  const { plugins, isolation, sourceDirectoryConfigured } = list.data;
  // The sheets show the plugin as the server last described it.
  const opened = plugins.find((plugin) => plugin.id === openId) ?? null;
  if (opened && opened !== lastOpened) setLastOpened(opened);
  const reviewed = review ? (plugins.find((plugin) => plugin.id === review.plugin.id && plugin.contentHash === review.plugin.contentHash) ?? review.plugin) : null;
  const facts = isolationFacts(isolation);
  const settingsPages = contributions.data?.settingsPages ?? [];

  const startReview = (plugin: PluginSummary, changes: PluginChange[] | null) => {
    if (installing || openId !== null) {
      setQueued({ plugin, changes });
      setInstalling(false);
      setOpenId(null);
      return;
    }
    setReview({ plugin, changes });
    setReviewOpen(true);
  };
  const flushQueued = () => {
    if (!queued) return;
    setQueued(null);
    setReview(queued);
    setReviewOpen(true);
  };

  return (
    <>
      {staleness.stale && <StaleNotice since={staleness.since} />}

      <div className="pl-isolation" data-level={isolation.level}>
        <Glyph icon={isolation.level === 'sandboxed' ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />} tint={isolation.level === 'sandboxed' ? 'green' : isolation.level === 'restricted' ? 'amber' : 'red'} size={40} />
        <div className="pl-isolation__text">
          <p className="pl-isolation__eyebrow">{t('plugins.isolation.title')}</p>
          <p className="pl-isolation__level">{t(ISOLATION_LABELS[isolation.level])}</p>
          <p className="pl-isolation__detail">{isolation.detail}</p>
          {facts.kept.length > 0 && <p className="pl-isolation__facts">{t('plugins.isolation.kept', { things: t.list(facts.kept.map((key) => t(key))) })}</p>}
          {facts.notKept.length > 0 && (
            <p className="pl-isolation__facts" data-tone="warning">
              {t('plugins.isolation.notKept', { things: t.list(facts.notKept.map((key) => t(key))) })}
            </p>
          )}
          {isolation.unsandboxedAllowed && <p className="pl-isolation__facts" data-tone="danger">{t('plugins.isolation.unsandboxedAllowed')}</p>}
        </div>
      </div>

      {plugins.length === 0 ? (
        <EmptyState
          icon={<Puzzle size={28} />}
          title={t('plugins.empty.title')}
          description={t('plugins.empty.text')}
          action={
            <Button variant="tinted" icon={<Plus size={18} />} onClick={() => setInstalling(true)}>
              {t('plugins.install.open')}
            </Button>
          }
        />
      ) : (
        <List
          header={t('plugins.installed')}
          headerAction={
            <Button size="sm" variant="plain" icon={<Plus size={16} />} onClick={() => setInstalling(true)}>
              {t('plugins.install.open')}
            </Button>
          }
          footer={t('plugins.installedFooter')}
        >
          {plugins.map((plugin) => {
            const state = pluginState(plugin);
            const Icon = pluginIcon(plugin.contributes.panels[0]?.icon ?? 'puzzle');
            return (
              <ListRow
                key={plugin.id}
                leading={<Glyph icon={<Icon size={18} />} tint={tintFor(plugin.id)} />}
                title={plugin.name}
                subtitle={[t('plugins.version', { version: plugin.version }), plugin.source.kind === 'directory' ? t('plugins.source.short.directory') : t('plugins.source.short.git')].join(' · ')}
                trailing={<Badge tone={TONE_BADGE[state.tone]}>{t(state.label)}</Badge>}
                onPress={() => setOpenId(plugin.id)}
                chevron
              />
            );
          })}
        </List>
      )}

      {settingsPages.length > 0 && (
        <List header={t('plugins.pages.title')} footer={t('plugins.pages.footer')}>
          {settingsPages.map((page) => {
            const Icon = pluginIcon(page.icon);
            return (
              <ListRow
                key={`${page.pluginId}/${page.panelId}`}
                leading={<Glyph icon={<Icon size={18} />} tint={tintFor(page.pluginId)} />}
                title={page.title}
                subtitle={page.pluginName}
                to={`${settingsPath('plugin-page')}/${encodeURIComponent(page.pluginId)}/${encodeURIComponent(page.panelId)}`}
              />
            );
          })}
        </List>
      )}

      <InstallSheet
        open={installing}
        onClose={() => setInstalling(false)}
        sourceDirectoryConfigured={sourceDirectoryConfigured}
        onInstalled={(plugin) => startReview(plugin, null)}
        onClosed={flushQueued}
      />
      <PluginSheet plugin={opened ?? lastOpened} isolation={isolation} open={opened !== null} onClose={() => setOpenId(null)} onReview={startReview} onClosed={flushQueued} />
      <ReviewSheet
        plugin={reviewed}
        isolation={isolation}
        changes={review?.changes ?? null}
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onDone={() => setReviewOpen(false)}
      />
    </>
  );
}
