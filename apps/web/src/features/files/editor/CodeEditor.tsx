import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { languageFor } from './languages';

/**
 * The text editor: CodeMirror 6 dressed in the Studio's tokens. It knows
 * nothing about files or the server — it holds text, says when that text
 * differs from the last saved one, and jumps to a line when asked.
 */
export interface EditorSnapshot {
  /** The lines of the text as it is right now. */
  lines: Iterable<string>;
  /** Hand back to `markSaved` once the server has taken exactly this text. */
  token: unknown;
}

export interface CodeEditorHandle {
  snapshot(): EditorSnapshot;
  /** The text of `token` is on the server now: it becomes what "unsaved" is measured against. */
  markSaved(token: unknown): void;
  /** Replace everything with `text`, as freshly read from the server. */
  load(text: string): void;
  isDirty(): boolean;
  /** Put the caret on a line (1-based; past the end means the last line), centre it and mark it. */
  jumpToLine(line: number): void;
  focus(): void;
}

export interface CodeEditorProps {
  /** The text to start with. */
  text: string;
  /** What "unsaved" is measured against at the start, when it differs from `text` (text restored after leaving). */
  savedText?: string | undefined;
  /** Chooses the language. */
  path: string;
  wrap: boolean;
  readOnly: boolean;
  label: string;
  onDirtyChange: (dirty: boolean) => void;
  onSave: () => void;
  ref?: Ref<CodeEditorHandle>;
}

const setMark = StateEffect.define<number | null>();
const markedLine = Decoration.line({ class: 'cm-jump-line' });
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMark)) return effect.value === null ? Decoration.none : Decoration.set([markedLine.range(effect.value)]);
    }
    // The mark answers "where did that link point"; once the text moves on it has done its job.
    return transaction.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--files-editor-size)', backgroundColor: 'var(--code-bg)', color: 'var(--code-text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55', overflow: 'auto', overscrollBehavior: 'contain' },
  '.cm-content': { caretColor: 'var(--color-accent)', padding: '8px 0 40vh' },
  '.cm-line': { padding: '0 12px 0 6px' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--color-text-tertiary)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'var(--color-fill)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-fill)', color: 'var(--color-text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--color-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--color-fill-hover)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--color-accent-soft)', outline: 'none' },
  '.cm-jump-line': { backgroundColor: 'var(--color-accent-soft)', boxShadow: 'inset 3px 0 0 var(--color-accent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--color-fill)', border: 'none', color: 'var(--color-text-secondary)', padding: '0 6px', borderRadius: '4px' },
  '.cm-panels': { backgroundColor: 'var(--color-surface)', color: 'var(--color-text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--color-separator)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-separator)' },
  '.cm-search': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', padding: '8px 40px 8px 10px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-footnote)' },
  '.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '32px' },
  '.cm-search br': { display: 'none' },
  '.cm-textfield': {
    minHeight: '34px',
    padding: '0 8px',
    border: '1px solid var(--color-separator-strong)',
    borderRadius: '8px',
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-text)',
    fontSize: 'var(--text-field)',
  },
  '.cm-button': {
    minHeight: '34px',
    padding: '0 10px',
    border: 'none',
    borderRadius: '8px',
    backgroundImage: 'none',
    backgroundColor: 'var(--color-fill)',
    color: 'var(--color-text)',
    fontSize: 'var(--text-footnote)',
  },
  '.cm-panel.cm-search [name=close]': { top: '6px', right: '6px', width: '32px', height: '32px', fontSize: '20px', color: 'var(--color-text-secondary)' },
  '.cm-tooltip': { border: '1px solid var(--color-separator)', borderRadius: '8px', backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', boxShadow: 'var(--shadow-2)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--color-accent)', color: 'var(--color-on-accent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-warning-soft)', outline: '1px solid var(--color-separator-strong)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--color-accent-soft-hover)' },
});

const highlighting = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: 'var(--code-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.className, tags.typeName, tags.namespace, tags.heading], color: 'var(--code-title)' },
  { tag: [tags.propertyName, tags.attributeName, tags.tagName, tags.labelName], color: 'var(--code-attr)' },
  { tag: [tags.deleted, tags.invalid], color: 'var(--code-deletion)' },
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);

export function CodeEditor({ text, savedText, path, wrap, readOnly, label, onDirtyChange, onSave, ref }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const dirty = useRef(false);
  const callbacks = useRef({ onDirtyChange, onSave });
  useEffect(() => {
    callbacks.current = { onDirtyChange, onSave };
  });
  const compartments = useRef({ wrap: new Compartment(), language: new Compartment(), readOnly: new Compartment() });

  const report = (state: EditorState) => {
    const next = saved.current !== null && !state.doc.eq(saved.current);
    if (next === dirty.current) return;
    dirty.current = next;
    callbacks.current.onDirtyChange(next);
  };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const parts = compartments.current;
    const extensions: Extension[] = [
      basicSetup,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            callbacks.current.onSave();
            return true;
          },
        },
        indentWithTab,
      ]),
      theme,
      syntaxHighlighting(highlighting),
      markField,
      parts.wrap.of(wrap ? EditorView.lineWrapping : []),
      parts.language.of([]),
      parts.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      EditorView.contentAttributes.of({ 'aria-label': label, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) report(update.state);
      }),
    ];
    const created = new EditorView({ parent: element, state: EditorState.create({ doc: text, extensions }) });
    view.current = created;
    saved.current = savedText === undefined ? created.state.doc : EditorState.create({ doc: savedText }).doc;
    dirty.current = false;
    report(created.state);

    let cancelled = false;
    void languageFor(path).then((language) => {
      if (!cancelled && language) created.dispatch({ effects: parts.language.reconfigure(language) });
    });
    return () => {
      cancelled = true;
      view.current = null;
      created.destroy();
    };
    // One editor per mounted file: the parent gives each file its own key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);
  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useImperativeHandle(
    ref,
    (): CodeEditorHandle => ({
      snapshot() {
        const doc = view.current?.state.doc ?? saved.current;
        return { lines: doc ? doc.iterLines() : [], token: doc };
      },
      markSaved(token) {
        const current = view.current;
        if (!current || token === null || token === undefined) return;
        saved.current = token as Text;
        report(current.state);
      },
      load(next) {
        const current = view.current;
        if (!current) return;
        current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: next }, selection: { anchor: 0 } });
        saved.current = current.state.doc;
        report(current.state);
      },
      isDirty: () => dirty.current,
      jumpToLine(line) {
        const current = view.current;
        if (!current) return;
        const target = current.state.doc.line(Math.min(Math.max(1, Math.floor(line)), current.state.doc.lines));
        current.dispatch({ selection: { anchor: target.from }, effects: [setMark.of(target.from), EditorView.scrollIntoView(target.from, { y: 'center' })] });
      },
      focus: () => view.current?.focus(),
    }),
    // The handle only reads refs.
    [],
  );

  return <div ref={host} className="files-code" data-keys="own" />;
}
