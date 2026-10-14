import { Check, Play } from 'lucide-react';
import { type MouseEvent, memo, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { Menu, toast } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { useInspectorAction } from '../inspector/scope';
import { parseFileReference } from './links';
import { shellCommands } from './shell';

/**
 * "Run" on a shell block: hands the command to the project's terminal, which
 * types it and leaves Enter to the person. A block of several commands asks
 * which line — the terminal takes one line at a time, and gluing lines
 * together is not this button's decision to make. Nothing is reported back
 * to the agent.
 */
function RunInTerminal({ commands, onRun }: { commands: readonly string[]; onRun: (command: string) => void }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(false), 2000);
    return () => window.clearTimeout(timer);
  }, [sent]);

  const run = (command: string) => {
    onRun(command);
    setSent(true);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ui-code__copy wb-code-run"
        aria-haspopup={commands.length > 1 ? 'menu' : undefined}
        aria-expanded={commands.length > 1 ? choosing : undefined}
        aria-label={t('workbench.tool.runInTerminal')}
        title={t('workbench.tool.runInTerminal')}
        onClick={() => (commands.length === 1 ? run(commands[0]!) : setChoosing(true))}
      >
        {sent ? <Check size={16} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        <span aria-live="polite">{sent ? t('workbench.code.sent') : t('workbench.code.run')}</span>
      </button>
      {commands.length > 1 && (
        <Menu
          open={choosing}
          onClose={() => setChoosing(false)}
          anchor={anchor}
          label={t('workbench.code.chooseLine')}
          align="end"
          items={commands.map((command, index) => ({ id: String(index), label: command.length > 72 ? `${command.slice(0, 71)}…` : command, onSelect: () => run(command) }))}
        />
      )}
    </>
  );
}

/**
 * Markdown written by an agent (or quoted from a plan). Two things differ
 * from plain `<Markdown>`. A link to a file opens it in the project's tools
 * when a panel for that is installed, and otherwise copies the path — never a
 * new tab on an address that does not exist. And a block of shell commands
 * gets a "Run" control when the project has a terminal the reader may use.
 */
export const Prose = memo(function Prose({ children, compact }: { children: string; compact?: boolean }) {
  const t = useT();
  const openFile = useInspectorAction('open-file');
  const runCommand = useInspectorAction('run-command');
  const onLinkClick = useCallback(
    (href: string, event: MouseEvent<HTMLAnchorElement>) => {
      const reference = parseFileReference(href);
      if (!reference) return;
      event.preventDefault();
      if (openFile) {
        openFile({ type: 'open-file', ...reference });
        return;
      }
      void copyText(reference.path).then((copied) => {
        if (copied) toast.info(t('workbench.link.pathCopied', { path: reference.path }), { id: 'workbench-path-copied' });
      });
    },
    [openFile, t],
  );
  const codeActions = useCallback(
    ({ language, text }: { language: string | undefined; text: string }) => {
      if (!runCommand) return null;
      const commands = shellCommands(language, text);
      return commands ? <RunInTerminal commands={commands} onRun={(command) => runCommand({ type: 'run-command', text: command })} /> : null;
    },
    [runCommand],
  );
  return (
    <Markdown onLinkClick={onLinkClick} {...(runCommand ? { codeActions } : {})} {...(compact ? { compact } : {})}>
      {children}
    </Markdown>
  );
});
