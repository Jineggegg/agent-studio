import { useState } from 'react';
import { type MessageKey, hasMessage, useT } from '@/i18n';
import { Banner, Button } from '@/ui';
import { type Outgoing, canRetry } from './delivery';

export interface DeliveryBannerProps {
  outgoing: Outgoing;
  /** No network at all: checking is pointless until it returns. */
  offline: boolean;
  onCheck: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * Says what became of a message whose delivery did not go to plan.
 *
 *  - *unconfirmed*: nobody knows whether it arrived. The original is shown
 *    for review, and can be checked; it can be sent again only once the
 *    server has said it never received it.
 *  - *failed*: the server refused it. Nothing was sent and nothing is lost.
 */
export function DeliveryBanner({ outgoing, offline, onCheck, onRetry, onDismiss }: DeliveryBannerProps) {
  const t = useT();
  const [reviewing, setReviewing] = useState(false);

  if (outgoing.phase === 'failed') {
    const key = `errors.${outgoing.refusal?.code ?? ''}`;
    const reason = hasMessage(key) ? t(key as MessageKey) : (outgoing.refusal?.message ?? t('errors.unknown'));
    return (
      <Banner
        tone="danger"
        title={t('workbench.delivery.failedTitle')}
        className="wb-delivery"
        action={
          <Button size="sm" variant="plain" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        }
      >
        <p>{t('workbench.delivery.failedDetail', { reason })}</p>
      </Banner>
    );
  }
  if (outgoing.phase !== 'unconfirmed' && outgoing.phase !== 'checking') return null;

  const checking = outgoing.phase === 'checking';
  const detail =
    outgoing.verdict === 'not-received'
      ? t('workbench.delivery.notReceived')
      : outgoing.verdict === 'unverifiable'
        ? t('workbench.delivery.unverifiable')
        : offline
          ? t('workbench.delivery.unconfirmedOffline')
          : t('workbench.delivery.unconfirmedDetail');

  return (
    <Banner tone="warning" title={t('workbench.delivery.unconfirmedTitle')} className="wb-delivery" role="alert">
      <p>{detail}</p>
      {reviewing && <p className="wb-delivery__original">{outgoing.payload.text || t('workbench.delivery.attachmentsOnly')}</p>}
      <div className="wb-delivery__actions">
        <Button size="sm" variant="plain" onClick={() => setReviewing(!reviewing)} aria-expanded={reviewing}>
          {reviewing ? t('workbench.delivery.hideOriginal') : t('workbench.delivery.showOriginal')}
        </Button>
        {canRetry(outgoing) ? (
          <Button size="sm" variant="primary" onClick={onRetry} disabled={offline}>
            {t('workbench.delivery.sendAgain')}
          </Button>
        ) : (
          <Button size="sm" variant="tinted" onClick={onCheck} loading={checking} loadingLabel={t('workbench.delivery.checking')} disabled={offline}>
            {outgoing.verdict === 'unverifiable' ? t('workbench.delivery.checkAgain') : t('workbench.delivery.check')}
          </Button>
        )}
      </div>
    </Banner>
  );
}
