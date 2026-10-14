import type { CreateTerminalSessionRequest, TerminalSession } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Problem, ProblemNote, problemOf, wasCancelled } from '@/features/projects/tools/kit';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { useCanHover } from '@/platform/media';
import { Button, LoadingRow, Sheet, confirm } from '@/ui';
import { terminalApi, terminalKeys } from './api';
import { TerminalView } from './TerminalView';
import { clampFontSize, readFontSize, saveFontSize } from './keys';

/** What the sheet runs: something new, chosen from the server's list by key — or a session that is already running. */
export type TerminalSheetTarget = { start: Pick<CreateTerminalSessionRequest, 'launcher' | 'remote' | 'projectId'> } | { attach: string };

export interface TerminalSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the terminal: where this runs and what closing does. */
  note?: string;
  target: TerminalSheetTarget | null;
  /**
   * `end`: closing the sheet ends the session (a sign-in that was abandoned
   * must not linger). `detach`: the session keeps running on the server and
   * can be opened again.
   */
  onDone: 'end' | 'detach';
  /** Called after the sheet has closed, with the session it showed (to re-read whatever the program changed). */
  onFinished?: (session: TerminalSession | null) => void;
}

/**
 * A terminal in a sheet, for the few places that need one outside a project's
 * tools: an agent's own sign-in, a shell on a remote machine. What runs is
 * never typed by the browser — it is a launcher the server knows by key.
 */
export function TerminalSheet({ open, onClose, title, note, target, onDone, onFinished }: TerminalSheetProps) {
  const t = useT();
  const layout = useLayoutClass();
  const canHover = useCanHover();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [starting, setStarting] = useState(false);
  const [fontSize, setFontSize] = useState(() => readFontSize(layout === 'phone'));
  const attempt = useRef(0);
  const latest = useRef<TerminalSession | null>(null);

  const start = useCallback(async () => {
    if (!target) return;
    const mine = (attempt.current += 1);
    setProblem(null);
    setSession(null);
    latest.current = null;
    setStarting(true);
    try {
      const created = 'attach' in target ? await terminalApi.session(target.attach) : await terminalApi.create(target.start);
      if (mine !== attempt.current) {
        // The sheet was closed while the server was still starting it: nothing may be left behind.
        if ('start' in target && onDone === 'end') void terminalApi.close(created.id).catch(() => undefined);
        return;
      }
      latest.current = created;
      setSession(created);
    } catch (error) {
      if (mine !== attempt.current) return;
      if (wasCancelled(error)) return onClose();
      setProblem(problemOf(error, t));
    } finally {
      if (mine === attempt.current) setStarting(false);
    }
  }, [target, onDone, onClose, t]);

  useEffect(() => {
    if (open) void start();
    else attempt.current += 1;
    // Started once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const finish = async () => {
    const shown = latest.current;
    if (shown && onDone === 'end' && shown.alive) {
      const agreed = await confirm({ title: t('terminal.sheet.end.title'), message: t('terminal.sheet.end.message'), confirmLabel: t('terminal.sheet.end.confirm'), tone: 'danger' });
      if (!agreed) return;
    }
    onClose();
    if (shown && onDone === 'end') {
      try {
        await terminalApi.close(shown.id);
      } catch {
        /* over already — or the server's idle limit ends it */
      }
    }
    void queryClient.invalidateQueries({ queryKey: terminalKeys.all });
    onFinished?.(shown);
  };

  const changeFont = (size: number) => {
    const next = clampFontSize(size);
    setFontSize(next);
    saveFontSize(next);
  };

  return (
    <Sheet
      open={open}
      onClose={() => void finish()}
      title={title}
      size="lg"
      fill
      flush
      trailing={
        <Button variant="plain" onClick={() => void finish()}>
          {t('common.done')}
        </Button>
      }
    >
      <div className="term-sheet">
        {problem ? (
          <div className="term-sheet__stage">
            <ProblemNote
              problem={problem}
              title={t('terminal.sheet.failed')}
              action={
                <Button size="sm" variant="plain" onClick={() => void start()}>
                  {t('common.retry')}
                </Button>
              }
            />
          </div>
        ) : !session || starting ? (
          <LoadingRow label={t('terminal.sheet.starting')} />
        ) : (
          <TerminalView
            key={session.id}
            sessionId={session.id}
            visible={open}
            keyBar={layout === 'phone' || (layout === 'tablet' && !canHover)}
            fontSize={fontSize}
            onFontSize={changeFont}
            onSession={(next) => {
              latest.current = next;
            }}
          />
        )}
        {note && <p className="term-sheet__note">{note}</p>}
      </div>
    </Sheet>
  );
}
