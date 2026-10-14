import { REMOTE_DIRECTORY_MAX_LENGTH, REMOTE_LAUNCHERS, REMOTE_TOOLS, type RemoteHost, type RemoteHostStatus, type TerminalSession, isSafeRemoteDirectory } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, Server, SquareTerminal, X } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useProjects } from '@/data/projects';
import { terminalApi, terminalKeys } from '@/features/terminal/api';
import { TerminalSheet, type TerminalSheetTarget } from '@/features/terminal/TerminalSheet';
import { type MessageKey, useT } from '@/i18n';
import { Badge, Banner, Button, DelayedSkeleton, EmptyState, ErrorState, Form, IconButton, List, ListRow, Select, Sheet, Skeleton, Spinner, TextField, confirm, toast } from '@/ui';
import { remotesApi, remotesKeys } from './api';
import './remotes.css';

/** Why a machine could not be checked, in words. Every code the server defines is here (a test holds this true). */
export const failureKey = (code: NonNullable<RemoteHostStatus['failure']>['code']): MessageKey => `remotes.failure.${code}`;

function HostCard({ host, hosts, sessions, onOpen, onAttach }: { host: RemoteHost; hosts: readonly RemoteHost[]; sessions: readonly TerminalSession[]; onOpen: (host: RemoteHost) => void; onAttach: (session: TerminalSession) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: remotesKeys.status(host.id), queryFn: ({ signal }) => remotesApi.status(host.id, false, signal), staleTime: 60_000, retry: false });
  const [checking, setChecking] = useState(false);
  const via = host.viaHostId ? (hosts.find((entry) => entry.id === host.viaHostId)?.name ?? host.viaHostId) : null;

  const recheck = async () => {
    setChecking(true);
    try {
      queryClient.setQueryData(remotesKeys.status(host.id), await remotesApi.status(host.id, true));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setChecking(false);
    }
  };

  const close = async (session: TerminalSession) => {
    const agreed = await confirm({ title: t('terminal.close.title', { title: session.title }), message: t('remotes.session.closeMessage'), confirmLabel: t('terminal.close.confirm'), tone: 'danger' });
    if (!agreed) return;
    try {
      await terminalApi.close(session.id);
    } catch (error) {
      if (!(isApiError(error) && error.gone)) toast.error(describeError(error, t));
    }
    void queryClient.invalidateQueries({ queryKey: terminalKeys.all });
  };

  const data = status.data;
  const badge = status.isPending ? (
    <span className="remotes-checking">
      <Spinner size={14} /> {t('remotes.checking')}
    </span>
  ) : !data ? (
    <Badge>{t('remotes.unknown')}</Badge>
  ) : data.reachable ? (
    <Badge tone="positive">{data.latencyMs === null ? t('remotes.online') : t('remotes.onlineMs', { ms: t.number(data.latencyMs) })}</Badge>
  ) : (
    <Badge tone="danger">{t('remotes.offline')}</Badge>
  );

  return (
    <List
      header={host.name}
      headerAction={
        <span className="remotes-head">
          {badge}
          <IconButton label={t('remotes.recheck', { name: host.name })} icon={<RefreshCw size={18} />} tone="secondary" busy={checking || status.isFetching} onClick={() => void recheck()} />
        </span>
      }
      footer={
        data && !data.reachable && data.failure ? (
          <>
            {t(failureKey(data.failure.code))}
            {/* The server's own wording is worth adding only where the code says little by itself. */}
            {(data.failure.code === 'ssh_failed' || data.failure.code === 'unexpected_output') && <span className="remotes-said"> {data.failure.message}</span>}
          </>
        ) : status.isError ? (
          describeError(status.error, t)
        ) : data?.tools && !data.tools.tmux ? (
          t('remotes.noTmux')
        ) : data ? (
          t('remotes.checked', { when: t.relative(data.checkedAt) })
        ) : undefined
      }
    >
      <ListRow leading={<Server size={20} />} title={<span className="u-mono">{host.target}</span>} subtitle={via ? t('remotes.via', { host: via }) : host.defaultDirectory ? t('remotes.startsIn', { directory: host.defaultDirectory }) : undefined} />
      {data?.tools && (
        <div className="remotes-tools" role="listitem" aria-label={t('remotes.tools')}>
          {REMOTE_TOOLS.map((tool) => (
            <span key={tool} className="remotes-tool" data-found={data.tools![tool] || undefined}>
              {data.tools![tool] ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
              <span className="u-mono">{tool}</span>
              <span className="visually-hidden">{data.tools![tool] ? t('remotes.tool.found') : t('remotes.tool.missing')}</span>
            </span>
          ))}
        </div>
      )}
      {sessions.map((session) => (
        <ListRow
          key={session.id}
          leading={<SquareTerminal size={20} />}
          title={session.title}
          subtitle={session.directory ? t('remotes.session.in', { directory: session.directory }) : t('remotes.session.running')}
          onPress={() => onAttach(session)}
          chevron
          // A swipe shows this in a narrow strip; the question that follows names the terminal and the machine.
          actions={[{ id: 'close', label: t('common.close'), icon: <X size={18} />, tone: 'danger', onSelect: () => void close(session) }]}
          actionsLabel={t('remotes.session.actions', { title: session.title })}
        />
      ))}
      <ListRow leading={<SquareTerminal size={20} />} title={t('remotes.open')} tone="accent" onPress={() => onOpen(host)} disabled={data !== undefined && !data.reachable} />
    </List>
  );
}

