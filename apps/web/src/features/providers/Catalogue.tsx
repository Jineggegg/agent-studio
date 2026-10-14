import { PROVIDER_LIMITS, type ProviderModel, providerModelIdSchema } from '@agent-studio/protocol';
import { Eye, EyeOff, Image, Plus, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Badge, Button, Checkbox, Form, Select, Sheet, Switch, TextField } from '@/ui';
import { windowText } from './model';

export interface CatalogueProps {
  models: readonly ProviderModel[];
  defaultModel: string | null;
  onChange: (models: ProviderModel[], defaultModel: string | null) => void;
  disabled?: boolean;
}

const numberOrNull = (text: string): number | null => {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(value) ? null : value;
};

/**
 * The models a provider offers, as the owner edits them: a name people see,
 * the context window, whether images and tools may be used, list prices (only
 * used to estimate costs), and whether pickers show it at all.
 */
export function Catalogue({ models, defaultModel, onChange, disabled }: CatalogueProps) {
  const t = useT();
  const [editing, setEditing] = useState<{ model: ProviderModel | null } | null>(null);
  const visible = models.filter((model) => !model.hidden);

  const replace = (next: ProviderModel, previousId: string | null) => {
    const list = previousId === null ? [...models, next] : models.map((model) => (model.id === previousId ? next : model));
    const nextDefault = defaultModel === previousId && previousId !== null ? next.id : defaultModel;
    onChange(list, nextDefault);
  };
  const remove = (id: string) =>
    onChange(
      models.filter((model) => model.id !== id),
      defaultModel === id ? null : defaultModel,
    );

  return (
    <div className="prv-catalogue">
      {models.length === 0 ? (
        <p className="prv-note">{t('providers.catalogue.empty')}</p>
      ) : (
        <ul className="prv-models">
          {models.map((model) => (
            <li key={model.id} className="prv-model" data-hidden={model.hidden || undefined}>
              <button type="button" className="prv-model__main" disabled={disabled} onClick={() => setEditing({ model })}>
                <span className="prv-model__name">
                  {model.name}
                  {model.id === defaultModel && <Badge tone="accent">{t('providers.catalogue.default')}</Badge>}
                </span>
                <span className="prv-model__id u-mono">{model.id}</span>
                <span className="prv-model__facts">
                  {windowText(model.contextWindow, t) ?? t('providers.model.windowUnknown')}
                  {model.images && (
                    <span className="prv-model__fact">
                      <Image size={13} aria-hidden="true" />
                      {t('providers.model.images')}
                    </span>
                  )}
                  {model.tools && (
                    <span className="prv-model__fact">
                      <Wrench size={13} aria-hidden="true" />
                      {t('providers.model.tools')}
                    </span>
                  )}
                  {model.prices ? (
                    <span className="prv-model__fact">{t('providers.model.priced', { input: t.number(model.prices.input), output: t.number(model.prices.output) })}</span>
                  ) : (
                    <span className="prv-model__fact">{t('providers.model.unpriced')}</span>
                  )}
                </span>
              </button>
              <Switch
                checked={!model.hidden}
                disabled={disabled}
                label={t('providers.catalogue.offer', { name: model.name })}
                onChange={(on) => replace({ ...model, hidden: !on }, model.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="prv-catalogue__bar">
        {visible.length > 0 && (
          <div className="prv-catalogue__default">
            <span className="ui-field__label">{t('providers.catalogue.defaultLabel')}</span>
            <Select
              label={t('providers.catalogue.defaultLabel')}
              value={visible.some((model) => model.id === defaultModel) ? (defaultModel ?? '') : ''}
              onChange={(value) => onChange([...models], value === '' ? null : value)}
              block
              disabled={disabled}
              options={[{ value: '', label: t('providers.catalogue.firstVisible') }, ...visible.map((model) => ({ value: model.id, label: model.name }))]}
            />
          </div>
        )}
        <Button size="sm" variant="tinted" icon={<Plus size={16} />} disabled={disabled || models.length >= PROVIDER_LIMITS.models} onClick={() => setEditing({ model: null })}>
          {t('providers.catalogue.add')}
        </Button>
      </div>
      <ModelSheet
        open={editing !== null}
        model={editing?.model ?? null}
        taken={models.map((model) => model.id)}
        onClose={() => setEditing(null)}
        onSave={(next, previousId) => {
          replace(next, previousId);
          setEditing(null);
        }}
        onRemove={(id) => {
          remove(id);
          setEditing(null);
        }}
      />
    </div>
  );
}

function ModelSheet({
  open,
  model,
  taken,
  onClose,
  onSave,
  onRemove,
}: {
  open: boolean;
  model: ProviderModel | null;
  taken: readonly string[];
  onClose: () => void;
  onSave: (model: ProviderModel, previousId: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [form, setForm] = useState({ id: '', name: '', window: '', images: false, tools: false, input: '', cached: '', output: '', hidden: false });
  const [shown, setShown] = useState<ProviderModel | null | undefined>(undefined);
  if (open && shown !== model) {
    setShown(model);
    setForm({
      id: model?.id ?? '',
      name: model?.name ?? '',
      window: model?.contextWindow ? String(model.contextWindow) : '',
      images: model?.images ?? false,
      tools: model?.tools ?? false,
      input: model?.prices ? String(model.prices.input) : '',
      cached: model?.prices?.cachedInput != null ? String(model.prices.cachedInput) : '',
      output: model?.prices ? String(model.prices.output) : '',
      hidden: model?.hidden ?? false,
    });
  } else if (!open && shown !== undefined) setShown(undefined);

  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const idProblem = form.id.trim() === '' ? t('providers.model.idMissing') : !providerModelIdSchema.safeParse(form.id.trim()).success ? t('providers.model.idInvalid') : taken.includes(form.id.trim()) && form.id.trim() !== model?.id ? t('providers.model.idTaken') : null;
  const windowValue = numberOrNull(form.window);
  const windowProblem = form.window.trim() !== '' && (windowValue === null || windowValue < 1000 || windowValue > 20_000_000 || !Number.isInteger(windowValue)) ? t('providers.model.windowInvalid') : null;
  const input = numberOrNull(form.input);
  const output = numberOrNull(form.output);
  const cached = numberOrNull(form.cached);
  const pricesGiven = form.input.trim() !== '' || form.output.trim() !== '' || form.cached.trim() !== '';
  const priceProblem = pricesGiven && (input === null || output === null || input < 0 || output < 0 || (form.cached.trim() !== '' && (cached === null || cached < 0))) ? t('providers.model.pricesInvalid') : null;
  const valid = idProblem === null && windowProblem === null && priceProblem === null;

  const save = () => {
    if (!valid) return;
    onSave(
      {
        id: form.id.trim(),
        name: form.name.trim() === '' ? form.id.trim() : form.name.trim().slice(0, PROVIDER_LIMITS.modelNameChars),
        contextWindow: windowValue,
        images: form.images,
        tools: form.tools,
        prices: pricesGiven && input !== null && output !== null ? { input, output, cachedInput: form.cached.trim() === '' ? null : cached } : null,
        hidden: form.hidden,
      },
      model?.id ?? null,
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={model ? t('providers.model.editTitle') : t('providers.model.addTitle')}
      footer={
        <>
          <Button variant="primary" block disabled={!valid} onClick={save}>
            {model ? t('providers.model.apply') : t('providers.catalogue.add')}
          </Button>
          {model && (
            <Button variant="plain-danger" block onClick={() => onRemove(model.id)}>
              {t('providers.model.remove')}
            </Button>
          )}
        </>
      }
    >
      <Form className="prv-form" onSubmit={save}>
        <TextField label={t('providers.model.id')} value={form.id} onChange={(id) => set({ id })} mono error={form.id !== '' || model ? idProblem : null} hint={t('providers.model.idHint')} autoCapitalize="none" spellCheck={false} autoComplete="off" data-autofocus="" />
        <TextField label={t('providers.model.name')} value={form.name} onChange={(name) => set({ name })} optional maxLength={PROVIDER_LIMITS.modelNameChars} autoComplete="off" />
        <TextField label={t('providers.model.windowLabel')} value={form.window} onChange={(window) => set({ window })} inputMode="numeric" optional error={windowProblem} hint={t('providers.model.windowHint')} />
        <Checkbox checked={form.images} onChange={(images) => set({ images })} label={t('providers.model.imagesLabel')} hint={t('providers.model.imagesHint')} />
        <Checkbox checked={form.tools} onChange={(tools) => set({ tools })} label={t('providers.model.toolsLabel')} hint={t('providers.model.toolsHint')} />
        <fieldset className="prv-prices">
          <legend>{t('providers.model.prices')}</legend>
          <div className="prv-prices__fields">
            {/* The prices are optional as a group, as the note below says; "(optional)" on each would only crowd the labels. */}
            <TextField label={t('providers.model.priceInput')} value={form.input} onChange={(value) => set({ input: value })} inputMode="decimal" />
            <TextField label={t('providers.model.priceCached')} value={form.cached} onChange={(value) => set({ cached: value })} inputMode="decimal" />
            <TextField label={t('providers.model.priceOutput')} value={form.output} onChange={(value) => set({ output: value })} inputMode="decimal" />
          </div>
          <p className={priceProblem ? 'ui-field__error' : 'prv-note'} role={priceProblem ? 'alert' : undefined}>
            {priceProblem ?? t('providers.model.pricesHint')}
          </p>
        </fieldset>
        <div className="prv-switch-row">
          <span>
            {form.hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            {t('providers.model.offered')}
          </span>
          <Switch checked={!form.hidden} onChange={(on) => set({ hidden: !on })} label={t('providers.model.offered')} />
        </div>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
