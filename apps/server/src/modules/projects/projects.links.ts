import type { IncomingHttpHeaders } from 'node:http';
import type { ProjectLink, ProjectLinkStatus } from '@agent-studio/protocol';
import { isStudioError } from '../../kernel/errors.js';
import { guardedRequest, type NetPolicy } from '../../kernel/net.js';

export interface LinkProbeOptions {
  /** Time allowed for one link, redirects included. */
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** How long an answer is reused. */
  readonly cacheMs?: number;
}

const DEFAULTS = { timeoutMs: 6000, maxRedirects: 4, cacheMs: 60_000 } as const;
const MAX_CACHE_ENTRIES = 500;

/** A site that sends either of these does not want to be shown inside another page. */
function isFrameable(headers: IncomingHttpHeaders): boolean {
  if (headers['x-frame-options'] !== undefined) return false;
  const policies = headers['content-security-policy'];
  const text = Array.isArray(policies) ? policies.join(';') : (policies ?? '');
  const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(text);
  if (!ancestors) return true;
  // Anything short of "everyone" is treated as "not us": the Studio's own origin is not known to the site.
  return ancestors[1]!.trim().split(/\s+/).includes('*');
}

/**
 * Tells whether a project's links answer, and how fast.
 *
 * This is the one place where the server contacts addresses chosen by users,
 * so it is deliberately narrow: it probes only links stored on a project,
 * every hop goes through the kernel's guarded request (the address is vetted
 * after DNS resolution, link-local addresses are never contacted), a private
 * address is contacted only for links the owner marked as local, redirects
 * are followed a few times under the same rule, and the answer's body is never
 * read — only its status line and headers.
 */
export class LinkProber {
  readonly #options: Required<LinkProbeOptions>;
  readonly #cache = new Map<string, { at: number; result: Omit<ProjectLinkStatus, 'linkId'> }>();
  readonly #inFlight = new Map<string, Promise<Omit<ProjectLinkStatus, 'linkId'>>>();

  constructor(options: LinkProbeOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  async probeAll(links: readonly ProjectLink[], refresh = false): Promise<ProjectLinkStatus[]> {
    return Promise.all(links.map(async (link) => ({ linkId: link.id, ...(await this.#probeCached(link, refresh)) })));
  }

  #probeCached(link: ProjectLink, refresh: boolean): Promise<Omit<ProjectLinkStatus, 'linkId'>> {
    const key = `${link.local ? 'local' : 'public'} ${link.url}`;
    const cached = this.#cache.get(key);
    // A forced refresh still reuses an answer that is only moments old.
    const maxAge = refresh ? Math.min(5000, this.#options.cacheMs) : this.#options.cacheMs;
    if (cached && Date.now() - cached.at < maxAge) return Promise.resolve(cached.result);
    const running = this.#inFlight.get(key);
    if (running) return running;
    const started = this.#probe(link)
      .then((result) => {
        if (this.#cache.size >= MAX_CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!);
        this.#cache.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, started);
    return started;
  }

  async #probe(link: ProjectLink): Promise<Omit<ProjectLinkStatus, 'linkId'>> {
    const policy: NetPolicy = { allowHttp: true, allowPrivateNetwork: link.local };
    const startedAt = Date.now();
    const deadline = startedAt + this.#options.timeoutMs;
    const failed = (state: 'unreachable' | 'blocked'): Omit<ProjectLinkStatus, 'linkId'> => ({
      state,
      status: null,
      latencyMs: null,
      frameable: null,
      checkedAt: Date.now(),
    });

    let url = link.url;
    let method: 'HEAD' | 'GET' = 'HEAD';
    let redirects = 0;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failed('unreachable');
      let status: number;
      let headers: IncomingHttpHeaders;
      try {
        const response = await guardedRequest(url, {
          method,
          policy,
          timeoutMs: remaining,
          headers: { 'user-agent': 'AgentStudio-LinkCheck', accept: '*/*' },
        });
        // Only the status line and the headers are of interest; the body is dropped unread.
        response.body.destroy();
        status = response.status;
        headers = response.headers;
      } catch (error) {
        if (isStudioError(error) && error.code !== 'upstream_unreachable') return failed('blocked');
        return failed('unreachable');
      }

      const location = headers.location;
      if (status >= 300 && status < 400 && typeof location === 'string') {
        redirects += 1;
        if (redirects > this.#options.maxRedirects) return failed('blocked');
        try {
          url = new URL(location, url).href;
        } catch {
          return failed('blocked');
        }
        continue;
      }
      // Some sites refuse HEAD; ask again the ordinary way, still without reading the body.
      if (method === 'HEAD' && (status === 405 || status === 501 || status === 400 || status === 403)) {
        method = 'GET';
        continue;
      }
      return {
        state: status < 400 ? 'ok' : 'http_error',
        status,
        latencyMs: Date.now() - startedAt,
        frameable: isFrameable(headers),
        checkedAt: Date.now(),
      };
    }
  }
}
