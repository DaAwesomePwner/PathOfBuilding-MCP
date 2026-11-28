import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
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

/** Compact (not pretty-printed) JSON: every byte is a token for the client's model. */
export function textResponse(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Never changes the build, the engine or the session: what-if, read and lookup tools. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Changes the build in a way undo_last_change reverts. */
const UNDOABLE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Replaces the build or the engine and clears undo history. */
const REPLACES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/**
 * MCP tool annotations for every tool, by name. A tool registered without an
 * entry gets none (server-test checks that every tool has one).
 */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Engine lifecycle
  configure_pob_path: REPLACES,
  reload_engine: REPLACES,
  get_engine_info: READ_ONLY,
  // Build lifecycle: load_build may fetch a pastebin / pobb.in link.
  load_build: { ...REPLACES, idempotentHint: true, openWorldHint: true },
  reset_build: { ...REPLACES, idempotentHint: true },
  // Replaces the build with a blank one (same arguments, same build).
  new_build: { ...REPLACES, idempotentHint: true },
  // Discards the last change; it cannot be redone.
  undo_last_change: { ...UNDOABLE, destructiveHint: true },
  // Committed changes (undo_last_change reverts them)
  swap_item: UNDOABLE,
  unequip_item: UNDOABLE,
  set_config: UNDOABLE,
  convert_tree_to_latest: UNDOABLE,
  allocate_nodes: UNDOABLE,
  deallocate_nodes: UNDOABLE,
  apply_changes: UNDOABLE,
  create_socket_group: UNDOABLE,
  delete_socket_group: UNDOABLE,
  set_main_skill: UNDOABLE,
  set_character_level: { ...UNDOABLE, idempotentHint: true },
  set_ascendancy: { ...UNDOABLE, idempotentHint: true },
  set_flask_active: { ...UNDOABLE, idempotentHint: true },
  // Session-scoped stat snapshots only; the build is untouched.
  snapshot_and_compare: { ...UNDOABLE, idempotentHint: true },
  // Reads
  get_stats: READ_ONLY,
  get_skill_breakdown: READ_ONLY,
  list_equipped_items: READ_ONLY,
  list_valid_slots: READ_ONLY,
  get_item_in_slot: READ_ONLY,
  get_passive_tree: READ_ONLY,
  list_skill_groups: READ_ONLY,
  lookup_gem: READ_ONLY,
  list_available_supports: READ_ONLY,
  get_config: READ_ONLY,
  list_scenarios: READ_ONLY,
  export_build: READ_ONLY,
  diagnose_build: READ_ONLY,
  // What-if probes (the build never changes)
  evaluate_changes: READ_ONLY,
  compare_items: READ_ONLY,
  simulate_passive_change: READ_ONLY,
  find_best_next_nodes: READ_ONLY,
  find_worst_allocated_nodes: READ_ONLY,
  // Steps / respec applied to a temporary tree and restored exactly.
  plan_passive_points: READ_ONLY,
  plan_respec: READ_ONLY,
  evaluate_keystone: READ_ONLY,
  swap_gem: READ_ONLY,
  compare_supports: READ_ONLY,
  evaluate_gem_levels: READ_ONLY,
  find_optimal_links: READ_ONLY,
  simulate_scenario: READ_ONLY,
  compare_scenarios: READ_ONLY,
  toggle_buffs: READ_ONLY,
  suggest_upgrades: READ_ONLY,
  stat_weights: READ_ONLY,
  // Reads another build (may fetch a pastebin / pobb.in link) in a short-lived second engine.
  compare_builds: { ...READ_ONLY, openWorldHint: true },
  // Community samples (saved in the config dir; read in a short-lived second engine, never the loaded build).
  add_sample_builds: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  list_samples: READ_ONLY,
  remove_sample_builds: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // PoB's item data: items are built in the engine, never added to the build.
  search_items: READ_ONLY,
  get_item_text: READ_ONLY,
  list_item_mods: READ_ONLY,
  build_item: READ_ONLY,
  // Trade (offline: builds a search link, never contacts the trade site)
  generate_trade_search: READ_ONLY,
  search_trade_mods: READ_ONLY,
};

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
    const annotations = TOOL_ANNOTATIONS[name];
    server.registerTool(name, annotations ? { ...schema, annotations } : schema, async (args: unknown) => {
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
