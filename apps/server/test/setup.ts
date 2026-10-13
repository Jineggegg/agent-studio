import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests must never start the real agent CLIs: that would spend the
 * developer's quota, depend on their sign-in and take seconds per start. The
 * stand-ins in tests/fixtures/bin are put first on PATH, which the server
 * under test inherits when it builds child environments. A test that needs a
 * missing or different CLI rearranges PATH itself.
 */
const standIns = fileURLToPath(new URL('../../../tests/fixtures/bin', import.meta.url));
const current = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '' && entry !== standIns);
process.env.PATH = [standIns, ...current].join(path.delimiter);
