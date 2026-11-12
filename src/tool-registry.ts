import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import type { BuildSession } from './build-session.js';
import type { EngineManager } from './engine-manager.js';
import { UserError } from './validation.js';

type TextContent = { type: 'text'; text: string };
export type ToolResponse = { content: TextContent[]; isError?: true };

export interface ToolSchema {
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export function textResponse(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function errorResponse(error: unknown): ToolResponse & { isError: true } {
  if (error instanceof UserError) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: 'text',
        text:
          `Internal error: ${message}. ` +
          `If this persists the build state may be corrupted — try \`reset_build\` or reload the build.`,
      },
    ],
    isError: true,
  };
}

/**
 * If the handler returns a content-array response (e.g. multi-part text from
 * diagnose_build), pass it through unchanged. Check for an array `content`
 * rather than key presence so a domain object with a string `content` field
 * isn't misrouted as a multi-part response.
 */
function toResponse(result: unknown): ToolResponse {
  if (result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).content)) {
    return result as ToolResponse;
  }
  return textResponse(result);
}

export interface ToolRegistrar {
  /** Engine-backed tool: runs inside the engine gate (engine swaps wait for it) with the live session. */
  engine<TArgs>(name: string, schema: ToolSchema, handler: (args: TArgs, session: BuildSession) => Promise<unknown>): void;
  /** Tool that must work without a running engine (configuration, info, static data). */
  plain<TArgs>(name: string, schema: ToolSchema, handler: (args: TArgs) => Promise<unknown>): void;
}

/**
 * Consistent try/catch → errorResponse wrapping. Handlers throw UserError
 * (surfaced verbatim, includes EngineNotReadyError) or any other Error
 * (wrapped as Internal error).
 */
export function createToolRegistrar(server: McpServer, engine: EngineManager): ToolRegistrar {
  const register = (name: string, schema: ToolSchema, run: (args: unknown) => Promise<unknown>) => {
    server.registerTool(name, schema, async (args: unknown) => {
      try {
        return toResponse(await run(args));
      } catch (error) {
        return errorResponse(error);
      }
    });
  };
  return {
    engine: (name, schema, handler) =>
      register(name, schema, (args) => engine.run((session) => handler(args as never, session))),
    plain: (name, schema, handler) => register(name, schema, (args) => handler(args as never)),
  };
}
