import type { AgentCapabilities } from '@agent-studio/protocol';
import { unprocessable } from '../../kernel/errors.js';

/** A capability is not an entitlement guarantee: the provider may still refuse the turn. */
export function requireFastMode(
  agentId: string,
  model: string | null,
  capabilities: AgentCapabilities | undefined,
): void {
  const modelSupported =
    agentId === 'codex'
      ? capabilities?.models.find((entry) => entry.id === model)?.fastMode === true
      : agentId === 'claude-code'
        ? /^opus(?:\[[a-z0-9]+\])?$|^claude-opus-(?:5(?:-5)?|4-8)(?:-\d{8})?(?:\[[a-z0-9]+\])?$/.test(
            model ?? '',
          )
        : true;
  if (!capabilities?.fastMode?.supported || !modelSupported)
    throw unprocessable(
      'Fast mode is unavailable for this installed CLI or selected model. Select a supported model and check account access.',
      'fast_mode_unavailable',
    );
}
