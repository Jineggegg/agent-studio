import type { Project, ProjectAccess, ProjectMember, User } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { describeError } from '@/data/errors';
import { wasCancelled } from '@/features/projects/tools/kit';
import { useUsers } from '@/features/settings/api';
import { type Translator, useT } from '@/i18n';
import { Avatar, Banner, Button, EmptyState, ErrorState, List, ListRow, LoadingRow, SegmentedControl, Select, Sheet, confirm, toast } from '@/ui';
import { projectPageKeys, projectsApi } from './api';

const accessOptions = (t: Translator) => [
  { value: 'read' as const, label: t('projects.sharing.read'), hint: t('projects.sharing.readHint') },
  { value: 'write' as const, label: t('projects.sharing.write'), hint: t('projects.sharing.writeHint') },
];

function AddPersonSheet({ project, open, onClose, members }: { project: Project; open: boolean; onClose: () => void; members: readonly ProjectMember[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const users = useUsers(open);
  const [access, setAccess] = useState<ProjectAccess>('write');
  const [adding, setAdding] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Owners see every project already; a disabled account cannot sign in at all.
  const candidates = (users.data ?? []).filter((user) => user.role !== 'owner' && !user.disabled && !members.some((member) => member.userId === user.id));

  const add = async (user: User) => {
    setAdding(user.id);
    setFailure(null);
    try {
      await projectsApi.setMember(project.id, user.id, access);
      await queryClient.invalidateQueries({ queryKey: projectPageKeys.members(project.id) });
      toast.success(t('projects.sharing.added', { name: user.displayName || user.username, project: project.name }));
      onClose();
    } catch (error) {
      if (!wasCancelled(error)) setFailure(describeError(error, t));
    } finally {
      setAdding(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('projects.sharing.add')} dismissible={adding === null}>
      <div className="proj-share-sheet">
        {failure && (
          <Banner tone="danger" role="alert">
            {failure}
          </Banner>
        )}
        <SegmentedControl label={t('projects.sharing.accessLabel')} value={access} onChange={setAccess} options={accessOptions(t).map(({ value, label }) => ({ value, label }))} disabled={adding !== null} />
        <p className="text-footnote text-secondary">{access === 'read' ? t('projects.sharing.readHint') : t('projects.sharing.writeHint')}</p>
        {users.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : !users.data ? (
          <ErrorState compact error={users.error} onRetry={() => void users.refetch()} />
        ) : candidates.length === 0 ? (
          <EmptyState compact title={t('projects.sharing.nobody')} description={t('projects.sharing.nobodyHint')} />
        ) : (
          <List aria-label={t('projects.sharing.add')}>
            {candidates.map((user) => (
              <ListRow
                key={user.id}
                leading={<Avatar name={user.displayName || user.username} size={34} />}
                title={user.displayName || user.username}
                subtitle={`@${user.username}`}
                disabled={adding !== null}
                onPress={() => void add(user)}
                chevron={false}
                trailing={adding === user.id ? <span className="text-footnote text-secondary">{t('projects.sharing.adding')}</span> : undefined}
              />
            ))}
          </List>
        )}
      </div>
    </Sheet>
  );
}

/** Who else can use this project, and how much. The owner's to decide; owners themselves always see every project. */
export function SharingSection({ project }: { project: Project }) {
  const t = useT();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: projectPageKeys.members(project.id), queryFn: ({ signal }) => projectsApi.members(project.id, signal), retry: false });
  const [adding, setAdding] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const change = async (member: ProjectMember, access: ProjectAccess) => {
    setWorking(member.userId);
    setFailure(null);
    try {
      await projectsApi.setMember(project.id, member.userId, access);
      await queryClient.invalidateQueries({ queryKey: projectPageKeys.members(project.id) });
    } catch (error) {
      if (!wasCancelled(error)) setFailure(describeError(error, t));
    } finally {
      setWorking(null);
    }
  };

  const remove = async (member: ProjectMember) => {
    const name = member.displayName || member.username;
    const agreed = await confirm({
      title: t('projects.sharing.remove.title', { name, project: project.name }),
      message: t('projects.sharing.remove.message'),
      confirmLabel: t('projects.sharing.remove'),
      tone: 'danger',
    });
    if (!agreed) return;
    setWorking(member.userId);
    setFailure(null);
    try {
      await projectsApi.removeMember(project.id, member.userId);
      await queryClient.invalidateQueries({ queryKey: projectPageKeys.members(project.id) });
      toast.success(t('projects.sharing.removed', { name }));
    } catch (error) {
      if (!wasCancelled(error)) setFailure(describeError(error, t));
    } finally {
      setWorking(null);
    }
  };

  return (
    <>
      {failure && (
        <Banner tone="danger" role="alert">
          {failure}
        </Banner>
      )}
      <List
        header={t('projects.sharing.title')}
        headerAction={
          <Button size="sm" variant="plain" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
            {t('projects.sharing.add')}
          </Button>
        }
        footer={t('projects.sharing.footer')}
      >
        {members.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : !members.data ? (
          <div role="listitem">
            <ErrorState compact error={members.error} onRetry={() => void members.refetch()} />
          </div>
        ) : members.data.length === 0 ? (
          <div className="proj-empty-row" role="listitem">
            <span>{t('projects.sharing.empty')}</span>
          </div>
        ) : (
          members.data.map((member) => (
            <ListRow
              key={member.userId}
              leading={<Avatar name={member.displayName || member.username} size={34} />}
              title={member.displayName || member.username}
              subtitle={`@${member.username}`}
              control={
                <Select
                  label={t('projects.sharing.accessOf', { name: member.displayName || member.username })}
                  value={member.access}
                  onChange={(access) => void change(member, access)}
                  options={accessOptions(t)}
                  quiet
                  disabled={working !== null}
                />
              }
              // One short word: it is also what a swipe reveals, in a narrow strip. The question that follows says it in full.
              actions={[{ id: 'remove', label: t('projects.sharing.unshare'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void remove(member) }]}
              actionsLabel={t('projects.sharing.actions', { name: member.displayName || member.username })}
            />
          ))
        )}
      </List>
      <AddPersonSheet project={project} open={adding} onClose={() => setAdding(false)} members={members.data ?? []} />
    </>
  );
}
