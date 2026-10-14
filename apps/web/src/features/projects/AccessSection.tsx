import type { Project, ProjectFeature } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '@/data/errors';
import { useUpdateProject } from '@/data/projects';
import { wasCancelled } from '@/features/projects/tools/kit';
import { useAgents, useProjectAgentSettings } from '@/features/workbench/agents';
import { workbenchApi } from '@/features/workbench/api';
import { workbenchKeys } from '@/features/workbench/sessions/queries';
import { useT } from '@/i18n';
import { Banner, List, ListRow, LoadingRow, Switch, confirm, toast } from '@/ui';
import { AUTO_MODE_COPY, FEATURE_COPY, FEATURE_ORDER } from './copy';

/**
 * Which agents a project offers and what it lets them do — the owner's to
 * decide. Every switch says in words what it turns on and what stops when it
 * is off; the ones that widen what an agent can reach ask before they do.
 */
export function AccessSection({ project }: { project: Project }) {
  const t = useT();
  const queryClient = useQueryClient();
  const update = useUpdateProject();
  const agents = useAgents();
  const settings = useProjectAgentSettings(project.id);
  const [failure, setFailure] = useState<string | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const busy = update.isPending || savingAuto;

  const save = (changes: Parameters<typeof update.mutate>[0]['changes'], done: string) => {
    setFailure(null);
    update.mutate(
      { id: project.id, changes },
      {
        onSuccess: () => toast.success(done),
        onError: (error) => {
          if (!wasCancelled(error)) setFailure(describeError(error, t));
        },
      },
    );
  };

  const setFeature = async (feature: ProjectFeature, on: boolean) => {
    const copy = FEATURE_COPY[feature];
    if (on && copy.risk) {
      const agreed = await confirm({ title: t(copy.risk.title, { project: project.name }), message: t(copy.risk.message), confirmLabel: t(copy.risk.confirm), tone: 'danger' });
      if (!agreed) return;
    }
    save({ features: { [feature]: on } }, on ? t('projects.feature.turnedOn', { feature: t(copy.title) }) : t('projects.feature.turnedOff', { feature: t(copy.title) }));
  };

  const setAutoMode = async (on: boolean) => {
    if (on && AUTO_MODE_COPY.risk) {
      const agreed = await confirm({ title: t(AUTO_MODE_COPY.risk.title, { project: project.name }), message: t(AUTO_MODE_COPY.risk.message), confirmLabel: t(AUTO_MODE_COPY.risk.confirm), tone: 'danger' });
      if (!agreed) return;
    }
    setSavingAuto(true);
    setFailure(null);
    try {
      queryClient.setQueryData(workbenchKeys.projectSettings(project.id), await workbenchApi.saveProjectSettings(project.id, { autoMode: on }));
      toast.success(on ? t('projects.feature.turnedOn', { feature: t(AUTO_MODE_COPY.title) }) : t('projects.feature.turnedOff', { feature: t(AUTO_MODE_COPY.title) }));
    } catch (error) {
      if (!wasCancelled(error)) setFailure(describeError(error, t));
    } finally {
      setSavingAuto(false);
    }
  };

  const offered = (agentId: string): boolean => project.agents === null || project.agents.includes(agentId);
  const setAgent = (agentId: string, on: boolean) => {
    const all = (agents.data ?? []).map((agent) => agent.id);
    const current = project.agents ?? all;
    const next = on ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId);
    // Every agent switched on is "whatever the Studio offers", so one added later is offered too.
    const everything = all.length > 0 && all.every((id) => next.includes(id));
    save({ agents: everything ? null : next }, t('projects.agents.saved'));
  };

  return (
    <>
      {failure && (
        <Banner tone="danger" role="alert">
          {failure}
        </Banner>
      )}
      <List header={t('projects.agents.title')} footer={t('projects.agents.footer')}>
        {agents.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : (
          (agents.data ?? []).map((agent) => (
            <ListRow
              key={agent.id}
              title={agent.displayName}
              subtitle={!agent.status.installed ? t('accounts.state.missing') : !agent.status.signedIn ? t('accounts.state.signedOut') : undefined}
              control={<Switch checked={offered(agent.id)} disabled={busy} onChange={(on) => setAgent(agent.id, on)} />}
            />
          ))
        )}
      </List>

      <List header={t('projects.features.title')} footer={t('projects.features.footer')}>
        {FEATURE_ORDER.map((feature) => (
          <ListRow
            key={feature}
            title={t(FEATURE_COPY[feature].title)}
            subtitle={t(FEATURE_COPY[feature].consequence)}
            control={<Switch checked={project.features[feature]} disabled={busy} onChange={(on) => void setFeature(feature, on)} />}
          />
        ))}
        <ListRow
          title={t(AUTO_MODE_COPY.title)}
          subtitle={t(AUTO_MODE_COPY.consequence)}
          control={<Switch checked={settings.data?.autoMode === true} disabled={busy || !settings.data} onChange={(on) => void setAutoMode(on)} />}
        />
      </List>
    </>
  );
}
