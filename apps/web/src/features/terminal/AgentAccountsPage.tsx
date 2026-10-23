import { AccountProfiles } from './AccountProfiles';
import type { Agent, TerminalLauncherInfo } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { Bot, KeyRound, LogIn, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useStaleness } from '@/data/connection';
import { useIsOwner } from '@/data/session';
import { useAgents } from '@/features/workbench/agents';
import { useT } from '@/i18n';
import {
  Badge,
  Button,
  DelayedSkeleton,
  EmptyState,
  ErrorState,
  Glyph,
  List,
  ListRow,
  Skeleton,
  StaleNotice,
  progress,
  tintFor,
} from '@/ui';
import { terminalApi, terminalKeys } from './api';
import { TerminalSheet } from './TerminalSheet';
import { launcherTitleKey, signInLaunchers } from './launchers';

/** For the page's row in the settings list: how many agents are ready to use. */
export function useAccountsSummary(): string | undefined {
  const t = useT();
  const agents = useAgents();
  if (!agents.data) return undefined;
  const ready = agents.data.filter(
    (agent) => agent.status.installed && agent.status.signedIn,
  ).length;
  return t('accounts.summary', { ready: t.number(ready), total: t.number(agents.data.length) });
}

function stateOf(agent: Agent): {
  tone: 'positive' | 'warning' | 'neutral';
  key: 'accounts.state.ready' | 'accounts.state.signedOut' | 'accounts.state.missing';
} {
  if (!agent.status.installed) return { tone: 'neutral', key: 'accounts.state.missing' };
  if (!agent.status.signedIn) return { tone: 'warning', key: 'accounts.state.signedOut' };
  return { tone: 'positive', key: 'accounts.state.ready' };
}

/**
 * Each agent the Studio can drive: whether its program is installed on the
 * server, which version, and which account it is signed in with — and, for
 * the owner, the agent's own sign-in, run in a terminal on the server.
 */
export default function AgentAccountsPage() {
  const t = useT();
  const isOwner = useIsOwner();
  const agents = useAgents();
  const staleness = useStaleness(agents);
  const capability = useQuery({
    queryKey: terminalKeys.capability,
    queryFn: ({ signal }) => terminalApi.capability(signal),
    staleTime: 20_000,
    enabled: isOwner,
  });
  const [signingIn, setSigningIn] = useState<{
    agent: Agent;
    launcher: TerminalLauncherInfo;
  } | null>(null);
  const [shown, setShown] = useState(signingIn);
  if (signingIn && signingIn !== shown) setShown(signingIn);

  if (agents.isPending) {
    return (
      <DelayedSkeleton label={t('common.loading')}>
        <List>
          {[0, 1].map((index) => (
            <ListRow
              key={index}
              leading={<Skeleton width={30} height={30} radius={9} />}
              title={<Skeleton width="40%" height={12} />}
              subtitle={<Skeleton width="65%" height={10} />}
            />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }
  if (!agents.data)
    return (
      <ErrorState
        error={agents.error}
        onRetry={() => void agents.refetch()}
        retrying={agents.isFetching}
      />
    );
  if (agents.data.length === 0)
    return (
      <EmptyState
        icon={<Bot size={28} />}
        title={t('accounts.empty.title')}
        description={t('accounts.empty.text')}
      />
    );

  const terminalOff = isOwner && capability.data !== undefined && !capability.data.available;

  return (
    <>
      {staleness.stale && <StaleNotice since={staleness.since} />}
      <div className="accounts__bar">
        <p className="text-footnote text-secondary">{t('accounts.intro')}</p>
        <Button
          size="sm"
          variant="neutral"
          icon={<RefreshCw size={16} />}
          loading={agents.isFetching}
          onClick={() => void progress.track(agents.refetch())}
        >
          {t('accounts.recheck')}
        </Button>
      </div>
      {agents.data.map((agent) => {
        const state = stateOf(agent);
        const launchers =
          isOwner && agent.kind === 'cli'
            ? signInLaunchers(agent.id, capability.data?.launchers ?? [])
            : [];
        // Signed out with a way in right above: the page's own words say what happens. Anything else the server
        // reports is its own sentence, said to be so.
        const signInOffered =
          launchers.length > 0 && agent.status.installed && !agent.status.signedIn;
        const footer = signInOffered
          ? t('accounts.signInHint')
          : agent.status.problem
            ? t('accounts.serverSays', { message: agent.status.problem })
            : agent.kind === 'api'
              ? t('accounts.apiNote')
              : !isOwner && agent.kind === 'cli' && !agent.status.signedIn
                ? t('accounts.memberNote')
                : undefined;
        return (
          <List
            key={agent.id}
            header={agent.displayName}
            headerAction={<Badge tone={state.tone}>{t(state.key)}</Badge>}
            footer={footer}
          >
            <ListRow
              leading={
                <Glyph
                  icon={agent.kind === 'api' ? <KeyRound size={18} /> : <Bot size={18} />}
                  tint={tintFor(agent.id)}
                />
              }
              title={agent.kind === 'api' ? t('accounts.kind.api') : t('accounts.kind.cli')}
              value={
                agent.status.installed
                  ? (agent.status.version ?? t('accounts.installed'))
                  : t('accounts.notInstalled')
              }
            />
            <ListRow
              title={t('accounts.account')}
              value={
                agent.status.signedIn
                  ? (agent.status.account ?? t('accounts.signedIn'))
                  : t('accounts.notSignedIn')
              }
            />
            {launchers.map((launcher) => {
              const titleKey = launcherTitleKey(launcher.key);
              return (
                <ListRow
                  key={launcher.key}
                  leading={<LogIn size={20} />}
                  title={titleKey ? t(titleKey) : launcher.title}
                  subtitle={
                    launcher.available
                      ? undefined
                      : (launcher.unavailableReason ?? t('accounts.launcherUnavailable'))
                  }
                  tone="accent"
                  disabled={!launcher.available}
                  onPress={() => setSigningIn({ agent, launcher })}
                />
              );
            })}
          </List>
        );
      })}
      {terminalOff && <p className="ui-list__footer">{t('accounts.terminalOff')}</p>}

      <AccountProfiles />
      <TerminalSheet
        open={signingIn !== null}
        onClose={() => setSigningIn(null)}
        title={shown ? t('accounts.sheet.title', { agent: shown.agent.displayName }) : ''}
        note={t('accounts.sheet.note')}
        target={shown ? { start: { launcher: shown.launcher.key } } : null}
        onDone="end"
        onFinished={() => void agents.refetch()}
      />
    </>
  );
}
