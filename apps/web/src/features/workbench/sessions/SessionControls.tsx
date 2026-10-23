import type { Agent, Session, UpdateSessionRequest } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '@/data/errors';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import { Badge, Button, ErrorState, Sheet, Switch, confirm, toast } from '@/ui';
import { workbenchApi } from '../api';
import { workbenchPaths } from '../routes';
import { useConversationGroups } from './ConversationGroups';
import { conversationApi, conversationKeys } from './features-api';
import { upsertSession } from './queries';
import './conversations.css';

export function SessionControls({
  session,
  agent,
}: {
  session: Session;
  agent: Agent | undefined;
}) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const groups = useConversationGroups();
  const profiles = useQuery({
    queryKey: conversationKeys.profiles,
    queryFn: conversationApi.profiles,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mine = user?.id === session.userId;
  const selectedModel = agent?.capabilities.models.find((model) => model.id === session.model);
  const supportedModel =
    agent?.id === 'codex'
      ? selectedModel?.fastMode === true
      : agent?.id === 'claude-code'
        ? /^opus(?:\[[a-z0-9]+\])?$|^claude-opus-(?:5(?:-5)?|4-8)(?:-\d{8})?(?:\[[a-z0-9]+\])?$/.test(
            session.model ?? '',
          )
        : true;
  const fastAvailable = agent?.capabilities.fastMode?.supported === true && supportedModel;
  const change = async (changes: UpdateSessionRequest) => {
    setBusy(true);
    try {
      upsertSession(queryClient, await workbenchApi.updateSession(session.id, changes));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const fork = async () => {
    if (
      !(await confirm({
        title: t('conversations.fork'),
        message: t('conversations.branchHint'),
        confirmLabel: t('conversations.fork'),
      }))
    )
      return;
    setBusy(true);
    try {
      const branch = await conversationApi.fork(session.id, {});
      upsertSession(queryClient, branch);
      setOpen(false);
      void navigate(workbenchPaths.session(branch.projectId, branch.id));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const account = profiles.data?.profiles.find(
    (profile) => profile.id === session.accountProfileId,
  );
  return (
    <>
      <div className="conversation-controls">
        <Button
          size="sm"
          variant="plain"
          icon={<Settings2 size={16} />}
          onClick={() => setOpen(true)}
        >
          {t('conversations.settings')}
        </Button>
        {session.groupId && (
          <Badge>
            {groups.data?.groups.find((group) => group.id === session.groupId)?.name ??
              t('conversations.groups')}
          </Badge>
        )}
        {session.fastMode && <Badge tone="accent">{t('conversations.fast')}</Badge>}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('conversations.settings')}>
        <div className="conversation-panel">
          {groups.isError && (
            <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
          )}
          <label>
            {t('conversations.assign')}
            <select
              className="conversation-select"
              value={session.groupId ?? ''}
              disabled={!mine || busy}
              onChange={(event) => void change({ groupId: event.target.value || null })}
            >
              <option value="">{t('conversations.ungrouped')}</option>
              {groups.data?.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="neutral"
            icon={<GitBranch size={16} />}
            disabled={!mine || busy || session.activeRunId !== null}
            onClick={() => void fork()}
          >
            {t('conversations.fork')}
          </Button>
          {agent?.kind === 'cli' && (
            <>
              <label>
                <span>{t('conversations.fast')}</span>
                <Switch
                  label={t('conversations.fast')}
                  checked={session.fastMode ?? false}
                  disabled={
                    !mine ||
                    busy ||
                    session.activeRunId !== null ||
                    (!fastAvailable && !session.fastMode)
                  }
                  onChange={(value) => void change({ fastMode: value })}
                />
              </label>
              <p className="conversation-help">
                {t(fastAvailable ? 'conversations.fastHint' : 'conversations.fastUnavailable')}
              </p>
              <div>
                <strong>{t('conversations.account')}</strong>
                <p>
                  {account?.name ??
                    (session.accountProfileId
                      ? t('profiles.unknown')
                      : t('conversations.hostAccount'))}
                </p>
                <p className="conversation-help">{t('conversations.accountHint')}</p>
              </div>
            </>
          )}
          <div>
            <strong>{t('conversations.mcp')}</strong>
            {agent?.capabilities.mcp?.length ? (
              agent.capabilities.mcp.map((server) => (
                <p key={server.name}>
                  {server.name} ·{' '}
                  {t(
                    server.status === 'connected'
                      ? 'conversations.connected'
                      : server.status === 'configured'
                        ? 'conversations.configured'
                        : 'conversations.unavailable',
                  )}
                </p>
              ))
            ) : (
              <p className="conversation-help">{t('conversations.mcpUnknown')}</p>
            )}
          </div>
        </div>
      </Sheet>
    </>
  );
}
