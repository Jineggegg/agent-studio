import type { ToolKind } from '@agent-studio/protocol';
import { Ban, Bot, Brain, Check, ChevronRight, CircleDashed, CircleX, FilePen, FileText, Globe, Hand, type LucideIcon, Search, SquareArrowOutUpRight, Terminal, Wrench } from 'lucide-react';
import { type ReactNode, memo, useState } from 'react';
import { type Translator, useT } from '@/i18n';
import { Spinner } from '@/ui';
import { CopyButton } from '../chat/parts';
import { useInspectorAction } from '../inspector/scope';
import { ChangeCounts, DiffView } from './DiffView';
import { Prose } from './Prose';
import { previewChanges } from './diff';
import type { StackEntry, StackItem, ThinkingEntry, ToolEntry, ToolStatus } from './model';
import { changeCounts, collapseStack, countNestedTools, describeTool, filePathOf, tailOf } from './tools';

/** Characters of output shown; the rest is summarised. */
const OUTPUT_LIMIT = 12_000;
const ARGUMENT_LIMIT = 6_000;

const KIND_ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  search: Search,
  edit: FilePen,
  execute: Terminal,
  fetch: Globe,
  agent: Bot,
  other: Wrench,
};

/** What the adapter passed the tool, readable: pretty-printed, bounded. */
function formatArguments(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input.slice(0, ARGUMENT_LIMIT);
  try {
    const text = JSON.stringify(input, null, 2);
    return text === '{}' ? '' : text.slice(0, ARGUMENT_LIMIT);
  } catch {
    return '';
  }
}

