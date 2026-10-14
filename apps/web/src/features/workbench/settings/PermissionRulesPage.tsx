import type { PermissionRule, RuleEffect } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, CircleHelp, Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { describeError } from '@/data/errors';
import { useProjects } from '@/data/projects';
import { type MessageKey, useT } from '@/i18n';
import { Badge, Banner, Button, DelayedSkeleton, EmptyState, ErrorState, Form, List, ListRow, SegmentedControl, Select, Sheet, Skeleton, TextField, confirm, toast } from '@/ui';
import { workbenchApi } from '../api';
import { describeRule } from '../approvals/logic';
import { workbenchKeys } from '../sessions/queries';
import './rules.css';

const EFFECT_LABELS: Record<RuleEffect, MessageKey> = {
  allow: 'workbench.rules.effect.allow',
  deny: 'workbench.rules.effect.deny',
  ask: 'workbench.rules.effect.ask',
};

function EffectIcon({ effect }: { effect: RuleEffect }) {
  if (effect === 'allow') return <CircleCheck size={18} aria-hidden="true" />;
  if (effect === 'deny') return <Ban size={18} aria-hidden="true" />;
  return <CircleHelp size={18} aria-hidden="true" />;
}

function AddRuleSheet({ open, onClose, projects }: { open: boolean; onClose: () => void; projects: readonly { id: string; name: string }[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [effect, setEffect] = useState<RuleEffect>('allow');
  const [tool, setTool] = useState('');
  const [pattern, setPattern] = useState('');
  const [where, setWhere] = useState('account');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    if (tool.trim() === '' || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await workbenchApi.createRule({
        scope: where === 'account' ? 'account' : 'project',
        ...(where === 'account' ? {} : { projectId: where }),
        effect,
        tool: tool.trim(),
        ...(pattern.trim() === '' ? {} : { pattern: pattern.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: workbenchKeys.rules });
      toast.success(t('workbench.rules.added'));
      setTool('');
      setPattern('');
      onClose();
    } catch (error) {
      setProblem(describeError(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('workbench.rules.add')}
      dismissible={!saving}
      footer={
        <>
          <Button variant="neutral" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={tool.trim() === ''}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <Form onSubmit={() => void save()} className="wb-rules__form">
        {problem && <Banner tone="danger">{problem}</Banner>}
        <SegmentedControl
          label={t('workbench.rules.effect')}
          value={effect}
          onChange={setEffect}
          options={[
            { value: 'allow', label: t('workbench.rules.effect.allow') },
            { value: 'ask', label: t('workbench.rules.effect.ask') },
            { value: 'deny', label: t('workbench.rules.effect.deny') },
          ]}
        />
        <TextField label={t('workbench.rules.tool')} hint={t('workbench.rules.toolHint')} value={tool} onChange={setTool} mono autoCapitalize="none" autoCorrect="off" spellCheck={false} data-autofocus="" />
        <TextField label={t('workbench.rules.pattern')} hint={t('workbench.rules.patternHint')} value={pattern} onChange={setPattern} mono optional autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <div className="wb-rules__where">
          <span className="ui-field__label">{t('workbench.rules.where')}</span>
          <Select
            label={t('workbench.rules.where')}
            value={where}
            onChange={setWhere}
            block
            options={[{ value: 'account', label: t('workbench.rules.scope.account') }, ...projects.map((project) => ({ value: project.id, label: t('workbench.rules.scope.projectNamed', { project: project.name }) }))]}
          />
        </div>
      </Form>
    </Sheet>
  );
}

/**
 * The rules the permission engine applies to this person's runs before it
 * asks: what is always allowed, what is always refused, what is always asked
 * about. Rules saved from an approval ("allow and remember") show up here,
 * and this is where they are taken back.
 */
export default function PermissionRulesPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: workbenchKeys.rules, queryFn: ({ signal }) => workbenchApi.rules(signal).then((result) => result.rules) });
  const projects = useProjects();
  const [adding, setAdding] = useState(false);
  const names = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project.name])), [projects.data]);

  const remove = async (rule: PermissionRule) => {
    const confirmed = await confirm({ title: t('workbench.rules.remove.title', { rule: describeRule(rule) }), message: t('workbench.rules.remove.message'), confirmLabel: t('common.remove'), tone: 'danger' });
    if (!confirmed) return;
    try {
      await workbenchApi.deleteRule(rule.id);
      queryClient.setQueryData<PermissionRule[]>(workbenchKeys.rules, (current) => current?.filter((entry) => entry.id !== rule.id));
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };

  if (rules.isPending) {
    return (
      <DelayedSkeleton label={t('common.loading')}>
        <List>
          {[0, 1, 2].map((index) => (
            <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="50%" height={12} />} subtitle={<Skeleton width="30%" height={10} />} />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }
  if (!rules.data) return <ErrorState error={rules.error} onRetry={() => void rules.refetch()} retrying={rules.isFetching} />;

  const scopeLabel = (rule: PermissionRule): string =>
    rule.scope === 'account'
      ? t('workbench.rules.scope.account')
      : rule.scope === 'project'
        ? t('workbench.rules.scope.projectNamed', { project: names.get(rule.projectId ?? '') ?? t('workbench.rules.scope.unknownProject') })
        : t('workbench.rules.scope.session');
  const groups: RuleEffect[] = ['allow', 'ask', 'deny'];
  const addButton = (
    <Button variant="tinted" icon={<Plus size={18} />} onClick={() => setAdding(true)}>
      {t('workbench.rules.add')}
    </Button>
  );

  return (
    <>
      <p className="wb-rules__intro">{t('workbench.rules.intro')}</p>
      {rules.data.length === 0 ? (
        <EmptyState icon={<ShieldCheck size={28} />} title={t('workbench.rules.empty')} description={t('workbench.rules.emptyHint')} action={addButton} />
      ) : (
        <>
          {groups.map((effect) => {
            const list = rules.data.filter((rule) => rule.effect === effect);
            if (list.length === 0) return null;
            return (
              <List key={effect} header={t(EFFECT_LABELS[effect])}>
                {list.map((rule) => (
                  <ListRow
                    key={rule.id}
                    leading={<EffectIcon effect={effect} />}
                    title={<span className="u-mono">{describeRule(rule)}</span>}
                    subtitle={scopeLabel(rule)}
                    trailing={rule.shared ? <Badge tone="info">{t('workbench.rules.shared')}</Badge> : undefined}
                    actions={[{ id: 'remove', label: t('common.remove'), tone: 'danger', onSelect: () => void remove(rule) }]}
                    actionsLabel={t('workbench.rules.actions', { rule: describeRule(rule) })}
                  />
                ))}
              </List>
            );
          })}
          <div className="wb-rules__add">{addButton}</div>
        </>
      )}
      <AddRuleSheet open={adding} onClose={() => setAdding(false)} projects={(projects.data ?? []).filter((project) => project.access === 'write')} />
    </>
  );
}
