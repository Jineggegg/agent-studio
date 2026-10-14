import type { PluginIsolation, PluginPermission, PluginSummary } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Bell, Code, FolderSearch, Globe, Network, Puzzle, ShieldCheck, Wrench } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Badge, Banner, Button, Checkbox, Sheet, toast } from '@/ui';
import { pluginKeys, pluginsApi } from './api';
import { ISOLATION_LABELS, REASON_LABELS, RISK_LABELS, SLOT_LABELS, type PluginChange, changeText, hostOf, isolationFacts, permissionWords, widens } from './words';

export interface ReviewSheetProps {
  plugin: PluginSummary | null;
  isolation: PluginIsolation | null;
  /** What an update just changed, when the review follows one. */
  changes: readonly PluginChange[] | null;
  open: boolean;
  onClose: () => void;
  /** The server answered with the plugin as it now is. */
  onDone: (plugin: PluginSummary) => void;
}

const PERMISSION_ICONS = {
  notifications: <Bell size={18} aria-hidden="true" />,
  'projects:read': <FolderSearch size={18} aria-hidden="true" />,
  network: <Network size={18} aria-hidden="true" />,
} as const;

function permissionIcon(permission: PluginPermission): ReactNode {
  if (permission === 'notifications' || permission === 'projects:read' || permission === 'network') return PERMISSION_ICONS[permission];
  return <Globe size={18} aria-hidden="true" />;
}

/**
 * The owner's review before a plugin may run: what it asks for, each
 * permission in plain words with its risk, how well this machine contains
 * it, and — after an update — what changed. Approving names exactly what was
 * reviewed (the permissions ticked, the files' hash, the isolation shown); if
 * any of that has moved on, the server refuses and the review is shown again.
 */