function commandOf(tool: ToolEntry): string | null {
  if (tool.kind !== 'execute' || typeof tool.input !== 'object' || tool.input === null) return null;
  const record = tool.input as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.script;
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

function StatusGlyph({ status, waiting }: { status: ToolStatus; waiting: boolean }) {
  const t = useT();
  if (waiting) {
    return (
      <span className="wb-tool__status" data-status="waiting">
        <Hand size={16} aria-hidden="true" />
        <span>{t('workbench.tool.status.waiting')}</span>
      </span>
    );
  }
  switch (status) {
    case 'running':
      return (
        <span className="wb-tool__status" data-status="running">
          <Spinner size={16} label={t('workbench.tool.status.running')} />
        </span>
      );
    case 'ok':
      return (
        <span className="wb-tool__status" data-status="ok" role="img" aria-label={t('workbench.tool.status.ok')}>
          <Check size={16} aria-hidden="true" />
        </span>
      );
    // Anything that did not simply succeed says so in a word as well as a shape.
    case 'error':
      return (
        <span className="wb-tool__status" data-status="error">
          <CircleX size={16} aria-hidden="true" />
          <span>{t('workbench.tool.status.error')}</span>
        </span>
      );
    case 'denied':
      return (
        <span className="wb-tool__status" data-status="denied">
          <Ban size={16} aria-hidden="true" />
          <span>{t('workbench.tool.status.denied')}</span>
        </span>
      );
    case 'unfinished':
      return (
        <span className="wb-tool__status" data-status="unfinished">
          <CircleDashed size={16} aria-hidden="true" />
          <span>{t('workbench.tool.status.unfinished')}</span>
        </span>
      );
  }
}

function approvalLine(tool: ToolEntry, t: Translator): string | null {
  const approval = tool.approval;
  if (!approval) return null;
  switch (approval.status) {
    case 'pending':
      return t('workbench.approval.record.pending');
    case 'allowed':
      return t('workbench.approval.record.allowed');
    case 'denied':
      return approval.note ? t('workbench.approval.record.deniedWithNote', { note: approval.note }) : t('workbench.approval.record.denied');
    case 'expired':
      return t('workbench.approval.record.expired');
    case 'cancelled':
      return t('workbench.approval.record.cancelled');
  }
}

function Output({ text, omittedByServer, tone, live }: { text: string; omittedByServer: number; tone?: 'error'; live?: boolean }) {
  const t = useT();
  const shown = tailOf(text, OUTPUT_LIMIT);
  const omitted = shown.omitted + omittedByServer;
  return (
    <div className="wb-output" data-tone={tone} data-live={live || undefined}>
      {omitted > 0 && <p className="wb-output__note">{t('workbench.tool.outputOmitted', { count: t.number(omitted) })}</p>}
      <pre tabIndex={0}>{shown.text}</pre>
    </div>
  );
}

function OpenFileButton({ path, onOpen }: { path: string; onOpen: (request: { type: 'open-file'; path: string }) => void }) {
  const t = useT();
  return (
    <button type="button" className="wb-inline-button wb-tool__open" onClick={() => onOpen({ type: 'open-file', path })}>
      <SquareArrowOutUpRight size={14} aria-hidden="true" />
      {t('workbench.tool.openFile')}
    </button>
  );
}

function ToolDetail({ tool, onReview, depth }: { tool: ToolEntry; onReview?: ((approvalId: string) => void) | undefined; depth: number }) {
  const t = useT();
  const command = commandOf(tool);
  const args = command === null || Object.keys((tool.input as Record<string, unknown>) ?? {}).length > 1 ? formatArguments(tool.input) : '';
  const running = tool.status === 'running';
  const output = running ? tool.liveOutput : tool.output;
  const approval = approvalLine(tool, t);
  const description = typeof tool.input === 'object' && tool.input !== null ? (tool.input as Record<string, unknown>).description : undefined;
  // Offered only when a project tool that can do it is installed: no panel, no control.
  const openFile = useInspectorAction('open-file');
  const runCommand = useInspectorAction('run-command');
  const path = filePathOf(tool);
  const listsPath = tool.diffs.some((diff) => diff.path === path);

  return (
    <div className="wb-tool__detail">
      {approval && (
        <p className="wb-tool__approval" data-status={tool.approval?.status}>
          {approval}
          {tool.approval?.status === 'pending' && onReview && (
            <button type="button" className="wb-inline-button" onClick={() => onReview(tool.approval!.id)}>
              {t('workbench.approval.review')}
            </button>
          )}
        </p>
      )}
      {command !== null && (
        <div className="wb-command">
          <pre tabIndex={0}>{command}</pre>
          {runCommand && !running && (
            <button type="button" className="wb-copy" onClick={() => runCommand({ type: 'run-command', text: command })} aria-label={t('workbench.tool.runInTerminal')} title={t('workbench.tool.runInTerminal')}>
              <Terminal size={16} aria-hidden="true" />
            </button>
          )}
          <CopyButton text={command} label={t('workbench.tool.copyCommand')} />
        </div>
      )}
      {typeof description === 'string' && description.trim() !== '' && command !== null && <p className="wb-tool__description">{description}</p>}
      {tool.diffs.map((diff) => (
        <div key={diff.path} className="wb-tool__file">
          <p className="wb-tool__path">
            <span className="u-mono u-truncate">{diff.path}</span>
            <ChangeCounts added={diff.added} removed={diff.removed} />
            {openFile && <OpenFileButton path={diff.path} onOpen={openFile} />}
          </p>
          {diff.patch ? <DiffView patch={diff.patch} label={t('workbench.diff.labelFor', { path: diff.path })} /> : <p className="wb-tool__muted">{t('workbench.diff.noPatch')}</p>}
        </div>
      ))}
      {tool.diffsTruncated && <p className="wb-tool__muted">{t('workbench.diff.truncated')}</p>}
      {openFile && path !== null && !listsPath && (
        <p className="wb-tool__path">
          <span className="u-mono u-truncate">{path}</span>
          <OpenFileButton path={path} onOpen={openFile} />
        </p>
      )}
      {args !== '' && command === null && (
        <details className="wb-tool__arguments">
          <summary>{t('workbench.tool.arguments')}</summary>
          <pre tabIndex={0}>{args}</pre>
          {tool.inputTruncated && <p className="wb-tool__muted">{t('workbench.tool.argumentsTruncated')}</p>}
        </details>
      )}
      {tool.children.length > 0 && (
        <div className="wb-tool__children" role="group" aria-label={t('workbench.tool.subagentSteps')}>
          <EntryList entries={tool.children} onReview={onReview} depth={depth + 1} />
        </div>
      )}
      {output !== '' && <Output text={output} omittedByServer={running ? 0 : tool.outputOmittedChars} {...(tool.status === 'error' ? { tone: 'error' as const } : {})} live={running} />}
      {output === '' && !running && tool.diffs.length === 0 && tool.children.length === 0 && tool.status !== 'denied' && <p className="wb-tool__muted">{t('workbench.tool.noOutput')}</p>}
      {tool.status === 'denied' && tool.output !== '' && !approval && <p className="wb-tool__muted">{tool.output}</p>}
    </div>
  );
}

function ToolRow({ tool, onReview, depth }: { tool: ToolEntry; onReview?: ((approvalId: string) => void) | undefined; depth: number }) {
  const t = useT();
  const waiting = tool.approval?.status === 'pending';
  // A request waiting for the user opens by itself: what is being asked should not need a tap to be read.
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? waiting;
  const description = describeTool(tool);
  const Icon = KIND_ICONS[tool.kind];
  const counts = changeCounts(tool);
  const nested = tool.kind === 'agent' ? countNestedTools(tool.children) : 0;
  const verb = description.verb ? t(description.verb) : description.name || t('workbench.tool.verb.other');
  const patch = tool.diffs.find((diff) => diff.patch)?.patch;
  const preview = !expanded && patch ? previewChanges(patch, 2) : [];
  const liveLine = !expanded && tool.status === 'running' && tool.liveOutput !== '' ? tool.liveOutput.trimEnd().split('\n').pop() : undefined;

  return (
    <li className="wb-tool" data-status={waiting ? 'waiting' : tool.status} data-open={expanded || undefined}>
      <button type="button" className="wb-tool__row" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <Icon className="wb-tool__icon" size={17} aria-hidden="true" />
        <span className="wb-tool__label">
          <span className="wb-tool__verb">{verb}</span>
          {description.target !== '' && <span className={description.mono ? 'wb-tool__target u-mono' : 'wb-tool__target'}>{description.target}</span>}
        </span>
        {nested > 0 && <span className="wb-tool__count">{t.plural('workbench.tool.steps', nested)}</span>}
        {counts && <ChangeCounts added={counts.added} removed={counts.removed} />}
        <StatusGlyph status={tool.status} waiting={waiting} />
        <ChevronRight className="wb-tool__chevron" size={16} aria-hidden="true" />
      </button>
      {preview.length > 0 && patch && (
        <div className="wb-tool__preview" aria-hidden="true">
          {preview.map((line, index) => (
            <div key={index} className="wb-diff__line" data-kind={line.kind}>
              <span className="wb-diff__sign">{line.kind === 'add' ? '+' : '−'}</span>
              <span className="wb-diff__text">{line.text}</span>
            </div>
          ))}
        </div>
      )}
      {liveLine && (
        <p className="wb-tool__live u-mono u-truncate" aria-hidden="true">
          {liveLine}
        </p>
      )}
      {expanded && <ToolDetail tool={tool} onReview={onReview} depth={depth} />}
    </li>
  );
}

function ThinkingRow({ entry }: { entry: ThinkingEntry }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const tail = entry.streaming && !open ? entry.text.slice(-160).replace(/\s+/g, ' ') : '';
  return (
    <li className="wb-tool" data-kind="thinking" data-open={open || undefined}>
      <button type="button" className="wb-tool__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Brain className="wb-tool__icon" size={17} aria-hidden="true" />
        <span className="wb-tool__label">
          <span className="wb-tool__verb">{entry.streaming ? t('workbench.thinking.live') : t('workbench.thinking.done')}</span>
          {tail !== '' && <span className="wb-tool__target wb-tool__target--tail">{tail}</span>}
        </span>
        {entry.streaming && (
          <span className="wb-tool__status" data-status="running">
            <Spinner size={16} />
          </span>
        )}
        <ChevronRight className="wb-tool__chevron" size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="wb-tool__detail">
          <p className="wb-thinking">{entry.text}</p>
          {entry.partial && <p className="wb-tool__muted">{t('workbench.message.partial')}</p>}
        </div>
      )}
    </li>
  );
}

