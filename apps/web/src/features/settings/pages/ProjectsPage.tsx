import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useStaleness } from '@/data/connection';
import { useProjects, useProjectsLiveUpdates } from '@/data/projects';
import { useT } from '@/i18n';
import { ProjectSheet } from '@/features/home/ProjectSheet';
import { projectSymbol } from '@/features/home/icons';
import { Badge, DelayedSkeleton, EmptyState, ErrorState, Glyph, List, ListRow, Skeleton, StaleNotice, toTint } from '@/ui';

/** For the page's row in the settings list. */
export function useProjectsSummary(): string | undefined {
  const t = useT();
  const projects = useProjects({ archived: 'include' });
  return projects.data ? t.plural('settings.projects.count', projects.data.length) : undefined;
}

/** Every project you can see, archived ones included — the place to bring an archived project back. */
export default function ProjectsPage() {
  const t = useT();
  const projects = useProjects({ archived: 'include' });
  const staleness = useStaleness(projects);
  useProjectsLiveUpdates();
  const [openId, setOpenId] = useState<string | null>(null);

  if (projects.isPending) {
    return (
      <DelayedSkeleton label={t('common.loading')}>
        <List>
          {[0, 1, 2].map((index) => (
            <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="45%" height={12} />} subtitle={<Skeleton width="70%" height={10} />} />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }
  if (!projects.data) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} retrying={projects.isFetching} />;

  const active = projects.data.filter((project) => !project.archived);
  const archived = projects.data.filter((project) => project.archived);
  const open = projects.data.find((project) => project.id === openId) ?? null;

  const row = (project: (typeof active)[number]) => {
    const Icon = projectSymbol(project.icon.symbol);
    return (
      <ListRow
        key={project.id}
        leading={<Glyph icon={<Icon size={18} />} tint={toTint(project.icon.color)} />}
        title={project.name}
        subtitle={<span className="u-mono">{project.rootDir}</span>}
        trailing={project.access === 'read' ? <Badge>{t('home.project.readOnly')}</Badge> : undefined}
        chevron
        onPress={() => setOpenId(project.id)}
      />
    );
  };

  return (
    <>
      {staleness.stale && <StaleNotice since={staleness.since} />}
      {projects.data.length === 0 ? (
        <EmptyState icon={<FolderOpen size={28} />} title={t('settings.projects.empty.title')} description={t('settings.projects.empty.description')} />
      ) : (
        <>
          {active.length > 0 && <List header={t('settings.projects.active')}>{active.map(row)}</List>}
          {archived.length > 0 && (
            <List header={t('settings.projects.archived')} footer={t('settings.projects.archivedHint')}>
              {archived.map(row)}
            </List>
          )}
        </>
      )}
      <ProjectSheet project={open} onClose={() => setOpenId(null)} />
    </>
  );
}
