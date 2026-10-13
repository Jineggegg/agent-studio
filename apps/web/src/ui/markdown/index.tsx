import { Check, Copy, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { type ComponentProps, type MouseEvent, type ReactNode, memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { classifyUrl, isInlineImageData } from './url';
import './markdown.css';

export interface MarkdownProps {
  /** The Markdown source. Treated as untrusted. */
  children: string;
  /**
   * What tapping a remote image does. `open` (default) opens it in a new tab;
   * `inline` loads it in place — use that only where the Content-Security-Policy
   * allows the image's origin, or together with `resolveImage`.
   */
  remoteImages?: 'open' | 'inline';
  /**
   * Maps an image reference to a same-origin URL that may be shown directly
   * (a file of the open project, say). Return null to leave it as a placeholder.
   */
  resolveImage?: (src: string) => string | null;
  /** Handle a link yourself (an in-app path). Call `event.preventDefault()` when you did. */
  onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Tighter spacing, for chat bubbles and notes in lists. */
  compact?: boolean;
  className?: string;
}

export interface CodeBlockProps {
  /** Highlighted (or plain) code. */
  children: ReactNode;
  /** Shown in the header; purely informative. */
  language?: string | undefined;
  /** The exact text to copy. Without it the block's rendered text is copied. */
  text?: string;
}

/** A block of code with its language and a copy button. Scrolls sideways rather than wrapping. */
export function CodeBlock({ children, language, text }: CodeBlockProps) {
  const t = useT();
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const content = text ?? pre.current?.textContent ?? '';
    if (await copyText(content.replace(/\n$/, ''))) setCopied(true);
  };

  return (
    <div className="ui-code">
      <div className="ui-code__bar">
        <span className="ui-code__language">{language ?? t('markdown.code')}</span>
        <button type="button" className="ui-code__copy" onClick={() => void copy()} aria-label={copied ? t('common.copied') : t('markdown.copyCode')}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          <span aria-live="polite">{copied ? t('common.copied') : t('common.copy')}</span>
        </button>
      </div>
      <pre ref={pre} tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}

function languageOf(className: unknown): string | undefined {
  const match = /language-([\w+#.-]+)/.exec(typeof className === 'string' ? className : Array.isArray(className) ? className.join(' ') : '');
  return match?.[1];
}

function RemoteImage({ href, host, alt, mode }: { href: string; host: string; alt: string; mode: 'open' | 'inline' }) {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (loaded && !failed) {
    return <img className="ui-markdown__image" src={href} alt={alt} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  }
  const label = alt || t('markdown.image');
  if (mode === 'open' || failed) {
    return (
      <a className="ui-markdown__image-placeholder" href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        <ImageIcon size={18} aria-hidden="true" />
        <span>
          <span className="ui-markdown__image-alt">{label}</span>
          <span className="ui-markdown__image-host">{failed ? t('markdown.imageFailed', { host }) : t('markdown.imageOpen', { host })}</span>
        </span>
        <ExternalLink size={16} aria-hidden="true" />
      </a>
    );
  }
  return (
    <button type="button" className="ui-markdown__image-placeholder" onClick={() => setLoaded(true)}>
      <ImageIcon size={18} aria-hidden="true" />
      <span>
        <span className="ui-markdown__image-alt">{label}</span>
        <span className="ui-markdown__image-host">{t('markdown.imageLoad', { host })}</span>
      </span>
    </button>
  );
}

/**
 * Renders untrusted Markdown (GitHub flavour) safely:
 *
 *  - raw HTML in the source is dropped, never interpreted;
 *  - links keep only http(s) and relative targets, and open in a new tab
 *    without handing over an opener or a referrer;
 *  - remote images are not fetched until the reader taps them;
 *  - code blocks are highlighted and get a copy button.
 */
export const Markdown = memo(function Markdown({ children, remoteImages = 'open', resolveImage, onLinkClick, compact, className }: MarkdownProps) {
  const t = useT();

  const components: Components = {
    a({ href, children: content, title }) {
      const url = classifyUrl(href);
      if (!url) return <span className="ui-markdown__dead-link">{content}</span>;
      const samePage = url.kind === 'relative' && url.href.startsWith('#');
      return (
        <a
          href={url.href}
          title={title}
          {...(samePage ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow', referrerPolicy: 'no-referrer' as const })}
          onClick={onLinkClick ? (event) => onLinkClick(url.href, event) : undefined}
        >
          {content}
        </a>
      );
    },
    img({ src, alt }) {
      const source = typeof src === 'string' ? src : '';
      const text = alt ?? '';
      const resolved = resolveImage?.(source);
      if (resolved) return <img className="ui-markdown__image" src={resolved} alt={text} loading="lazy" decoding="async" />;
      if (isInlineImageData(source)) return <img className="ui-markdown__image" src={source.trim()} alt={text} />;
      const url = classifyUrl(source);
      if (url?.kind === 'remote') return <RemoteImage href={url.href} host={url.host} alt={text} mode={remoteImages} />;
      // Unresolvable or disallowed: the alternative text stands in for the picture.
      return (
        <span className="ui-markdown__image-missing">
          <ImageIcon size={16} aria-hidden="true" />
          {text || t('markdown.image')}
        </span>
      );
    },
    pre({ children: content, node }) {
      const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
      const language = code && code.type === 'element' ? languageOf(code.properties?.className) : undefined;
      return <CodeBlock language={language}>{content}</CodeBlock>;
    },
    table({ children: content }) {
      return (
        <div className="ui-markdown__table" tabIndex={0} role="region" aria-label={t('markdown.table')}>
          <table>{content}</table>
        </div>
      );
    },
    input(props: ComponentProps<'input'>) {
      // Task-list checkboxes are a picture of a list, not a control.
      return <input {...props} disabled readOnly tabIndex={-1} />;
    },
  };

  return (
    <div className={['ui-markdown', className].filter(Boolean).join(' ')} data-compact={compact || undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, plainText: ['text', 'txt', 'plain', 'plaintext', 'output', 'console', 'log'] }]]}
        skipHtml
        // Second line of defence; the elements above apply the same policy and decide what stands in for a dropped URL.
        urlTransform={(url, key) => ((key === 'src' && isInlineImageData(url)) || classifyUrl(url) ? url : '')}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
export { classifyUrl } from './url';
