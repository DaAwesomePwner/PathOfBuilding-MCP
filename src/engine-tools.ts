import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EngineManager, PathPrompt } from './engine-manager.js';
import type { ToolRegistrar } from './tool-registry.js';

/**
 * Engine lifecycle tools — usable while the engine is unconfigured, stale, or
 * stopped: configure_pob_path, get_engine_info, reload_engine.
 */
export function registerEngineTools(tools: ToolRegistrar, engine: EngineManager): void {
  tools.plain<{ pobPath: string; luajitPath?: string }>(
    'configure_pob_path',
    {
      description:
        'Point the server at the user\'s Path of Building Community (Path of Exile 1) install and (re)start the engine. ' +
        'Validates the folder (must contain Launch.lua + Modules/Build.lua, or src/ for a source clone; the PoE2 edition is rejected), ' +
        'saves it to the server\'s config file so it is remembered across restarts, and returns the detected PoB version. ' +
        'Use when another tool reports that Path of Building is not configured — ask the user for the folder first. ' +
        'A loaded build is carried over to the new engine; undo history is cleared.',
      inputSchema: {
        pobPath: z
          .string()
          .min(1)
          .describe('PoB install folder, e.g. C:\\Users\\me\\AppData\\Roaming\\Path of Building Community. Pass the literal path: ~ is expanded, environment variables (%VAR%, $VAR) are not.'),
        luajitPath: z
          .string()
          .optional()
          .describe(
            'Optional full path to the luajit binary itself: an existing file whose name starts with "luajit" (e.g. luajit.exe). ' +
              'THE SERVER EXECUTES THIS FILE — only pass a path the user gave you. Needed on Windows when LuaJIT is not on PATH ' +
              '(the PoB installer does not ship luajit.exe). Environment variables are not expanded.',
          ),
      },
    },
    async ({ pobPath, luajitPath }) => engine.configure(pobPath, luajitPath),
  );

  tools.plain<Record<string, never>>(
    'get_engine_info',
    {
      description:
        'Report the engine state: status (unconfigured/starting/ready/failed/stale/updating), Path of Building version, ' +
        'PoB and LuaJIT paths and where they came from, install layout, whether PoB was updated on disk since the engine ' +
        'started, the config file location, and basic info (incl. tree version fields when available) about the loaded build. ' +
        'Never starts the engine.',
      inputSchema: {},
    },
    async () => engine.info(),
  );

  tools.plain<Record<string, never>>(
    'reload_engine',
    {
      description:
        'Restart the LuaJIT engine against the Path of Building install currently on disk — use after PoB updates itself ' +
        '(e.g. a new league patch) or when a tool reports the install changed. The current build is exported and reloaded ' +
        'into the new engine; undo history and stat snapshots are cleared, and reset_build will return to the reloaded state.',
      inputSchema: {},
    },
    async () => {
      const r = await engine.reload();
      return {
        status: 'reloaded',
        ...r,
        versionChange: `${r.oldVersion ?? 'unknown'} → ${r.newVersion ?? 'unknown'}`,
        undoHistoryCleared: true,
      };
    },
  );
}

/**
 * Elicitation-based prompt for the PoB folder, used the first time an
 * engine-backed tool runs while unconfigured. Only used when the client
 * advertises form elicitation; otherwise (or if the user declines) the tool
 * returns the "ask the user, then call configure_pob_path" error instead.
 */
export function createPathPrompt(server: McpServer, engine: EngineManager): PathPrompt {
  return async () => {
    if (!server.server.getClientCapabilities()?.elicitation?.form) return { configured: false };
    const result = await server.server.elicitInput(
      {
        mode: 'form',
        message:
          'The Path of Building MCP server could not find your Path of Building Community (Path of Exile 1) install. ' +
          'Enter the full folder path that contains Launch.lua, for example ' +
          'C:\\Users\\<your name>\\AppData\\Roaming\\Path of Building Community (type the real path: environment ' +
          'variables like %APPDATA% are not expanded, and network paths are not accepted).',
        requestedSchema: {
          type: 'object',
          properties: {
            pobPath: { type: 'string', title: 'Path of Building folder', minLength: 1 },
            luajitPath: {
              type: 'string',
              title: 'LuaJIT binary (optional)',
              description: 'Full path to luajit.exe / luajit — only needed if it is not on PATH. This program will be run.',
            },
          },
          required: ['pobPath'],
        },
      },
      { timeout: 10 * 60_000 },
    );
    if (result.action !== 'accept' || !result.content) {
      return { configured: false, message: `The user ${result.action === 'decline' ? 'declined' : 'cancelled'} the path prompt.` };
    }
    const pobPath = String(result.content.pobPath ?? '');
    const lj = result.content.luajitPath;
    try {
      await engine.configure(pobPath, typeof lj === 'string' && lj.trim() ? lj : undefined);
      return { configured: true };
    } catch (e) {
      return { configured: false, message: `The path the user entered was rejected: ${(e as Error).message}` };
    }
  };
}
