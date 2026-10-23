import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentToolRegistry, type AgentToolContext } from './agent-tools.js';

const context: AgentToolContext = {
  runId: 'r',
  sessionId: 's',
  projectId: 'p',
  userId: 'u',
  agentId: 'test',
};

describe('AgentToolRegistry', () => {
  it('advertises object unions to MCP clients without weakening input validation', async () => {
    const registry = new AgentToolRegistry();
    const tool = {
      name: 'union_probe',
      description: 'Synthetic union tool',
      effect: 'read' as const,
      input: z.discriminatedUnion('operation', [
        z.strictObject({ operation: z.literal('read'), path: z.string() }),
        z.strictObject({ operation: z.literal('list'), count: z.number().int() }),
      ]),
      handler: () => ({ text: 'ok' }),
    };
    registry.register(tool);
    const inputSchema = registry.inputJsonSchema(registry.get(tool.name)!);
    expect(() =>
      ListToolsResultSchema.parse({ tools: [{ name: tool.name, inputSchema }] }),
    ).not.toThrow();
    expect(await registry.call(tool.name, context, { operation: 'read', count: 2 })).toMatchObject({
      isError: true,
    });
    expect(
      await registry.call(tool.name, context, { operation: 'read', path: 'example.txt' }),
    ).toEqual({ text: 'ok' });
  });
  it('validates input before the handler runs and reports failures as results', async () => {
    const registry = new AgentToolRegistry();
    let calls = 0;
    registry.register({
      name: 'echo_upper',
      description: 'Upper-cases text.',
      input: z.object({ text: z.string().max(10) }),
      effect: 'read',
      handler: (_context, input) => {
        calls += 1;
        if (input.text === 'boom') throw new Error('exploded');
        return { text: input.text.toUpperCase() };
      },
    });
    expect(await registry.call('echo_upper', context, { text: 'hi' })).toEqual({ text: 'HI' });
    expect(await registry.call('echo_upper', context, { text: 42 })).toMatchObject({
      isError: true,
    });
    expect(await registry.call('echo_upper', context, { text: 'boom' })).toEqual({
      text: 'echo_upper failed: exploded',
      isError: true,
    });
    expect(await registry.call('missing', context, {})).toMatchObject({ isError: true });
    expect(calls).toBe(2);
  });

  it('describes inputs as JSON Schema and refuses duplicate or malformed names', () => {
    const registry = new AgentToolRegistry();
    const tool = {
      name: 'note_read',
      description: 'd',
      input: z.object({ id: z.string() }),
      effect: 'read' as const,
      handler: () => ({ text: '' }),
    };
    registry.register(tool);
    expect(registry.inputJsonSchema(registry.get('note_read')!)).toMatchObject({
      type: 'object',
      required: ['id'],
    });
    expect(() => registry.register(tool)).toThrow(/already registered/);
    expect(() => registry.register({ ...tool, name: 'Bad-Name' })).toThrow(/not a valid tool name/);
  });
});
