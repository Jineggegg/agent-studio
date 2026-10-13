import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { useT } from '@/i18n';
import { Glyph, TINTS, TextArea, TextField, type Tint } from '@/ui';
import { PROJECT_SYMBOLS, PROJECT_SYMBOL_NAMES, type ProjectSymbol, projectSymbol } from './icons';

export interface ProjectDraft {
  name: string;
  description: string;
  symbol: string;
  color: Tint;
}

/** Arrow keys walk a radio group laid out as a grid; only the chosen option is in the Tab order. */
function useRovingRadios(onPick: (index: number) => void, count: number, current: number) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (current + step + count) % count;
    onPick(next);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return { group, onKeyDown };
}

export interface ProjectFieldsProps {
  draft: ProjectDraft;
  onChange: (changes: Partial<ProjectDraft>) => void;
  nameError?: string | undefined;
  disabled?: boolean;
  autoFocusName?: boolean;
  /** Extra fields placed between the description and the icon pickers (the folder, when creating). */
  children?: ReactNode;
}

/** Name, description and the icon (a symbol and a colour) — shared by "New project" and "Edit project". */
export function ProjectFields({ draft, onChange, nameError, disabled, autoFocusName, children }: ProjectFieldsProps) {
  const t = useT();
  const symbolIndex = Math.max(0, PROJECT_SYMBOL_NAMES.indexOf(draft.symbol as ProjectSymbol));
  const colorIndex = Math.max(0, TINTS.indexOf(draft.color));
  const symbols = useRovingRadios((index) => onChange({ symbol: PROJECT_SYMBOL_NAMES[index]! }), PROJECT_SYMBOL_NAMES.length, symbolIndex);
  const colors = useRovingRadios((index) => onChange({ color: TINTS[index]! }), TINTS.length, colorIndex);
  const Symbol = projectSymbol(draft.symbol);

  return (
    <>
      <div className="project-form__preview">
        <Glyph icon={<Symbol size={30} />} tint={draft.color} size={60} />
        <div className="project-form__preview-text">
          <p className="text-headline u-truncate">{draft.name.trim() || t('home.project.untitled')}</p>
          <p className="text-footnote text-secondary">{t('home.project.iconHint')}</p>
        </div>
      </div>

      <TextField
        label={t('home.project.name')}
        value={draft.name}
        onChange={(name) => onChange({ name })}
        error={nameError}
        maxLength={80}
        enterKeyHint="next"
        disabled={disabled}
        {...(autoFocusName ? { 'data-autofocus': '' } : {})}
      />
      <TextArea
        label={t('home.project.description')}
        optional
        value={draft.description}
        onChange={(description) => onChange({ description })}
        maxLength={500}
        rows={2}
        disabled={disabled}
      />
      {children}

      <div>
        <p className="project-form__legend" id="project-symbol-legend">
          {t('home.project.symbol')}
        </p>
        <div ref={symbols.group} className="picker" role="radiogroup" aria-labelledby="project-symbol-legend" onKeyDown={symbols.onKeyDown} data-tint={draft.color}>
          {PROJECT_SYMBOL_NAMES.map((name, index) => {
            const Icon = PROJECT_SYMBOLS[name];
            return (
              <button
                key={name}
                type="button"
                role="radio"
                className="picker__option"
                aria-checked={index === symbolIndex}
                aria-label={t(`symbol.${name}`)}
                title={t(`symbol.${name}`)}
                tabIndex={index === symbolIndex ? 0 : -1}
                disabled={disabled}
                onClick={() => onChange({ symbol: name })}
              >
                <Icon size={22} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="project-form__legend" id="project-color-legend">
          {t('home.project.color')}
        </p>
        <div ref={colors.group} className="picker" role="radiogroup" aria-labelledby="project-color-legend" onKeyDown={colors.onKeyDown}>
          {TINTS.map((tint, index) => (
            <button
              key={tint}
              type="button"
              role="radio"
              className="picker__option"
              data-swatch=""
              data-tint={tint}
              aria-checked={index === colorIndex}
              aria-label={t(`tint.${tint}`)}
              title={t(`tint.${tint}`)}
              tabIndex={index === colorIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange({ color: tint })}
            >
              <span className="picker__swatch" />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
