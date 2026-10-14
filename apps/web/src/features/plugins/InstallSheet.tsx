import type { PluginSummary } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, GitBranch, Puzzle } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Badge, Banner, Button, EmptyState, ErrorState, Form, List, ListRow, LoadingRow, SegmentedControl, Sheet, TextField } from '@/ui';
import { pluginKeys, pluginsApi } from './api';

export interface InstallSheetProps {
  open: boolean;
  onClose: () => void;
  /** Installed (and not yet allowed to run): the review comes next. */
  onInstalled: (plugin: PluginSummary) => void;
  /** Whether the operator set aside a folder of plugins. */
  sourceDirectoryConfigured: boolean;
  /** The sheet has finished leaving: the next one may come up. */
  onClosed?: () => void;
}

/** A repository address the server will consider: https, a host, no credentials, no options. Checked again there. */
export function gitAddressProblem(value: string): 'empty' | 'scheme' | 'credentials' | 'option' | null {
  const text = value.trim();
  if (text === '') return 'empty';
  if (text.startsWith('-')) return 'option';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'scheme';
  }
  if (url.protocol !== 'https:' || url.hostname === '') return 'scheme';
  if (url.username !== '' || url.password !== '') return 'credentials';
  return null;
}

const GIT_PROBLEMS = {
  empty: 'plugins.install.git.empty',
  scheme: 'plugins.install.git.scheme',
  credentials: 'plugins.install.git.credentials',
  option: 'plugins.install.git.option',
} as const;

/**
 * Installing a plugin: from the folder the operator set aside on the server,
 * or from a public https Git address. Nothing runs at install time; a new
 * plugin waits, off, for the owner's review.
 */
export function InstallSheet({ open, onClose, onInstalled, sourceDirectoryConfigured, onClosed }: InstallSheetProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'directory' | 'git'>(sourceDirectoryConfigured ? 'directory' : 'git');
  const [address, setAddress] = useState('');
  const [ref, setRef] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sources = useQuery({ queryKey: pluginKeys.sources, queryFn: ({ signal }) => pluginsApi.sources(signal), enabled: open && mode === 'directory', staleTime: 10_000 });

  const install = async (request: Parameters<typeof pluginsApi.install>[0], key: string) => {
    if (installing) return;
    setInstalling(key);
    setProblem(null);
    try {
      const plugin = await pluginsApi.install(request);
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      setAddress('');
      setRef('');
      onInstalled(plugin);
    } catch (error) {
      if (isApiError(error) && error.code === 'reauth_cancelled') return;
      setProblem(describeError(error, t));
    } finally {
      setInstalling(null);
    }
  };

  const installFromGit = () => {
    const issue = gitAddressProblem(address);
    if (issue) return setAddressError(t(GIT_PROBLEMS[issue]));
    void install({ source: { kind: 'git', url: address.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) } }, 'git');
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('plugins.install.title')} size="lg" dismissible={installing === null} {...(onClosed ? { onClosed } : {})}>
      <div className="pl-install">
        <Banner tone="warning" title={t('plugins.install.trustTitle')}>
          {t('plugins.install.trust')}
        </Banner>
        <SegmentedControl
          label={t('plugins.install.from')}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setProblem(null);
          }}
          options={[
            { value: 'directory', label: t('plugins.install.fromFolder'), icon: <FolderOpen size={16} aria-hidden="true" /> },
            { value: 'git', label: t('plugins.install.fromGit'), icon: <GitBranch size={16} aria-hidden="true" /> },
          ]}
        />
        {problem && (
          <Banner tone="danger" role="alert">
            {problem}
          </Banner>
        )}
        {mode === 'directory' ? (
          !sourceDirectoryConfigured ? (
            <EmptyState compact icon={<FolderOpen size={26} />} title={t('plugins.install.noFolder')} description={t('plugins.install.noFolderText')} />
          ) : sources.isPending ? (
            <LoadingRow label={t('common.loading')} />
          ) : !sources.data ? (
            <ErrorState compact error={sources.error} onRetry={() => void sources.refetch()} retrying={sources.isFetching} />
          ) : sources.data.entries.length === 0 ? (
            <EmptyState compact icon={<Puzzle size={26} />} title={t('plugins.install.folderEmpty')} description={t('plugins.install.folderEmptyText')} />
          ) : (
            <List footer={t('plugins.install.folderFooter')}>
              {sources.data.entries.map((entry) => (
                <ListRow
                  key={entry.name}
                  leading={<Puzzle size={20} />}
                  title={entry.title ?? entry.name}
                  subtitle={entry.valid ? [entry.version ? t('plugins.version', { version: entry.version }) : null, entry.description].filter(Boolean).join(' · ') : (entry.problem ?? t('plugins.install.invalid'))}
                  trailing={
                    entry.installed ? (
                      <Badge tone="positive">{t('plugins.install.installed')}</Badge>
                    ) : entry.valid ? (
                      <Button size="sm" variant="tinted" loading={installing === entry.name} disabled={installing !== null} onClick={() => void install({ source: { kind: 'directory', name: entry.name } }, entry.name)}>
                        {t('plugins.install.action')}
                      </Button>
                    ) : (
                      <Badge tone="warning">{t('plugins.install.unusable')}</Badge>
                    )
                  }
                />
              ))}
            </List>
          )
        ) : (
          <Form className="pl-install__git" onSubmit={installFromGit}>
            <TextField
              label={t('plugins.install.git.address')}
              value={address}
              onChange={(value) => {
                setAddress(value);
                setAddressError(null);
              }}
              placeholder="https://github.com/owner/plugin"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              mono
              error={addressError ?? undefined}
              hint={t('plugins.install.git.hint')}
              disabled={installing !== null}
            />
            <TextField label={t('plugins.install.git.ref')} optional value={ref} onChange={setRef} placeholder="main" autoCapitalize="off" autoCorrect="off" spellCheck={false} mono disabled={installing !== null} />
            <Button type="submit" variant="primary" loading={installing === 'git'} loadingLabel={t('plugins.install.downloading')} block>
              {t('plugins.install.action')}
            </Button>
          </Form>
        )}
        <p className="pl-review__note">{t('plugins.install.afterNote')}</p>
      </div>
    </Sheet>
  );
}
