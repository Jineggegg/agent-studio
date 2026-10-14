import type { PluginIsolation, PluginSummary } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CircleSlash, Download, Power, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Badge, Banner, Button, Checkbox, List, ListRow, Sheet, toast } from '@/ui';
import { pluginKeys, pluginsApi } from './api';
import { REASON_LABELS, SLOT_LABELS, type PluginChange, hostOf, permissionWords, pluginChanges, pluginState } from './words';

export interface PluginSheetProps {
  plugin: PluginSummary | null;
  isolation: PluginIsolation | null;
  open: boolean;
  onClose: () => void;
  /** Open the review: before enabling, and after an update that needs approval again. */
  onReview: (plugin: PluginSummary, changes: PluginChange[] | null) => void;
  /** The sheet has finished leaving. */
  onClosed?: () => void;
}

const TONE_BADGE = { neutral: 'neutral', positive: 'positive', warning: 'warning', danger: 'danger' } as const;

/** One plugin: what it is, where it came from, what it brings and asks for, and what can be done with it. */
export function PluginSheet({ plugin, isolation, open, onClose, onReview, onClosed }: PluginSheetProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'disable' | 'update' | 'uninstall' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);

  const identity = plugin && open ? plugin.id : null;
  if (identity !== shownFor) {
    setShownFor(identity);
    setProblem(null);
    setRemoving(false);
    setDeleteData(false);
  }
  if (!plugin) return null;

  const state = pluginState(plugin);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
  const fail = (error: unknown) => {
    if (isApiError(error) && error.code === 'reauth_cancelled') return;
    setProblem(describeError(error, t));
  };

  const disable = async () => {
    setBusy('disable');
    setProblem(null);
    try {
      await pluginsApi.disable(plugin.id);
      refresh();
      toast.success(t('plugins.disabled', { name: plugin.name }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const update = async () => {
    setBusy('update');
    setProblem(null);
    try {
      const updated = await pluginsApi.update(plugin.id);
      refresh();
      const changes = pluginChanges(plugin, updated);
      if (updated.contentHash === plugin.contentHash) toast.show({ title: t('plugins.update.current', { name: plugin.name, version: plugin.version }) });
      else if (updated.status === 'needs-approval') onReview(updated, changes);
      else toast.success(t('plugins.update.done', { name: updated.name, version: updated.version }));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async () => {
    setBusy('uninstall');
    setProblem(null);
    try {
      await pluginsApi.uninstall(plugin.id, deleteData);
      refresh();
      toast.success(deleteData ? t('plugins.uninstalled.withData', { name: plugin.name }) : t('plugins.uninstalled', { name: plugin.name }));
      onClose();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const source =
    plugin.source.kind === 'directory'
      ? t('plugins.source.directory', { name: plugin.source.name })
      : [plugin.source.url, plugin.source.ref, plugin.source.commit?.slice(0, 10)].filter(Boolean).join(' · ');

  if (removing) {
    return (
      <Sheet
        open={open}
        onClose={() => setRemoving(false)}
        title={t('plugins.uninstall.title', { name: plugin.name })}
        role="alertdialog"
        dismissible={busy === null}
        {...(onClosed ? { onClosed } : {})}
        footer={
          <>
            <Button variant="danger" onClick={() => void uninstall()} loading={busy === 'uninstall'}>
              {t('plugins.uninstall.confirm')}
            </Button>
            <Button variant="plain" onClick={() => setRemoving(false)} disabled={busy !== null}>
              {t('common.cancel')}
            </Button>
          </>
        }
      >
        <div className="pl-review">
          <p className="pl-review__text">{t('plugins.uninstall.text')}</p>
          <Checkbox checked={deleteData} onChange={setDeleteData} disabled={busy !== null} label={t('plugins.uninstall.deleteData')} hint={deleteData ? t('plugins.uninstall.deleteDataOn') : t('plugins.uninstall.deleteDataOff')} />
          {problem && (
            <Banner tone="danger" role="alert">
              {problem}
            </Banner>
          )}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={plugin.name} size="lg" dismissible={busy === null} {...(onClosed ? { onClosed } : {})}>
      <div className="pl-detail">
        <div className="pl-detail__head">
          <Badge tone={TONE_BADGE[state.tone]}>{t(state.label)}</Badge>
          <span className="pl-detail__version u-tabular">{t('plugins.version', { version: plugin.version })}</span>
        </div>
        {plugin.description && <p className="pl-detail__description">{plugin.description}</p>}
        {state.detail && <p className="pl-review__text">{t(state.detail)}</p>}
        {plugin.statusDetail && (
          <Banner tone={plugin.status === 'crashed' || plugin.status === 'blocked-no-sandbox' ? 'danger' : 'info'} title={t('plugins.serverSays')}>
            {plugin.statusDetail}
          </Banner>
        )}
        {plugin.approval.state === 'stale' && plugin.approval.reasons.length > 0 && (
          <p className="pl-review__text" data-tone="warning">
            {t('plugins.changedSinceApproval', { reasons: t.list(plugin.approval.reasons.map((reason) => t(REASON_LABELS[reason]))) })}
          </p>
        )}
        {problem && (
          <Banner tone="danger" role="alert">
            {problem}
          </Banner>
        )}

        <div className="pl-detail__actions">
          {plugin.enabled ? (
            <Button variant="neutral" icon={<CircleSlash size={18} />} onClick={() => void disable()} loading={busy === 'disable'} disabled={busy !== null}>
              {t('plugins.action.disable')}
            </Button>
          ) : (
            <Button variant="primary" icon={<Power size={18} />} onClick={() => onReview(plugin, null)} disabled={busy !== null}>
              {plugin.approval.state === 'none' ? t('plugins.action.review') : t('plugins.action.enable')}
            </Button>
          )}
          <Button variant="neutral" icon={<Download size={18} />} onClick={() => void update()} loading={busy === 'update'} disabled={busy !== null}>
            {t('plugins.action.update')}
          </Button>
          <Button variant="plain-danger" icon={<Trash2 size={18} />} onClick={() => setRemoving(true)} disabled={busy !== null}>
            {t('plugins.action.uninstall')}
          </Button>
        </div>

        {plugin.status === 'crashed' && plugin.logTail.length > 0 && (
          <section className="pl-review__section" aria-labelledby="pl-log">
            <h3 id="pl-log" className="pl-review__heading">
              {t('plugins.log')}
            </h3>
            <pre className="pl-log" tabIndex={0}>
              {plugin.logTail.join('\n')}
            </pre>
          </section>
        )}

        <List header={t('plugins.detail.permissions')} footer={plugin.permissions.requested.length === 0 ? t('plugins.review.noPermissions') : undefined}>
          {plugin.permissions.requested.map((permission) => {
            const words = permissionWords(permission, t);
            const granted = plugin.permissions.granted.includes(permission);
            return <ListRow key={permission} title={words.title} subtitle={words.text} trailing={<Badge tone={granted ? 'positive' : 'neutral'}>{granted ? t('plugins.granted') : t('plugins.notGranted')}</Badge>} />;
          })}
        </List>

        {(plugin.contributes.tools.length > 0 || plugin.contributes.panels.length > 0 || plugin.contributes.linkTiles.length > 0 || plugin.contributes.hooks.length > 0) && (
          <List header={t('plugins.review.brings')}>
            {plugin.contributes.tools.map((tool) => (
              <ListRow key={`tool:${tool.name}`} title={<span className="u-mono">{tool.registeredName}</span>} subtitle={tool.description} value={tool.effect === 'read' ? t('plugins.tool.readShort') : t('plugins.tool.writeShort')} />
            ))}
            {plugin.contributes.panels.map((panel) => (
              <ListRow key={`panel:${panel.id}`} title={panel.title} subtitle={t.list(panel.slots.map((slot) => t(SLOT_LABELS[slot])))} />
            ))}
            {plugin.contributes.linkTiles.map((link) => (
              <ListRow key={`link:${link.id}`} leading={<ArrowUpRight size={18} />} title={link.title} subtitle={hostOf(link.url)} />
            ))}
            {plugin.contributes.hooks.length > 0 && <ListRow title={t('plugins.detail.hooks')} subtitle={t.list([...plugin.contributes.hooks])} />}
          </List>
        )}

        <List header={t('plugins.detail.about')}>
          <ListRow title={t('plugins.detail.source')} subtitle={<span className="u-mono pl-detail__source">{source}</span>} />
          {plugin.author && <ListRow title={t('plugins.detail.author')} value={plugin.author} />}
          {plugin.license && <ListRow title={t('plugins.detail.license')} value={plugin.license} />}
          {plugin.homepage && (
            <ListRow
              title={t('plugins.detail.homepage')}
              subtitle={
                <a className="pl-link" href={plugin.homepage} target="_blank" rel="noopener noreferrer">
                  {hostOf(plugin.homepage)}
                </a>
              }
            />
          )}
          <ListRow title={t('plugins.detail.installed')} value={t.date(plugin.installedAt, 'dateTime')} />
          {plugin.approval.approvedAt && (
            <ListRow
              leading={<ShieldCheck size={18} />}
              title={t('plugins.detail.approved')}
              value={t.date(plugin.approval.approvedAt, 'dateTime')}
              subtitle={plugin.approval.isolation && isolation && plugin.approval.isolation !== isolation.level ? t('plugins.detail.approvedUnder', { level: plugin.approval.isolation }) : undefined}
            />
          )}
          {plugin.retainedData && <ListRow title={t('plugins.detail.retainedData')} subtitle={t('plugins.detail.retainedDataText')} />}
        </List>
      </div>
    </Sheet>
  );
}
