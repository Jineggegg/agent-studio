import {
  Cloud,
  Copy,
  ExternalLink,
  Globe2,
  Laptop,
  LockKeyhole,
  RefreshCw,
  Server,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import {
  Badge,
  Button,
  ErrorState,
  LoadingRow,
  SegmentedControl,
  StaleNotice,
  TextField,
  toast,
} from '@/ui';
import { useSystemInfo } from '../api';
import { domainConfig, domainHostname, servicePort } from './config';
import './domain.css';

function CopyBlock({ title, text }: { title: string; text: string }) {
  const t = useT();
  const copy = async () => {
    if (await copyText(text)) toast.success(t('common.copied'));
    else toast.error(t('domain.copy.failed'));
  };
  return (
    <div className="domain-code">
      <div className="domain-code__bar">
        <span>{title}</span>
        <Button
          size="sm"
          variant="plain"
          icon={<Copy size={16} aria-hidden="true" />}
          aria-label={t('domain.copy', { name: title })}
          onClick={() => void copy()}
        >
          {t('common.copy')}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={title}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function ExternalLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="domain-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

export default function DomainPage() {
  const t = useT();
  const info = useSystemInfo();
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState('7420');
  const [method, setMethod] = useState<'caddy' | 'cloudflare'>('caddy');
  const config = domainConfig(domain, port);
  const origins = info.data?.publicOrigins ?? [];
  const configured = config !== null && origins.includes(config.origin);

  return (
    <div className="domain-page">
      <section className="domain-hero" aria-labelledby="domain-hero-title">
        <div className="domain-hero__icon">
          <Globe2 size={32} aria-hidden="true" />
        </div>
        <p className="domain-eyebrow">{t('domain.eyebrow')}</p>
        <h2 id="domain-hero-title">{t('domain.hero')}</h2>
        <p>{t('domain.intro')}</p>
        <div className="domain-benefits">
          <span>
            <Server size={15} aria-hidden="true" />
            {t('domain.private')}
          </span>
          <span>
            <LockKeyhole size={15} aria-hidden="true" />
            {t('domain.secure')}
          </span>
          <span>
            <Laptop size={15} aria-hidden="true" />
            {t('domain.devices')}
          </span>
        </div>
      </section>
      <section className="domain-status" aria-labelledby="domain-status-title">
        <div className="domain-status__head">
          <h3 id="domain-status-title">{t('domain.current')}</h3>
          <Button
            size="sm"
            variant="plain"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            loading={info.isFetching}
            onClick={() => void info.refetch()}
          >
            {t('domain.refresh')}
          </Button>
        </div>
        {info.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : !info.data ? (
          <ErrorState error={info.error} onRetry={() => void info.refetch()} compact />
        ) : (
          <>
            {info.isError && <StaleNotice since={info.dataUpdatedAt} />}
            {config ? (
              <Badge tone={configured ? 'positive' : 'neutral'}>
                {t(configured ? 'domain.current.ready' : 'domain.current.pending')}
              </Badge>
            ) : null}
            {origins.length > 0 ? (
              <ul className="domain-origins">
                {origins.map((origin) => (
                  <li key={origin}>{origin}</li>
                ))}
              </ul>
            ) : (
              <p>{t('domain.current.empty')}</p>
            )}
          </>
        )}
        <p className="domain-hint">{t('domain.current.hint')}</p>
      </section>
      <section className="domain-card" aria-labelledby="domain-address-title">
        <h3 id="domain-address-title">{t('domain.address')}</h3>
        <div className="domain-fields">
          <TextField
            label={t('domain.name')}
            value={domain}
            onChange={setDomain}
            placeholder="harness.example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={253}
            hint={t('domain.name.hint')}
            error={domain && !domainHostname(domain) ? t('domain.name.error') : undefined}
            leading={<Globe2 size={18} aria-hidden="true" />}
          />
          <TextField
            label={t('domain.port')}
            value={port}
            onChange={setPort}
            inputMode="numeric"
            maxLength={5}
            hint={t('domain.port.hint')}
            error={servicePort(port) === null ? t('domain.port.error') : undefined}
          />
        </div>
        <SegmentedControl
          label={t('domain.method')}
          value={method}
          onChange={setMethod}
          options={[
            {
              value: 'caddy',
              label: t('domain.caddy'),
              icon: <Server size={17} aria-hidden="true" />,
            },
            {
              value: 'cloudflare',
              label: t('domain.cloudflare'),
              icon: <Cloud size={17} aria-hidden="true" />,
            },
          ]}
        />
        <p className="domain-hint">
          {t(method === 'caddy' ? 'domain.caddy.hint' : 'domain.cloudflare.hint')}
        </p>
      </section>
      {!config ? (
        <p className="domain-empty">{t('domain.empty')}</p>
      ) : (
        <>
          <section className="domain-card" aria-labelledby="domain-setup-title">
            <h3 id="domain-setup-title">{t('domain.setup')}</h3>
            <p className="domain-hint">{t('domain.manual')}</p>
            <ol className="domain-steps">
              {method === 'caddy' ? (
                <>
                  <li>
                    <h4>{t('domain.dns.title')}</h4>
                    <p>{t('domain.dns.detail', { domain: config.hostname })}</p>
                  </li>
                  <li>
                    <h4>{t('domain.proxy.title')}</h4>
                    <p>{t('domain.proxy.detail')}</p>
                    <CopyBlock title={t('domain.caddyfile')} text={config.caddyfile} />
                    <ExternalLinkButton href="https://caddyserver.com/docs/quick-starts/https">
                      {t('domain.proxy.docs')}
                    </ExternalLinkButton>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <h4>{t('domain.tunnel.title')}</h4>
                    <p>{t('domain.tunnel.detail')}</p>
                    <ExternalLinkButton href="https://developers.cloudflare.com/tunnel/get-started/">
                      {t('domain.route.docs')}
                    </ExternalLinkButton>
                  </li>
                  <li>
                    <h4>{t('domain.route.title')}</h4>
                    <p>{t('domain.route.detail')}</p>
                    <CopyBlock title={t('domain.route.host')} text={config.hostname} />
                    <CopyBlock title={t('domain.route.service')} text={config.service} />
                    <p>{t('domain.access')}</p>
                  </li>
                </>
              )}
              <li>
                <h4>{t('domain.environment.title')}</h4>
                <p>{t('domain.environment.detail')}</p>
                <CopyBlock title={t('domain.environment')} text={config.environment} />
              </li>
              <li>
                <h4>{t('domain.restart.title')}</h4>
                <p>{t('domain.restart.detail')}</p>
              </li>
            </ol>
          </section>
          <section className="domain-card" aria-labelledby="domain-verify-title">
            <h3 id="domain-verify-title">{t('domain.verify')}</h3>
            <p>{t('domain.verify.detail')}</p>
            <CopyBlock title={t('domain.check')} text={config.healthCheck} />
            <p className="domain-hint">{t('domain.passkeys')}</p>
            <ExternalLinkButton href={config.origin}>{t('domain.open')}</ExternalLinkButton>
          </section>
        </>
      )}
      <ExternalLinkButton href="https://github.com/Jineggegg/cloud-harness/blob/main/docs/deployment/remote-access.md">
        {t('domain.guide')}
      </ExternalLinkButton>
    </div>
  );
}
