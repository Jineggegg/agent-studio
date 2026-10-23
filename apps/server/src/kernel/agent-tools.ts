import { z, type ZodType } from 'zod';

/** Who is calling a tool: always one specific agent run, never "the server". */
export interface AgentToolContext {
  readonly runId: string;
  readonly sessionId: string;
  /** The project the run belongs to, or null for a conversation outside any project. */
  readonly projectId: string | null;
  readonly userId: string;
  /** The adapter the run uses, e.g. "claude-code". */
  readonly agentId: string;
  /** Stops pending remote work when the originating run is cancelled. */
  readonly signal?: AbortSignal;
}

export interface AgentToolResult {
  readonly text: string;
  readonly isError?: boolean;
  /**
   * The call was not carried out because the Studio refused it — a person said no, or the permission mode or a
   * rule did. Set together with `isError`; `text` says why. Callers show such a call as denied, not as failed.
   */
  readonly denied?: boolean;
}

export interface AgentToolDefinition<Input = unknown> {
  /** snake_case and globally unique, e.g. "memory_search". */
  readonly name: string;
  /** Shown to the model. Say what the tool does and when to use it. */
  readonly description: string;
  readonly input: ZodType<Input>;
  /**
   * `read` tools only return information the run is already entitled to.
   * `write` tools change something and are subject to the run's permission mode.
   */
  readonly effect: 'read' | 'write';
  handler(context: AgentToolContext, input: Input): Promise<AgentToolResult> | AgentToolResult;
}

/**
 * Tools the Studio itself offers to agents (shared memory, plugin tools, …).
 * Every agent reaches the same tools: CLI agents through the Studio's MCP
 * bridge, API models through function calling. A tool always runs with the
 * identity and scope of the run that called it.
 */
export class AgentToolRegistry {
  readonly #tools = new Map<string, AgentToolDefinition>();

  register<Input>(tool: AgentToolDefinition<Input>): void {
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(tool.name))
      throw new Error(`"${tool.name}" is not a valid tool name.`);
    if (this.#tools.has(tool.name))
      throw new Error(`Agent tool "${tool.name}" is already registered.`);
    this.#tools.set(tool.name, tool as AgentToolDefinition);
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  get(name: string): AgentToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): AgentToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** JSON Schema of a tool's input, for MCP tool listings and function-calling declarations. */
  inputJsonSchema(tool: AgentToolDefinition): Record<string, unknown> {
    const schema = z.toJSONSchema(tool.input, { target: 'draft-7' }) as Record<string, unknown>;
    // MCP requires an explicit object root even when every branch of a union is an object.
    const branches = schema.anyOf ?? schema.oneOf;
    if (
      schema.type === undefined &&
      Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every(
        (branch: unknown) =>
          typeof branch === 'object' &&
          branch !== null &&
          'type' in branch &&
          branch.type === 'object',
      )
    )
      return { ...schema, type: 'object' };
    return schema;
  }

  /** Validates input and runs the tool. Failures come back as error results, never as exceptions. */
  async call(name: string, context: AgentToolContext, rawInput: unknown): Promise<AgentToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) return { text: `There is no tool named "${name}".`, isError: true };
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ');
      return { text: `Invalid input for ${name}: ${problems}`, isError: true };
    }
    try {
      context.signal?.throwIfAborted();
      return await tool.handler(context, parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return { text: `${name} failed: ${message}`, isError: true };
    }
  }
}
