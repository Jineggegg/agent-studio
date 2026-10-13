import { fileURLToPath } from 'node:url';

/** Workspace packages resolve to their sources, so tests never need a build first. */
export const alias = {
  '@agent-studio/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
  '@agent-studio/plugin-sdk': fileURLToPath(new URL('../../packages/plugin-sdk/src/index.ts', import.meta.url)),
};
