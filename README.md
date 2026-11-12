# pob-mcp-server

An MCP server that exposes [Path of Building Community](https://pathofbuilding.community/)'s build-planning and calculation engine to LLM clients (Claude Desktop, Claude Code, and other [MCP](https://modelcontextprotocol.io/) hosts).

The server runs PoB's real Lua calculation engine in headless mode and surfaces 36 tools for inspecting builds, swapping items and gems, manipulating the passive tree, simulating "what-ifs," and comparing alternatives.

## Prerequisites

1. **Path of Building Community (Path of Exile 1)** installed locally — download from <https://pathofbuilding.community/>. The Windows installer places it at `%APPDATA%\Path of Building Community\`. A git clone of the PoB repo also works. The **Path of Exile 2** edition ("Path of Building Community (PoE2)") is **not supported** and is rejected with a specific message.
2. **Node.js >= 20**.
3. **LuaJIT (5.1 ABI)**, installed separately. PoB's GUI embeds `lua51.dll`; the Windows PoB installer does **not** ship a standalone `luajit.exe`, so install one:
   - Windows (scoop): `scoop install luajit`
   - Windows (winget): `winget install DEVCOM.LuaJIT`
   - macOS (Homebrew): `brew install luajit`
   - Linux (apt): `sudo apt-get install luajit`

## Quick start

Run via npx (no install):

```bash
npx -y pob-mcp-server
```

Then wire it into your MCP client. **Claude Desktop** — edit `claude_desktop_config.json` (the `env` block is optional, see below):

```json
{
  "mcpServers": {
    "pob": {
      "command": "npx",
      "args": ["-y", "pob-mcp-server"],
      "env": {
        "POB_PATH": "C:\\Users\\you\\AppData\\Roaming\\Path of Building Community",
        "LUAJIT_PATH": "C:\\Users\\you\\scoop\\shims\\luajit.exe"
      }
    }
  }
}
```

**Claude Code**:

```bash
# auto-detect PoB + LuaJIT (or configure later from the chat, see below)
claude mcp add pob -- npx -y pob-mcp-server

# or pin the paths; --env options go before the server name, the command after --
claude mcp add --env POB_PATH="C:\Users\you\AppData\Roaming\Path of Building Community" --env LUAJIT_PATH="C:\Users\you\scoop\shims\luajit.exe" pob -- npx -y pob-mcp-server
```

`POB_PATH` and `LUAJIT_PATH` are optional. If the server cannot find PoB or LuaJIT it **still starts**: every engine tool returns an error telling the assistant to ask you for your PoB folder and call `configure_pob_path`. Clients that support MCP elicitation show you a prompt for the folder directly. The chosen path is saved and reused on the next start.

## Configuration

Paths are resolved in this order: **environment variable → saved config → auto-detect**.

| Env var              | Purpose | Default |
|----------------------|---------|---------|
| `POB_PATH`           | Your PoB install folder. Must contain `Launch.lua` + `Modules/Build.lua` (installed layout) or `src/Launch.lua` + `src/Modules/Build.lua` (source clone). Surrounding quotes, `~`, `%VAR%` and trailing slashes are handled. When set but invalid, auto-detect is skipped and the error says why. | Saved config, then auto-detect. |
| `LUAJIT_PATH`        | A `luajit` binary, or a folder containing `luajit[.exe]` or `bin/luajit[.exe]`. | Saved config, then auto-detect. |
| `POB_MCP_CONFIG_DIR` | Overrides the config directory (used by the tests). | See below. |
| `POB_TIMING`         | When set to `1`, prints per-command timing to stderr. | unset |

**Saved config.** `configure_pob_path` writes `config.json` to:

- Windows: `%APPDATA%\pob-mcp-server\config.json`
- macOS: `~/Library/Application Support/pob-mcp-server/config.json`
- Linux: `$XDG_CONFIG_HOME/pob-mcp-server/config.json` (default `~/.config/pob-mcp-server/`)

**Auto-detect** probes, in order:

- PoB on Windows: `%APPDATA%\Path of Building Community`; the installer's uninstall registry key `HKCU` / `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Path of Building Community` → `InstallLocation`; `%ProgramData%\Path of Building`; `%LOCALAPPDATA%\Programs\Path of Building Community`.
- PoB on macOS: `~/Library/Application Support/Path of Building Community`.
- PoB on Linux: `~/.local/share/Path of Building Community` (honours `XDG_DATA_HOME`), Flatpak data under `~/.var/app/community.pathofbuilding.PathOfBuilding/data`, `/opt/path-of-building`.
- LuaJIT: `<PoB>/runtime/luajit[.exe]`, `%LOCALAPPDATA%\Programs\LuaJIT\bin\luajit.exe`, scoop (`~/scoop/shims`, `~/scoop/apps/luajit/current`, global scoop), Homebrew / `/usr/local/bin` / `/usr/bin`, then `PATH`.

Errors list every location that was probed.

### PoB updates (new leagues)

PoB updates itself in place. The server reads the PoB version from `manifest.xml` when the engine starts (logged to stderr, reported by `get_engine_info`). If PoB is updated on disk while the server is running, engine tools return an error saying *"Path of Building was updated on disk from X to Y"* rather than quietly keep using the old engine. Call `reload_engine` to restart against the new version: the loaded build is carried over, and undo history is cleared. While PoB is applying an update, engine tools report "not ready" until it finishes.

## Tools

The server exposes 36 MCP tools. See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for a narrative tour with examples.

- **Engine setup:** `configure_pob_path`, `get_engine_info`, `reload_engine` (these work even when PoB is not configured).
- **Build I/O:** `load_build`, `export_build` (summary, XML or PoB build code — round-trip lossless), `reset_build`.
- **Inspection:** `get_stats`, `get_skill_breakdown`, `list_equipped_items`, `list_valid_slots`, `get_item_in_slot`.
- **Items:** `swap_item`, `unequip_item`, `compare_items`, `suggest_upgrades`.
- **Passive tree:** `get_passive_tree`, `simulate_passive_change`, `find_best_next_nodes`, `find_worst_allocated_nodes`, `evaluate_keystone`.
- **Gems:** `list_skill_groups`, `lookup_gem`, `list_available_supports`, `swap_gem`, `compare_supports`, `evaluate_gem_levels`, `find_optimal_links`.
- **Config / scenarios:** `get_config`, `set_config`, `list_scenarios`, `simulate_scenario`, `compare_scenarios`, `toggle_buffs`.
- **State / analysis:** `undo_last_change`, `snapshot_and_compare`, `diagnose_build`.

## Troubleshooting

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Common issues:

- **"Path of Building is not configured"**: give the assistant your PoB folder (it calls `configure_pob_path`), or set `POB_PATH`.
- **LuaJIT not found**: install LuaJIT separately (the Windows PoB installer has no `luajit.exe`), then pass `luajitPath` to `configure_pob_path` or set `LUAJIT_PATH`.
- **"Path of Building was updated on disk"**: call `reload_engine`.
- **Bridge timeout / crash**: see the troubleshooting doc. The server includes a three-strike circuit breaker that requires a process restart (or a different path via `configure_pob_path`) on repeated crashes.

## Development

```bash
git clone https://github.com/DaAwesomePwner/PathOfBuilding-MCP.git
cd PathOfBuilding-MCP
npm install
npm run build        # tsc → dist/ (fails if tsc fails)
npm run typecheck    # tsc --noEmit
```

Run tests against your local PoB install:

```bash
# Windows PowerShell
$env:POB_PATH = "$env:APPDATA\Path of Building Community"
npm run test:all
```

If `POB_PATH` is unset and auto-detect fails, the integration tests print `SKIPPED:` and exit 0. `npm run test:paths` and the first two parts of `npm run test:startup` need no PoB install. The tests never read or write your real saved config (`test:startup` uses a temp `POB_MCP_CONFIG_DIR`).

Single test file:

```bash
tsx test/bridge-test.ts
```

CI: a GitHub Actions workflow is not yet wired up — contributions welcome.

## License

MIT — see [`LICENSE`](./LICENSE). Path of Building Community remains under its own license at your install.