/**
 * The machines this server can reach over SSH, as its operator listed them.
 * Nothing here adds or changes a machine: that is done in a file on the
 * server, so a browser can never name a host, a key or a command.
 */
export default function RemotesPage() {
  const t = useT();
  const hosts = useQuery({ queryKey: remotesKeys.hosts, queryFn: ({ signal }) => remotesApi.hosts(signal), staleTime: 30_000 });
  const sessions = useQuery({ queryKey: terminalKeys.sessions(null), queryFn: ({ signal }) => terminalApi.sessions(null, signal), staleTime: 10_000, retry: false });
  // The server ties every terminal that is not an agent's sign-in to a project: a shell on another machine is listed with that project's terminals.
  const capability = useQuery({ queryKey: terminalKeys.capability, queryFn: ({ signal }) => terminalApi.capability(signal), staleTime: 20_000 });
  const needsProject = capability.data?.launchers.find((launcher) => launcher.key === REMOTE_LAUNCHERS.shell)?.requiresProject ?? true;
  const projects = useProjects({ enabled: needsProject });
  const [projectId, setProjectId] = useState<string | null>(null);
  const chosenProject = projects.data?.find((project) => project.id === projectId) ?? projects.data?.[0] ?? null;
  const [choosing, setChoosing] = useState<RemoteHost | null>(null);
  const [shownHost, setShownHost] = useState<RemoteHost | null>(null);
  if (choosing && choosing !== shownHost) setShownHost(choosing);
  const [directory, setDirectory] = useState('');
  const [directoryProblem, setDirectoryProblem] = useState<string | undefined>();
  const [sheet, setSheet] = useState<{ target: TerminalSheetTarget; title: string; note: string } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (hosts.isPending) {
    return (
      <DelayedSkeleton label={t('remotes.reading')}>
        <List>
          {[0, 1].map((index) => (
            <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="45%" height={12} />} subtitle={<Skeleton width="65%" height={10} />} />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }
  // A list that could not be read is said to be unread — never shown as "no machines".
  if (!hosts.data) return <ErrorState error={hosts.error} onRetry={() => void hosts.refetch()} retrying={hosts.isFetching} />;

  const { configuration } = hosts.data;
  const remoteSessions = (sessions.data ?? []).filter((session) => session.alive && session.remoteHostId !== null);

  const start = (host: RemoteHost) => {
    setChoosing(host);
    setDirectory(host.defaultDirectory ?? '');
    setDirectoryProblem(undefined);
  };
  const open = () => {
    if (!choosing) return;
    const wanted = directory.trim();
    if (wanted !== '' && !isSafeRemoteDirectory(wanted)) return setDirectoryProblem(t('remotes.directory.problem'));
    if (needsProject && !chosenProject) return setDirectoryProblem(t('remotes.directory.noProject'));
    setSheet({
      target: { start: { launcher: REMOTE_LAUNCHERS.shell, remote: { hostId: choosing.id, ...(wanted ? { directory: wanted } : {}) }, ...(needsProject && chosenProject ? { projectId: chosenProject.id } : {}) } },
      title: t('remotes.sheet.title', { name: choosing.name }),
      note: t('remotes.sheet.note', { name: choosing.name }),
    });
    setChoosing(null);
    setSheetOpen(true);
  };

  return (
    <>
      {configuration.status === 'invalid' && (
        <Banner tone="danger" title={t('remotes.invalid.title')}>
          {t('remotes.invalid.text')}
          {configuration.message && <span className="remotes-said remotes-said--block">{configuration.message}</span>}
        </Banner>
      )}
      {hosts.data.hosts.length === 0 ? (
        <EmptyState icon={<Server size={28} />} title={t('remotes.empty.title')} description={configuration.status === 'missing' ? t('remotes.empty.missing') : t('remotes.empty.text')} />
      ) : (
        hosts.data.hosts.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            hosts={hosts.data.hosts}
            sessions={remoteSessions.filter((session) => session.remoteHostId === host.id)}
            onOpen={start}
            onAttach={(session) => {
              setSheet({ target: { attach: session.id }, title: session.title, note: t('remotes.sheet.note', { name: host.name }) });
              setSheetOpen(true);
            }}
          />
        ))
      )}

      <section className="remotes-how" aria-label={t('remotes.how.title')}>
        <h2>{t('remotes.how.title')}</h2>
        <p>{t('remotes.how.text')}</p>
        <p className="remotes-how__file u-mono">{configuration.file}</p>
        <p>{t('remotes.how.keys')}</p>
      </section>

      <Sheet
        open={choosing !== null}
        onClose={() => setChoosing(null)}
        title={shownHost ? t('remotes.directory.title', { name: shownHost.name }) : ''}
        size="sm"
        leading={
          <Button variant="plain" onClick={() => setChoosing(null)}>
            {t('common.cancel')}
          </Button>
        }
        trailing={
          <Button variant="plain" onClick={open}>
            {t('remotes.directory.open')}
          </Button>
        }
      >
        <Form className="remotes-open" onSubmit={open}>
          {needsProject && chosenProject && (projects.data?.length ?? 0) > 0 && (
            <div className="remotes-open__project">
              <span id="remotes-project-label">{t('remotes.directory.project')}</span>
              <Select label={t('remotes.directory.project')} value={chosenProject.id} onChange={setProjectId} options={(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))} block />
              <p>{t('remotes.directory.projectHint')}</p>
            </div>
          )}
          <TextField
            label={t('remotes.directory.label')}
            optional
            value={directory}
            onChange={(value) => {
              setDirectory(value);
              setDirectoryProblem(undefined);
            }}
            error={directoryProblem}
            hint={t('remotes.directory.hint')}
            placeholder="/home/me/project"
            mono
            maxLength={REMOTE_DIRECTORY_MAX_LENGTH}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="go"
            data-autofocus=""
          />
          <button type="submit" hidden />
        </Form>
      </Sheet>

      <TerminalSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={sheet?.title ?? ''}
        note={sheet?.note ?? ''}
        target={sheet?.target ?? null}
        onDone="detach"
        onFinished={() => void sessions.refetch()}
      />
    </>
  );
}
