import type { Project, Session } from '@agent-studio/protocol';
import { ChevronDown, ChevronLeft, PanelLeft, PanelRight, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '@/i18n';
import { projectSettingsPath } from '@/registry';
import type { BackAction } from '@/shell/back';
import { ActivityMark, type ActivityKind, Menu, isImeConfirm } from '@/ui';
import { AgentMark } from './parts';

export interface TitleBarProps {
  title: string;
  /** Present for a conversation that exists: its title can be changed here. */
  session: Session | null;
  canRename: boolean;
  onRename: (title: string) => void;
  agentId: string | null;
  agentLabel: string | null;
  project: Project | null;
  /** A new conversation in the "all" list picks its project here; otherwise the name is plain text. */
  projectChoices: readonly Project[] | null;
  onChooseProject: (projectId: string) => void;
  /** Offered to owners at the foot of the project list. */
  onNewProject?: (() => void) | undefined;
  /** The list is not on show (a phone, or the column was hidden): a button brings it up. */
  listHidden: boolean;
  listMark: Extract<ActivityKind, 'attention' | 'unseen'> | null;
  onShowList: () => void;
  /** Shown when the docked list (which carries the back control) is hidden. */
  back: BackAction | null;
  /** The context ring, the permission mode, and whatever else belongs at the trailing edge. */
  trailing?: ReactNode;
  inspector: { available: boolean; open: boolean; toggle: () => void };
}

/** The bar above a conversation: where it is, what it is called, and the few controls that concern the whole of it. */
export function TitleBar({ title, session, canRename, onRename, agentId, agentLabel, project, projectChoices, onChooseProject, onNewProject, listHidden, listMark, onShowList, back, trailing, inspector }: TitleBarProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const field = useRef<HTMLInputElement>(null);
  const projectAnchor = useRef<HTMLButtonElement>(null);
  const [projectMenu, setProjectMenu] = useState(false);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next !== '' && next !== title) onRename(next);
  };

  const listLabel =
    listMark === 'attention' ? t('workbench.list.showAttention') : listMark === 'unseen' ? t('workbench.list.showUnseen') : t('workbench.list.show');

  return (
    <header className="wb-titlebar">
      <div className="wb-titlebar__leading">
        {listHidden && (
          <button type="button" className="wb-bar-button wb-titlebar__list" onClick={onShowList} aria-label={listLabel} title={listLabel}>
            <PanelLeft size={21} aria-hidden="true" />
            {listMark && <ActivityMark kind={listMark} className="wb-titlebar__mark" />}
          </button>
        )}
        {listHidden && back && (
          <button type="button" className="wb-bar-button wb-titlebar__back" onClick={back.go} aria-label={back.accessibleLabel} title={back.accessibleLabel}>
            <ChevronLeft size={23} aria-hidden="true" />
          </button>
        )}
      </div>
      {agentId && <AgentMark agentId={agentId} size={30} {...(agentLabel ? { label: agentLabel } : {})} />}
      <div className="wb-titlebar__titles">
        {editing ? (
          <input
            ref={field}
            className="wb-titlebar__field"
            value={draft}
            maxLength={200}
            aria-label={t('workbench.session.renameLabel')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeConfirm(event)) {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
        ) : session && canRename ? (
          <button
            type="button"
            // The title inside truncates; the button itself must not clip, or its widened hit area goes with it.
            className="wb-titlebar__title"
            title={t('workbench.session.renameHint')}
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
          >
            <h1 className="u-truncate">{title}</h1>
          </button>
        ) : (
          <h1 className="wb-titlebar__title u-truncate">{title}</h1>
        )}
        {projectChoices && project ? (
          <>
            <button ref={projectAnchor} type="button" className="wb-titlebar__project wb-titlebar__project--chip" aria-haspopup="menu" aria-expanded={projectMenu} onClick={() => setProjectMenu(!projectMenu)}>
              <span className="u-truncate">{t('workbench.project.in', { project: project.name })}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            <Menu
              open={projectMenu}
              onClose={() => setProjectMenu(false)}
              anchor={projectAnchor}
              label={t('workbench.project.choose')}
              items={[
                ...projectChoices.map((entry) => ({ id: entry.id, label: entry.name, checked: entry.id === project.id, onSelect: () => entry.id !== project.id && onChooseProject(entry.id) })),
                ...(onNewProject ? [{ separator: true as const, id: 'separator' }, { id: 'new', label: t('workbench.project.new'), icon: <Plus size={18} />, onSelect: onNewProject }] : []),
              ]}
            />
          </>
        ) : (
          project &&
          (projectSettingsPath(project.id) ? (
            // The project's own page: its links, what it offers, who it is shared with.
            <Link className="wb-titlebar__project wb-titlebar__project--link" to={projectSettingsPath(project.id)!} title={t('workbench.project.page', { project: project.name })} draggable={false}>
              <span className="u-truncate">{project.name}</span>
            </Link>
          ) : (
            <p className="wb-titlebar__project u-truncate">{project.name}</p>
          ))
        )}
      </div>
      <div className="wb-titlebar__trailing">
        {trailing}
        {inspector.available && (
          <button
            type="button"
            className="wb-bar-button"
            aria-pressed={inspector.open}
            onClick={inspector.toggle}
            aria-label={inspector.open ? t('workbench.inspector.hide') : t('workbench.inspector.show')}
            title={inspector.open ? t('workbench.inspector.hide') : t('workbench.inspector.show')}
          >
            <PanelRight size={21} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
