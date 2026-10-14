import type { PushTestResult } from '@agent-studio/protocol';
import { Bell, BellOff, BellRing, Lock, MonitorSmartphone, Share, ShieldAlert, Smartphone } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { type MessageKey, type Translator, useT } from '@/i18n';
import { Button, Glyph, Spinner, type Tint } from '@/ui';
import { type PushState, pushActionFor } from './push';
import type { EnableOutcome, PushSetup } from './state';
import './notifications.css';

interface Presentation {
  icon: ReactNode;
  tint: Tint;
  title: MessageKey;
  text: MessageKey;
  /** Shorter, for the banner on a project's automations page. */
  line: MessageKey;
}

/** The words and mark for each state. `denied` depends on where the switch lives: the browser, or the iPhone's own settings. */
export function presentPushState(state: PushState, iosApp: boolean): Presentation {
  switch (state.kind) {
    case 'on':
      return { icon: <BellRing size={18} />, tint: 'green', title: 'notify.state.on.title', text: 'notify.state.on.text', line: 'notify.state.on.line' };
    case 'channel-off':
      return { icon: <BellOff size={18} />, tint: 'amber', title: 'notify.state.channelOff.title', text: 'notify.state.channelOff.text', line: 'notify.state.channelOff.line' };
    case 'not-subscribed':
      return { icon: <MonitorSmartphone size={18} />, tint: 'blue', title: 'notify.state.notSubscribed.title', text: 'notify.state.notSubscribed.text', line: 'notify.state.notSubscribed.line' };
    case 'not-asked':
      return { icon: <Bell size={18} />, tint: 'blue', title: 'notify.state.notAsked.title', text: 'notify.state.notAsked.text', line: 'notify.state.notAsked.line' };
    case 'denied':
      return iosApp
        ? { icon: <BellOff size={18} />, tint: 'red', title: 'notify.state.denied.title', text: 'notify.state.denied.iosText', line: 'notify.state.denied.line' }
        : { icon: <BellOff size={18} />, tint: 'red', title: 'notify.state.denied.title', text: 'notify.state.denied.text', line: 'notify.state.denied.line' };
    case 'needs-install':
      return { icon: <Share size={18} />, tint: 'sky', title: 'notify.state.install.title', text: 'notify.state.install.text', line: 'notify.state.install.line' };
    case 'unsupported':
      return state.reason === 'insecure'
        ? { icon: <Lock size={18} />, tint: 'slate', title: 'notify.state.insecure.title', text: 'notify.state.insecure.text', line: 'notify.state.unsupported.line' }
        : state.reason === 'no-worker'
          ? { icon: <ShieldAlert size={18} />, tint: 'slate', title: 'notify.state.noWorker.title', text: 'notify.state.noWorker.text', line: 'notify.state.unsupported.line' }
          : { icon: <Smartphone size={18} />, tint: 'slate', title: 'notify.state.unsupported.title', text: 'notify.state.unsupported.text', line: 'notify.state.unsupported.line' };
    case 'checking':
      return { icon: <Bell size={18} />, tint: 'slate', title: 'notify.state.checking', text: 'notify.state.checking', line: 'notify.state.checking' };
  }
}

/** Why enabling did not work, in words. */
export function enableProblem(outcome: Exclude<EnableOutcome, { ok: true }>, t: Translator): string {
  switch (outcome.reason) {
    case 'denied':
      return t('notify.enable.denied');
    case 'dismissed':
      return t('notify.enable.dismissed');
    case 'no-worker':
      return t('notify.enable.noWorker');
    case 'subscribe-failed': {
      const name = outcome.error instanceof Error ? outcome.error.name : '';
      return name === 'NotAllowedError' ? t('notify.enable.denied') : t('notify.enable.subscribeFailed');
    }
    case 'register-failed':
      return t('notify.enable.registerFailed', { reason: describeError(outcome.error, t) });
  }
}

/** The outcome of a test send in one sentence: "Sent to 2 devices", "No device accepted it", or why. */
export function testSummary(result: PushTestResult, t: Translator): string {
  if (result.devices.length === 0) return t('notify.test.noDevices');
  if (result.sent === 0) return t('notify.test.noneAccepted');
  return t.plural('notify.test.sentTo', result.sent);
}

