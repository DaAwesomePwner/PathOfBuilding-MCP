# pob-mcp-server

An MCP server that exposes [Path of Building Community](https://pathofbuilding.community/)'s build-planning and calculation engine to LLM clients (Claude Desktop, Claude Code, and other [MCP](https://modelcontextprotocol.io/) hosts).

The server runs PoB's real Lua calculation engine in headless mode and surfaces 33 tools for inspecting builds, swapping items and gems, manipulating the passive tree, simulating "what-ifs," and comparing alternatives.

## Prerequisites

1. **Path of Building Community** installed locally. On Windows the installer places it at `%APPDATA%\Path of Building Community\`. Download from <https://pathofbuilding.community/>.
2. **Node.js >= 20**.
3. **LuaJIT 5.1** — either bundled in your PoB install at `<POB_PATH>/runtime/luajit{,.exe}`, or on `PATH`, or pointed to by `LUAJIT_PATH`. PoB's own GUI uses an embedded `lua51.dll` and does **not** ship a standalone `luajit` executable on most platforms; you may need to install one:
   - Windows (scoop): `scoop install luajit`
   - Windows (winget): `winget install DEVCOM.LuaJIT`
   - macOS (Homebrew): `brew install luajit`
   - Linux (apt): `sudo apt-get install luajit`

## Quick start

Run via npx (no install):

```bash
npx -y pob-mcp-server
```

Then wire it into your MCP client. **Claude Desktop** — edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pob": {
      "command": "npx",
      "args": ["-y", "pob-mcp-server"],
      "env": {
        "POB_PATH": "C:\\Users\\you\\AppData\\Roaming\\Path of Building Community"
      }
    }
  }
}
```

**Claude Code** — `claude mcp add pob -- npx -y pob-mcp-server` and set `POB_PATH` in your environment.

If your PoB install is at the default `%APPDATA%\Path of Building Community\` location on Windows, the server auto-detects it and `POB_PATH` is optional.

## Configuration

| Env var       | Purpose                                                                                     | Default |
|---------------|---------------------------------------------------------------------------------------------|---------|
| `POB_PATH`    | Path to your PoB install. Validated by checking for `Launch.lua` (compiled install) or `src/Launch.lua` (source clone). | Auto-detected on Windows (`%APPDATA%\Path of Building Community`), macOS, and Linux. |
| `LUAJIT_PATH` | Absolute path to a `luajit` binary. Overrides install/PATH detection.                       | Auto-detected. |
| `POB_TIMING`  | When set to `1`, prints per-command timing to stderr (useful for debugging).                | unset |

## Tools

The server exposes 33 MCP tools across seven categories. See [`GETTING_STARTED.md`](./GETTING_STARTED.md) for a narrative tour with examples. Highlights:

- **Build I/O:** `load_build`, `export_build` (XML or PoB build code, round-trip lossless).
- **Inspection:** `get_stats`, `get_items`, `get_skills`, `get_passive_summary`, `describe_build`.
- **Item ops:** `swap_item`, `unequip_item`, `compare_items`, `find_optimal_links`.
- **Gem ops:** `swap_gem`, `add_support_gem`, `find_optimal_support_links`.
- **Tree ops:** `simulate_passive_change`, `find_path_to_node`.
- **Config:** `get_config`, `set_config`, `evaluate_scenario`.
- **State:** `snapshot_build`, `restore_build`, `undo_last_change`, `reset_build`.
- **Analysis:** `diagnose_build`, `suggest_upgrades`.

## Troubleshooting

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Common issues:

- **PoBInstallNotFoundError** — set `POB_PATH`.
- **LuaJITNotFoundError** — install LuaJIT 5.1 or set `LUAJIT_PATH`.
- **Bridge timeout / crash** — see the troubleshooting doc; the server includes a three-strike circuit breaker that requires a process restart on repeated crashes.

## Development

```bash
git clone https://github.com/DaAwesomePwner/PathOfBuilding-MCP.git
cd PathOfBuilding-MCP
npm install
npm run build
```

Run tests against your local PoB install:

```bash
# Windows PowerShell
$env:POB_PATH = "$env:APPDATA\Path of Building Community"
npm run test:all
```

If `POB_PATH` is unset and auto-detect fails, the integration tests print `SKIPPED:` and exit 0.

Single test file:

```bash
tsx test/bridge-test.ts
```

CI: a GitHub Actions workflow is not yet wired up — contributions welcome.

## License

MIT — see [`LICENSE`](./LICENSE). Path of Building Community remains under its own license at your install.
