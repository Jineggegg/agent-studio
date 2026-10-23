import type { ConversationGroup } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Button, ErrorState, Sheet, TextField, confirm, toast } from '@/ui';
import { conversationApi, conversationKeys } from './features-api';
import './conversations.css';

export const useConversationGroups = () =>
  useQuery({ queryKey: conversationKeys.groups, queryFn: conversationApi.groups });

function GroupRow({
  group,
  refresh,
}: {
  group: ConversationGroup;
  refresh: () => Promise<unknown>;
}) {
  const t = useT();
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await conversationApi.renameGroup(group.id, name);
      await refresh();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: t('conversations.delete'),
        message: t('conversations.deleteHint'),
        confirmLabel: t('conversations.delete'),
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    try {
      await conversationApi.deleteGroup(group.id);
      await refresh();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="conversation-group-row">
      <TextField
        label={t('conversations.name')}
        value={name}
        onChange={setName}
        maxLength={80}
        disabled={busy}
      />
      <Button
        variant="neutral"
        disabled={busy || !name.trim() || name === group.name}
        onClick={() => void save()}
      >
        {t('conversations.rename')}
      </Button>
      <Button variant="plain" disabled={busy} onClick={() => void remove()}>
        {t('conversations.delete')}
      </Button>
    </div>
  );
}

export function ConversationGroupFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const groups = useConversationGroups();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    await groups.refetch();
    await queryClient.invalidateQueries({ queryKey: ['workbench'] });
  };
  const create = async () => {
    setBusy(true);
    try {
      await conversationApi.createGroup(name);
      setName('');
      await refresh();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="conversation-group-filter">
        <select
          className="conversation-select"
          aria-label={t('conversations.groups')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t('conversations.all')}</option>
          <option value="ungrouped">{t('conversations.ungrouped')}</option>
          {groups.data?.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <Button
          variant="plain"
          aria-label={t('conversations.manage')}
          onClick={() => setOpen(true)}
          icon={<Settings2 size={18} />}
        >
          <span className="visually-hidden">{t('conversations.manage')}</span>
        </Button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('conversations.manage')}>
        <div className="conversation-panel">
          {groups.isError && (
            <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
          )}
          <TextField
            label={t('conversations.name')}
            value={name}
            onChange={setName}
            maxLength={80}
            onEnter={() => {
              if (name.trim() && !busy) void create();
            }}
          />
          <Button disabled={busy || !name.trim()} onClick={() => void create()}>
            {t('conversations.create')}
          </Button>
          {groups.data?.groups.map((group) => (
            <GroupRow key={group.id} group={group} refresh={refresh} />
          ))}
        </div>
      </Sheet>
    </>
  );
}
