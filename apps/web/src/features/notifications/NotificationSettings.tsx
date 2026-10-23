import type { PushDevice, PushTestResult } from '@agent-studio/protocol';
import { BellRing, Monitor, Send, Smartphone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useConnectionState, useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { type Translator, useT } from '@/i18n';
import {
  Badge,
  ErrorState,
  Glyph,
  List,
  ListRow,
  LoadingRow,
  Spinner,
  StaleNotice,
  Switch,
  confirm,
  toast,
} from '@/ui';
import { PushStatus, testRefusal, testSummary } from './PushStatus';
import { NotificationSwitches, SwitchProblem, usePreferenceSwitches } from './Switches';
import { usePushSetup } from './state';
import './notifications.css';
import { ExternalChannels } from './ExternalChannels';

const MOBILE = /iphone|ipad|android|mobile|phone|home screen|主屏幕/i;

function outcomeText(device: PushTestResult['devices'][number], t: Translator): string {
  switch (device.outcome) {
    case 'sent':
      return t('notify.test.outcome.sent');
    case 'gone':
      return t('notify.test.outcome.gone');
    case 'rejected':
      return device.httpStatus
        ? t('notify.test.outcome.rejectedStatus', { status: device.httpStatus })
        : t('notify.test.outcome.rejected');
    case 'unreachable':
      return t('notify.test.outcome.unreachable');
    case 'signed-out':
      return t('notify.test.outcome.signedOut');
  }
}

function deviceSubtitle(device: PushDevice, t: Translator): string {
  const enabled = t('notify.device.enabled', { date: t.date(device.createdAt, 'short') });
  return device.lastDeliveredAt
    ? `${enabled} · ${t('notify.device.delivered', { when: t.relative(device.lastDeliveredAt) })}`
    : enabled;
}

/**
 * Notifications: whether this device can receive them (one status, at most
 * one action), the devices of the account, a test with its per-device report,
 * and which events notify — each switch on its own.
 */
export default function NotificationSettings() {
  const t = useT();
  const setup = usePushSetup();
  const connection = useConnectionState();
  const { settings, device } = setup;
  const switches = usePreferenceSwitches(settings.data, device.hash);
  const { stale, since } = useStaleness(settings);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<{
    result: PushTestResult | null;
    text: string;
    failed: boolean;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const offline = connection === 'offline';

  if (!settings.data) {
    if (settings.isError)
      return (
        <ErrorState
          error={settings.error}
          onRetry={() => void settings.refetch()}
          retrying={settings.isFetching}
          compact
        />
      );
    return (
      <>
        <PushStatus setup={setup} variant="card" origin="settings" />
        <LoadingRow label={t('common.loading')} />
      </>
    );
  }

  const data = settings.data;
  const devices = data.push.devices;
  const webPushOn = switches.value('channels.webPush');

  const sendTest = async () => {
    if (testing) return;
    setTesting(true);
    setReport(null);
    try {
      const result = await setup.test('settings');
      setReport({ result, text: testSummary(result, t), failed: result.sent === 0 });
    } catch (error) {
      setReport({ result: null, text: testRefusal(error, t), failed: true });
    } finally {
      setTesting(false);
    }
  };

  const remove = async (entry: PushDevice) => {
    const confirmed = await confirm({
      title: t('notify.device.removeTitle', { name: entry.label }),
      message: entry.current ? t('notify.device.removeThis') : t('notify.device.removeOther'),
      confirmLabel: t('common.remove'),
      tone: 'danger',
    });
    if (!confirmed) return;
    setRemoving(entry.id);
    try {
      await setup.removeDevice(entry.id, entry.current);
      setReport(null);
      toast.success(t('notify.device.removed', { name: entry.label }));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="ntf-page">
      {stale && (
        <div className="ntf-stale">
          <StaleNotice since={since} />
        </div>
      )}
      <PushStatus setup={setup} variant="card" origin="settings" />
      <SwitchProblem switches={switches} />

      <List
        header={t('notify.devices.header')}
        footer={t('notify.devices.footer', { max: data.push.maxDevices })}
      >
        <ListRow
          leading={<Glyph icon={<BellRing size={18} />} tint="red" />}
          title={t('notify.webPush.title')}
          subtitle={
            devices.length > 0
              ? t.plural('notify.webPush.devices', devices.length)
              : t('notify.webPush.none')
          }
          control={
            <Switch
              checked={webPushOn}
              disabled={offline || (devices.length === 0 && !webPushOn)}
              onChange={(on) => switches.toggle('channels.webPush', on)}
            />
          }
        />
        {devices.map((entry) => (
          <ListRow
            key={entry.id}
            leading={
              <Glyph
                icon={MOBILE.test(entry.label) ? <Smartphone size={18} /> : <Monitor size={18} />}
                tint="slate"
              />
            }
            title={entry.label}
            subtitle={deviceSubtitle(entry, t)}
            trailing={
              removing === entry.id ? (
                <Spinner size={18} label={t('notify.device.removing')} />
              ) : entry.current ? (
                <Badge tone="accent">{t('notify.device.this')}</Badge>
              ) : undefined
            }
            actionsLabel={t('notify.device.actions', { name: entry.label })}
            actions={[
              {
                id: 'remove',
                label: t('common.remove'),
                icon: <Trash2 size={18} />,
                tone: 'danger',
                onSelect: () => void remove(entry),
              },
            ]}
          />
        ))}
        <ListRow
          leading={<Glyph icon={<Send size={18} />} tint="blue" />}
          title={t('notify.test.title')}
          subtitle={devices.length === 0 ? t('notify.test.needsDevice') : t('notify.test.text')}
          disabled={devices.length === 0 || testing || offline}
          onPress={() => void sendTest()}
          trailing={testing ? <Spinner size={18} label={t('notify.test.sending')} /> : undefined}
          chevron={false}
        />
      </List>

      {report && (
        <section
          className="ntf-report"
          aria-live="polite"
          data-tone={report.failed ? 'danger' : 'positive'}
        >
          <p className="ntf-report__title">{report.text}</p>
          {report.result && report.result.devices.length > 0 && (
            <ul className="ntf-report__list">
              {report.result.devices.map((entry) => (
                <li key={entry.id} data-outcome={entry.outcome}>
                  <span className="ntf-report__dot" aria-hidden="true" />
                  <span className="ntf-report__name">
                    {entry.label}
                    {entry.current ? ` · ${t('notify.device.this')}` : ''}
                  </span>
                  <span className="ntf-report__outcome">
                    {outcomeText(entry, t)}
                    {entry.removed ? ` ${t('notify.test.outcome.removed')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {report.result && !report.result.enabled && (
            <p className="ntf-report__hint">{t('notify.test.switchOff')}</p>
          )}
        </section>
      )}

      <NotificationSwitches switches={switches} disabled={offline} />
      <ExternalChannels />
    </div>
  );
}
