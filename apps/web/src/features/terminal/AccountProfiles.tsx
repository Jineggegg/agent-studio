import type { AccountProfile } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '@/data/errors';
import { useIsOwner } from '@/data/session';
import { conversationApi, conversationKeys } from '@/features/workbench/sessions/features-api';
import { useT } from '@/i18n';
import { Badge, Button, ErrorState, List, ListRow, TextField, toast } from '@/ui';
import { TerminalSheet } from './TerminalSheet';
import '@/features/workbench/sessions/conversations.css';

function ProfileRow({
  profile,
  select,
  login,
}: {
  profile: AccountProfile;
  select: () => Promise<void>;
  login: () => void;
}) {
  const t = useT();
  const isOwner = useIsOwner();
  const [status, setStatus] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setStatus((await conversationApi.profileStatus(profile.id)).signedIn);
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <List
      header={`${profile.agentId === 'codex' ? 'Codex' : 'Claude Code'} · ${profile.name}`}
      headerAction={
        profile.isDefault ? <Badge tone="accent">{t('profiles.default')}</Badge> : undefined
      }
    >
      <ListRow
        title={t(
          status === true
            ? 'profiles.signedIn'
            : status === false
              ? 'profiles.signedOut'
              : 'profiles.unknown',
        )}
        trailing={
          <Button size="sm" variant="plain" disabled={busy} onClick={() => void check()}>
            {t('profiles.check')}
          </Button>
        }
      />
      {isOwner && <ListRow title={t('profiles.login')} onPress={login} chevron />}
      {!profile.isDefault && (
        <ListRow title={t('profiles.select')} onPress={() => void select()} chevron />
      )}
    </List>
  );
}

export function AccountProfiles() {
  const queryClient = useQueryClient();
  const t = useT();
  const isOwner = useIsOwner();
  const profiles = useQuery({
    queryKey: conversationKeys.profiles,
    queryFn: conversationApi.profiles,
  });
  const [agentId, setAgentId] = useState<'codex' | 'claude-code'>('claude-code');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<AccountProfile | null>(null);
  const create = async () => {
    setBusy(true);
    try {
      const created = await conversationApi.createProfile(agentId, name);
      setName('');
      await profiles.refetch();
      setLogin(created);
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const select = async (profile: AccountProfile) => {
    try {
      await conversationApi.selectProfile(profile.id);
      await profiles.refetch();
      await queryClient.invalidateQueries({ queryKey: ['workbench', 'agents'] });
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };
  return (
    <section className="conversation-panel">
      <h2>{t('profiles.title')}</h2>
      <p className="conversation-help">{t('profiles.intro')}</p>
      {profiles.isError && (
        <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />
      )}
      {profiles.data?.profiles.length === 0 && <p>{t('profiles.empty')}</p>}
      {profiles.data?.profiles.map((profile) => (
        <ProfileRow
          key={profile.id}
          profile={profile}
          select={() => select(profile)}
          login={() => setLogin(profile)}
        />
      ))}
      {isOwner && (
        <>
          <label>
            {t('profiles.provider')}
            <select
              className="conversation-select"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value as 'codex' | 'claude-code')}
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <TextField label={t('profiles.name')} value={name} onChange={setName} maxLength={80} />
          <Button disabled={busy || !name.trim()} onClick={() => void create()}>
            {t('profiles.create')}
          </Button>
        </>
      )}
      <TerminalSheet
        open={login !== null}
        onClose={() => {
          setLogin(null);
          void queryClient.invalidateQueries({ queryKey: ['workbench', 'agents'] });
        }}
        title={login?.name ?? t('profiles.login')}
        note={t('profiles.intro')}
        target={
          login
            ? {
                start: {
                  launcher: login.agentId === 'codex' ? 'codex-login-device' : 'claude-login',
                  accountProfileId: login.id,
                },
              }
            : null
        }
        onDone="end"
      />
    </section>
  );
}