/** The answer of a test send that was refused (rate limit, no device). */
export function testRefusal(error: unknown, t: Translator): string {
  if (isApiError(error) && error.code === 'rate_limited') {
    const seconds = error.retryAfterSeconds;
    return seconds ? t('notify.test.wait', { duration: t.duration(seconds) }) : t('notify.test.tooOften');
  }
  return describeError(error, t);
}

export interface PushStatusProps {
  setup: PushSetup;
  /** `card` on the notifications page; `banner` at the top of a project's automations. */
  variant: 'card' | 'banner';
  /** Where a test is said to come from: decides what tapping it opens. */
  origin: 'settings' | 'automations';
}

/**
 * This device's push state as one clear status with at most one fixing
 * action. The same states, in fewer words, head a project's automations.
 */
export function PushStatus({ setup, variant, origin }: PushStatusProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { state, device } = setup;
  const presentation = presentPushState(state, device.browser.ios && device.browser.standalone);
  // On the settings page a test has a row of its own, under the devices it reports on.
  const offered = pushActionFor(state);
  const action = variant === 'card' && offered === 'test' ? null : offered;
  const devices = setup.settings.data?.push.devices.length ?? 0;

  const run = async () => {
    if (busy || !action) return;
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      if (action === 'enable' || action === 'enable-device') {
        const outcome = await setup.enable();
        if (outcome.ok) setNote(t('notify.enable.done'));
        else setProblem(enableProblem(outcome, t));
      } else if (action === 'turn-on') {
        await setup.turnOn();
        setNote(t('notify.turnedOn'));
      } else {
        const result = await setup.test(origin);
        setNote(testSummary(result, t));
      }
    } catch (error) {
      setProblem(action === 'test' ? testRefusal(error, t) : describeError(error, t));
    } finally {
      setBusy(false);
    }
  };

  const label =
    action === 'enable'
      ? t('notify.action.enable')
      : action === 'enable-device'
        ? t('notify.action.enableDevice')
        : action === 'turn-on'
          ? t('notify.action.turnOn')
          : action === 'test'
            ? t('notify.action.test')
            : null;

  const line =
    state.kind === 'on' && devices > 1 ? t.plural('notify.state.on.lineMany', devices - 1) : state.kind === 'checking' ? t('notify.state.checking') : t(presentation.line);

  if (variant === 'banner') {
    return (
      <div className="ntf-banner" data-state={state.kind} role="status">
        <Glyph icon={presentation.icon} tint={presentation.tint} size={30} />
        <div className="ntf-banner__text">
          <p>{line}</p>
          {(note || problem) && (
            <p className="ntf-banner__note" data-tone={problem ? 'danger' : 'neutral'} role={problem ? 'alert' : undefined}>
              {problem ?? note}
            </p>
          )}
        </div>
        {label && (
          <Button size="sm" variant={action === 'test' ? 'neutral' : 'tinted'} loading={busy} onClick={() => void run()}>
            {label}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="ntf-card" data-state={state.kind}>
      <div className="ntf-card__head">
        <Glyph icon={presentation.icon} tint={presentation.tint} size={40} />
        <div className="ntf-card__text">
          <p className="ntf-card__eyebrow">{t('notify.thisDevice')}</p>
          <p className="ntf-card__title">
            {state.kind === 'checking' && <Spinner size={16} />}
            {t(presentation.title)}
          </p>
        </div>
      </div>
      {state.kind !== 'checking' && <p className="ntf-card__body">{t(presentation.text)}</p>}
      {state.kind === 'needs-install' && (
        <ol className="ntf-steps">
          <li>{t('notify.install.step1')}</li>
          <li>{t('notify.install.step2')}</li>
          <li>{t('notify.install.step3')}</li>
        </ol>
      )}
      {(note || problem) && (
        <p className="ntf-card__note" data-tone={problem ? 'danger' : 'positive'} role={problem ? 'alert' : 'status'}>
          {problem ?? note}
        </p>
      )}
      {label && (
        <div className="ntf-card__actions">
          <Button variant={action === 'test' ? 'neutral' : 'primary'} loading={busy} onClick={() => void run()}>
            {label}
          </Button>
        </div>
      )}
    </div>
  );
}
