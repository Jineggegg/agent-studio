import { z } from 'zod';

/**
 * The schema library can compile validators with `new Function` for speed,
 * and it probes for that ability the first time an object is parsed. Under
 * this app's Content-Security-Policy (`script-src 'self'`, no eval) the probe
 * is refused and logged as a violation on every page load. Telling the
 * library up front never to try keeps the console — and CSP reports — clean.
 *
 * Imported for its side effect by the HTTP client, so it runs before any parse.
 */
z.config({ jitless: true });