export function ReviewSheet({ plugin, isolation, changes, open, onClose, onDone }: ReviewSheetProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Each time the sheet opens on a plugin (or the plugin's files change), start from what it asks for.
  const identity = plugin && open ? `${plugin.id}:${plugin.contentHash}` : null;
  if (identity !== shownFor) {
    setShownFor(identity);
    setGranted(new Set(plugin?.permissions.requested ?? []));
    setProblem(null);
  }

  if (!plugin) return null;
  const requested = plugin.permissions.requested;
  const facts = isolation ? isolationFacts(isolation) : null;
  const networkUncontained = isolation !== null && !isolation.restricts.network;
  const cannotRun = isolation !== null && plugin.hasServer && isolation.level === 'none' && !isolation.unsandboxedAllowed;

  const approve = async () => {
    if (busy || !isolation) return;
    setBusy(true);
    setProblem(null);
    try {
      const updated = await pluginsApi.enable(plugin.id, { permissions: requested.filter((permission) => granted.has(permission)), contentHash: plugin.contentHash, isolation: isolation.level });
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      toast.success(t('plugins.enabled', { name: plugin.name }));
      onDone(updated);
    } catch (error) {
      if (isApiError(error) && error.code === 'reauth_cancelled') return;
      if (isApiError(error) && (error.code === 'plugin_changed' || error.code === 'isolation_changed')) {
        // What was reviewed is no longer what is there: show it again, as it now is.
        setProblem(t('plugins.review.changedSince'));
        void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      } else {
        setProblem(describeError(error, t));
      }
    } finally {
      setBusy(false);
    }
  };

  const { tools, panels, linkTiles, hooks } = plugin.contributes;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('plugins.review.title', { name: plugin.name })}
      size="lg"
      dismissible={!busy}
      footer={
        <>
          <Button variant="primary" onClick={() => void approve()} loading={busy} disabled={cannotRun || !isolation}>
            {t('plugins.review.approve')}
          </Button>
          <Button variant="plain" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
        </>
      }
    >
      <div className="pl-review">
        <p className="pl-review__lead">{t('plugins.review.lead', { name: plugin.name, version: plugin.version, author: plugin.author || t('plugins.unknownAuthor') })}</p>
        {problem && (
          <Banner tone="warning" role="alert">
            {problem}
          </Banner>
        )}

        {plugin.approval.state === 'stale' && plugin.approval.reasons.length > 0 && !changes?.length && (
          <Banner tone="info" title={t('plugins.review.changedTitle')}>
            {t.list(plugin.approval.reasons.map((reason) => t(REASON_LABELS[reason])))}
          </Banner>
        )}
        {changes && changes.length > 0 && (
          <section className="pl-review__section" aria-labelledby="pl-review-changes">
            <h3 id="pl-review-changes" className="pl-review__heading">
              {t('plugins.review.whatChanged')}
            </h3>
            <ul className="pl-changes">
              {changes.map((change, index) => (
                <li key={index} data-widens={widens(change) || undefined}>
                  {changeText(change, t)}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="pl-review__section" aria-labelledby="pl-review-permissions">
          <h3 id="pl-review-permissions" className="pl-review__heading">
            {t('plugins.review.permissions')}
          </h3>
          {requested.length === 0 ? (
            <p className="pl-review__text">{t('plugins.review.noPermissions')}</p>
          ) : (
            <ul className="pl-permissions">
              {requested.map((permission) => {
                const words = permissionWords(permission, t);
                const added = changes?.some((change) => change.kind === 'permission-added' && change.permission === permission) ?? false;
                return (
                  <li key={permission} className="pl-permission" data-risk={words.risk}>
                    <span className="pl-permission__icon">{permissionIcon(permission)}</span>
                    <div className="pl-permission__body">
                      <Checkbox
                        checked={granted.has(permission)}
                        disabled={busy}
                        onChange={(on) =>
                          setGranted((current) => {
                            const next = new Set(current);
                            if (on) next.add(permission);
                            else next.delete(permission);
                            return next;
                          })
                        }
                        label={
                          <span className="pl-permission__title">
                            {words.title}
                            <Badge tone={words.risk === 'high' ? 'danger' : words.risk === 'medium' ? 'warning' : 'neutral'}>{t(RISK_LABELS[words.risk])}</Badge>
                            {added && <Badge tone="accent">{t('plugins.review.new')}</Badge>}
                          </span>
                        }
                        hint={words.text}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {requested.length > 0 && <p className="pl-review__note">{t('plugins.review.subsetNote')}</p>}
        </section>

        <section className="pl-review__section" aria-labelledby="pl-review-brings">
          <h3 id="pl-review-brings" className="pl-review__heading">
            {t('plugins.review.brings')}
          </h3>
          <ul className="pl-brings">
            {!plugin.hasServer && (
              <li>
                <Puzzle size={17} aria-hidden="true" />
                <span>{t('plugins.review.noServer')}</span>
              </li>
            )}
            {tools.map((tool) => (
              <li key={tool.name}>
                <Wrench size={17} aria-hidden="true" />
                <span>
                  <strong className="u-mono">{tool.registeredName}</strong> — {tool.effect === 'read' ? t('plugins.tool.read') : t('plugins.tool.write')}
                  <span className="pl-brings__detail">{tool.description}</span>
                </span>
              </li>
            ))}
            {panels.map((panel) => (
              <li key={panel.id}>
                <Code size={17} aria-hidden="true" />
                <span>
                  {t('plugins.review.panel', { title: panel.title, where: t.list(panel.slots.map((slot) => t(SLOT_LABELS[slot]))) })}
                </span>
              </li>
            ))}
            {linkTiles.map((link) => (
              <li key={link.id}>
                <ArrowUpRight size={17} aria-hidden="true" />
                <span>{t('plugins.review.link', { title: link.title, host: hostOf(link.url) })}</span>
              </li>
            ))}
            {hooks.length > 0 && (
              <li>
                <Bell size={17} aria-hidden="true" />
                <span>{t('plugins.review.hooks', { events: t.list([...hooks]) })}</span>
              </li>
            )}
          </ul>
        </section>

        {isolation && facts && (
          <section className="pl-review__section" aria-labelledby="pl-review-isolation">
            <h3 id="pl-review-isolation" className="pl-review__heading">
              <ShieldCheck size={17} aria-hidden="true" />
              {t('plugins.review.isolation', { level: t(ISOLATION_LABELS[isolation.level]) })}
            </h3>
            <p className="pl-review__text">{isolation.detail}</p>
            {facts.notKept.length > 0 && (
              <p className="pl-review__text" data-tone="warning">
                {t('plugins.review.notKept', { things: t.list(facts.notKept.map((key) => t(key))) })}
              </p>
            )}
            {networkUncontained && plugin.hasServer && <p className="pl-review__text" data-tone="warning">{t('plugins.review.networkUncontained')}</p>}
            {cannotRun && (
              <Banner tone="danger" title={t('plugins.review.cannotRun')}>
                {t('plugins.review.cannotRunText')}
              </Banner>
            )}
          </section>
        )}
        <p className="pl-review__note">{t('plugins.review.trust')}</p>
      </div>
    </Sheet>
  );
}
