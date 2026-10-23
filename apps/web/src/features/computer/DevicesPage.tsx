import type { ComputerAction, ComputerProposal } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Button, ErrorState, List, ListRow, TextArea, TextField, confirm, toast } from '@/ui';
import { computerApi } from './api';
import './computer.css';

export default function DevicesPage() {
  const t = useT();
  const devices = useQuery({
    queryKey: ['computer-devices'],
    queryFn: computerApi.devices,
    refetchInterval: 10_000,
  });
  const actions = useQuery({
    queryKey: ['computer-actions'],
    queryFn: computerApi.actions,
    refetchInterval: 5000,
  });
  const [pair, setPair] = useState<{ token: string; expiresAt: number } | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [kind, setKind] = useState<ComputerAction['kind']>('screenshot');
  const [text, setText] = useState('');
  const [x, setX] = useState('0'),
    [y, setY] = useState('0');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pair) return;
    const timer = setTimeout(() => setPair(null), Math.max(0, pair.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pair]);
  useEffect(() => {
    if (!image) return;
    const timer = setTimeout(() => setImage(null), 5 * 60_000);
    return () => clearTimeout(timer);
  }, [image]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await devices.refetch();
      await actions.refetch();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const approve = async (row: ComputerProposal) => {
    if (
      await confirm({
        title: t('computer.approve'),
        message: t('computer.approveConfirm'),
        confirmLabel: t('computer.approve'),
      })
    )
      await computerApi.approve(row.id, row.action);
  };
  const propose = () => {
    const action: ComputerAction =
      kind === 'screenshot'
        ? { kind }
        : kind === 'click'
          ? { kind, x: Number(x), y: Number(y) }
          : { kind, text };
    return computerApi.propose(
      deviceId || devices.data!.devices[0]!.id,
      action,
      t('computer.manual'),
    );
  };
  return (
    <section className="computer-page">
      <p>{t('computer.intro')}</p>
      <Button
        disabled={busy}
        onClick={() => void run(async () => setPair(await computerApi.pair()))}
      >
        {t('computer.pair')}
      </Button>
      {pair && (
        <div className="computer-pair">
          <p>{t('computer.pairHint')}</p>
          <TextField label={t('computer.code')} value={pair.token} onChange={() => {}} readOnly />
        </div>
      )}
      {devices.isError && (
        <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
      )}
      {devices.data?.devices.length === 0 && <p>{t('computer.empty')}</p>}
      <List>
        {devices.data?.devices.map((device) => (
          <ListRow
            key={device.id}
            title={device.name}
            subtitle={`${t(device.lastSeenAt !== null && Date.now() - device.lastSeenAt < 30_000 ? 'computer.online' : 'computer.offline')} · ${device.width} × ${device.height}`}
            trailing={
              <Button
                size="sm"
                variant="plain"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      await confirm({
                        title: t('computer.revoke'),
                        message: t('computer.revokeConfirm'),
                        confirmLabel: t('computer.revoke'),
                        tone: 'danger',
                      })
                    )
                      await computerApi.revoke(device.id);
                  })
                }
              >
                {t('computer.revoke')}
              </Button>
            }
          />
        ))}
      </List>
      {Boolean(devices.data?.devices.length) && (
        <div className="computer-form">
          <label>
            {t('computer.title')}
            <select
              value={deviceId || devices.data!.devices[0]!.id}
              onChange={(event) => setDeviceId(event.target.value)}
            >
              {devices.data!.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('computer.propose')}
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ComputerAction['kind'])}
            >
              <option value="screenshot">{t('computer.screenshot')}</option>
              <option value="click">{t('computer.click')}</option>
              <option value="type">{t('computer.type')}</option>
            </select>
          </label>
          {kind === 'type' && (
            <TextArea label={t('computer.text')} value={text} onChange={setText} maxLength={2000} />
          )}
          {kind === 'click' && (
            <>
              <TextField
                label={t('computer.x')}
                type="number"
                min={0}
                max={32767}
                value={x}
                onChange={setX}
              />
              <TextField
                label={t('computer.y')}
                type="number"
                min={0}
                max={32767}
                value={y}
                onChange={setY}
              />
            </>
          )}
          <Button disabled={busy || (kind === 'type' && !text)} onClick={() => void run(propose)}>
            {t('computer.propose')}
          </Button>
        </div>
      )}
      <h2>{t('computer.actions')}</h2>
      {actions.isError && (
        <ErrorState error={actions.error} onRetry={() => void actions.refetch()} />
      )}
      {actions.data?.actions.length === 0 && <p>{t('computer.noActions')}</p>}
      {actions.data?.actions.map((row) => (
        <article className="computer-action" key={row.id}>
          <strong>
            {devices.data?.devices.find((device) => device.id === row.deviceId)?.name ??
              row.deviceId}{' '}
            · {t(`computer.${row.status}`)}
          </strong>
          <p>{row.reason}</p>
          <pre>
            {row.action.kind === 'screenshot'
              ? t('computer.screenshot')
              : row.action.kind === 'click'
                ? `${t('computer.click')}: (${row.action.x}, ${row.action.y})`
                : `${t('computer.type')}:\n${row.action.text}`}
          </pre>
          {row.result && <p>{row.result}</p>}
          <div className="computer-buttons">
            {row.status === 'pending' && (
              <Button disabled={busy} onClick={() => void run(() => approve(row))}>
                {t('computer.approve')}
              </Button>
            )}
            {['pending', 'approved', 'leased'].includes(row.status) && (
              <Button
                variant="plain"
                disabled={busy}
                onClick={() => void run(() => computerApi.reject(row.id))}
              >
                {t('computer.reject')}
              </Button>
            )}
            {row.screenshotAvailable && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await computerApi.screenshot(row.id);
                    setImage(`data:${result.mediaType};base64,${result.data}`);
                  })
                }
              >
                {t('computer.view')}
              </Button>
            )}
          </div>
        </article>
      ))}
      {image && (
        <div>
          <p>{t('computer.imageHint')}</p>
          <img className="computer-screenshot" src={image} alt={t('computer.image')} />
          <Button onClick={() => setImage(null)}>{t('computer.dismiss')}</Button>
        </div>
      )}
    </section>
  );
}
