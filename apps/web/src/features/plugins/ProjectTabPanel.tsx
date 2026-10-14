import type { PluginPanelContribution } from '@agent-studio/protocol';
import { Puzzle } from 'lucide-react';
import { useState } from 'react';
import type { InspectorPanelProps } from '@/features/workbench/inspector/registry';
import { useT } from '@/i18n';
import { EmptyState, ErrorState, LoadingRow, Select } from '@/ui';
import { PanelFrame } from './PanelFrame';
import { usePluginContributions } from './contributions';
import { pluginIcon } from './icons';
import './plugins.css';

const CHOSEN_KEY = 'studio.plugins.projectTab';
const keyOf = (tab: Pick<PluginPanelContribution, 'pluginId' | 'panelId'>): string => `${tab.pluginId}/${tab.panelId}`;

function rememberedTab(): string | null {
  try {
    return window.localStorage.getItem(CHOSEN_KEY);
  } catch {
    return null;
  }
}

/**
 * The plugins' tabs of a project, as one panel beside the chat: the panel of
 * the plugin chosen (when there are several) for the project on show. Each is
 * a sandboxed frame that knows the project's id and name — nothing more.
 */
export default function ProjectTabPanel({ project }: InspectorPanelProps) {
  const t = useT();
  const contributions = usePluginContributions();
  const tabs = contributions.data?.projectTabs ?? [];
  const [chosen, setChosen] = useState<string | null>(rememberedTab);
  const current = tabs.find((tab) => keyOf(tab) === chosen) ?? tabs[0] ?? null;

  if (!project) return <EmptyState compact icon={<Puzzle size={26} />} title={t('plugins.tab.noProject')} />;
  if (contributions.isPending) return <LoadingRow label={t('common.loading')} />;
  if (!contributions.data) return <ErrorState compact error={contributions.error} onRetry={() => void contributions.refetch()} retrying={contributions.isFetching} />;
  if (!current) return <EmptyState compact icon={<Puzzle size={26} />} title={t('plugins.tab.none')} description={t('plugins.tab.noneText')} />;

  const Icon = pluginIcon(current.icon);
  return (
    <div className="pl-tab">
      <div className="pl-tab__head">
        <Icon size={18} aria-hidden="true" />
        {tabs.length > 1 ? (
          <Select
            label={t('plugins.tab.choose')}
            value={keyOf(current)}
            quiet
            onChange={(value) => {
              setChosen(value);
              try {
                window.localStorage.setItem(CHOSEN_KEY, value);
              } catch {
                /* only a convenience */
              }
            }}
            options={tabs.map((tab) => ({ value: keyOf(tab), label: tab.title, hint: tab.pluginName }))}
          />
        ) : (
          <p className="pl-tab__title u-truncate">{current.title}</p>
        )}
        <span className="pl-tab__from u-truncate">{t('plugins.panel.from', { plugin: current.pluginName })}</span>
      </div>
      <PanelFrame
        key={`${keyOf(current)}:${project.id}`}
        pluginId={current.pluginId}
        panelId={current.panelId}
        slot="project-tab"
        project={{ id: project.id, name: project.name }}
        title={t('plugins.panel.frameLabel', { title: current.title, plugin: current.pluginName })}
        sizing="fill"
      />
    </div>
  );
}