function EntryList({ entries, onReview, depth }: { entries: readonly StackEntry[]; onReview?: ((approvalId: string) => void) | undefined; depth: number }): ReactNode {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const collapsed = collapseStack(entries);
  const render = (entry: StackEntry) => {
    if (entry.type === 'tool') return <ToolRow key={`tool:${entry.toolCallId}`} tool={entry} onReview={onReview} depth={depth} />;
    if (entry.type === 'thinking') return <ThinkingRow key={`thinking:${entry.messageId}`} entry={entry} />;
    return (
      <li key={`prose:${entry.messageId}`} className="wb-tool wb-tool--prose">
        <Prose compact>{entry.text}</Prose>
      </li>
    );
  };
  // A call that needs the user is never folded away with the middle of a long stack.
  const hiddenNeedsUser = collapsed.hidden.some((entry) => entry.type === 'tool' && (entry.approval?.status === 'pending' || entry.status === 'running'));
  const folded = collapsed.hidden.length > 0 && !showAll && !hiddenNeedsUser;
  return (
    <ul className="wb-stack__list" data-depth={depth}>
      {collapsed.head.map(render)}
      {folded ? (
        <li className="wb-stack__more">
          <button type="button" className="wb-inline-button" onClick={() => setShowAll(true)}>
            {t.plural('workbench.stack.more', collapsed.hidden.length)}
          </button>
        </li>
      ) : (
        collapsed.hidden.map(render)
      )}
      {collapsed.tail.map(render)}
    </ul>
  );
}

/** Consecutive tool calls and the reasoning between them: one compact list, each row opening to its details. */
export const StackView = memo(function StackView({ item, onReview }: { item: StackItem; onReview?: ((approvalId: string) => void) | undefined }) {
  return (
    <div className="wb-stack">
      <EntryList entries={item.entries} onReview={onReview} depth={0} />
    </div>
  );
});
