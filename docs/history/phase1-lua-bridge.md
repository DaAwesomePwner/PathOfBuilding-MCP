# Phase 1: Lua Bridge — Implementation Plan

## Goal
Build a Node.js (TypeScript) bridge that spawns PoB's LuaJIT engine as a child process, communicates via JSON-lines over stdin/stdout, and handles build code decoding and URL fetching entirely in TypeScript.

---

## Step 1: Project Scaffolding

### 1.1 Initialize the Node.js project
- Create `mcp-server/` directory at repo root (keep MCP code separate from PoB Lua source)
- `npm init` with name `pob-mcp-server`
- Install dependencies:
  - `typescript`, `@types/node` (dev)
  - `tsx` (for running TS directly during dev)
- Create `tsconfig.json` targeting ES2022, Node16 module resolution, strict mode, outDir `dist/`

### 1.2 Directory structure
```
mcp-server/
  package.json
  tsconfig.json
  src/
    lua-bridge.ts       — TypeScript bridge module
  lua/
    bridge.lua          — Lua-side stdin/stdout wrapper
  test/
    bridge-test.ts      — End-to-end test
```

---

## Step 2: Create `lua/bridge.lua`

This Lua script replaces HeadlessWrapper.lua as the entry point. It reuses HeadlessWrapper's stubs but adds JSON-lines communication.

### 2.1 Bootstrap from HeadlessWrapper
- Copy the stub definitions from `src/HeadlessWrapper.lua` (lines 1-183) — callbacks, image handles, rendering stubs, file search, window/input stubs, compression stubs, module loading, lcurl override.
- **Critical override**: Replace the path function stubs (HeadlessWrapper lines 105-112) with functions that return the actual repo path:
  ```lua
  local REPO_ROOT = arg[1] or "."  -- Accept repo root as command-line arg
  local SCRIPT_PATH = REPO_ROOT .. "/src"
  function GetScriptPath() return SCRIPT_PATH end
  function GetRuntimePath() return REPO_ROOT .. "/runtime" end
  function GetUserPath() return REPO_ROOT end
  function GetWorkDir() return REPO_ROOT end
  ```
- Keep Inflate/Deflate as stubs (build code decoding happens in TypeScript).
- Keep lcurl override (URL fetching happens in TypeScript).

### 2.2 Load the PoB engine
- Set working directory context: the Lua process must be spawned with `cwd` set to `src/` (because `dofile("Launch.lua")` at HeadlessWrapper line 186 uses a relative path, and Launch.lua line 71 loads `Modules/Main` relative to cwd).
- Execute the launch sequence (mirroring HeadlessWrapper lines 186-204):
  ```lua
  dofile("Launch.lua")
  runCallback("OnInit")
  runCallback("OnFrame")
  build = mainObject.main.modes["BUILD"]
  ```
- After init, verify no error: check `mainObject.promptMsg` (HeadlessWrapper lines 196-201).

### 2.3 JSON communication layer
- Use `dkjson` (already in `runtime/lua/dkjson.lua`) for JSON encoding/decoding.
- Main loop reads lines from stdin, parses as JSON, dispatches commands, writes JSON response to stdout:
  ```lua
  local dkjson = require("dkjson")
  
  local function respond(obj)
    io.stdout:write(dkjson.encode(obj) .. "\n")
    io.stdout:flush()
  end
  
  while true do
    local line = io.stdin:read("*l")
    if not line then break end
    local ok, cmd = pcall(dkjson.decode, line)
    if not ok then
      respond({error = "Invalid JSON: " .. tostring(cmd)})
    else
      local ok2, result = pcall(dispatch, cmd)
      if not ok2 then
        respond({error = "Command failed: " .. tostring(result)})
      else
        respond(result)
      end
    end
  end
  ```

### 2.4 Command handlers

**`loadXML`** — `{"cmd": "loadXML", "xml": "...", "name": "build name"}`
- Call `loadBuildFromXML(cmd.xml, cmd.name or "MCP Build")` (HeadlessWrapper line 208-210)
- Pump a frame: `runCallback("OnFrame")`
- Read basic build info from the build object:
  - `build.characterLevel`, `build.className`, `build.ascendClassName`
  - Main skill name from `build.skillsTab.socketGroupList`
- Return: `{ok = true, info = {class, ascendancy, level, mainSkill}}`

**`getStats`** — `{"cmd": "getStats"}`
- Pump a frame: `runCallback("OnFrame")`
- Read `build.calcsTab.mainOutput` immediately after pump (output tables are replaced on recalc — CalcsTab.lua lines 420-451)
- Serialize relevant fields to a flat table (CombinedDPS, TotalEHP, Life, EnergyShield, Mana, resistances, etc.)
- Also read `build.calcsTab.mainEnv.player.output` for supplementary data
- Return: `{ok = true, stats = {...}}`

**`getConfig`** — `{"cmd": "getConfig"}`
- Read `build.configTab.input` table
- Return as JSON object

**`setConfig`** — `{"cmd": "setConfig", "options": {...}}`
- For each key-value pair, set `build.configTab.input[key] = value`
- Call `build.configTab:BuildModList()` (ConfigTab.lua line 154)
- Pump frame: `runCallback("OnFrame")`
- Return new stats

**`shutdown`** — `{"cmd": "shutdown"}`
- Respond with `{ok = true}`, then `os.exit(0)`

### 2.5 Frame pump rule enforcement
- Create a helper function `pumpAndRead()` that always:
  1. Calls `runCallback("OnFrame")`
  2. Re-reads `build.calcsTab.mainOutput` (never caches the reference)
  3. Returns the fresh output table
- Every command that reads stats must use this helper.

---

## Step 3: Create `src/lua-bridge.ts`

### 3.1 Process management
- Spawn LuaJIT as a child process:
  ```typescript
  import { spawn, ChildProcess } from 'child_process';
  
  class LuaBridge {
    private process: ChildProcess | null = null;
    private repoRoot: string;
    private luajitPath: string; // Path to luajit binary
    
    constructor(repoRoot: string, luajitPath?: string) {
      this.repoRoot = repoRoot;
      this.luajitPath = luajitPath ?? 'luajit'; // Assume on PATH
    }
  }
  ```
- Spawn with:
  - Command: `luajit`
  - Args: `[path/to/bridge.lua, repoRoot]`
  - Options: `{ cwd: path.join(repoRoot, 'src'), stdio: ['pipe', 'pipe', 'pipe'] }`
  - The `cwd` must be `src/` because Launch.lua uses relative `dofile` and `LoadModule` paths.
- **LuaJIT binary location**: Check `runtime/` directory for a bundled luajit. If not present, require it on PATH. The CI uses a Docker image with luajit preinstalled (`ghcr.io/pathofbuildingcommunity/pathofbuilding-tests:latest`).

### 3.2 JSON-lines protocol
- Write commands as JSON + newline to stdin
- Read responses as JSON + newline from stdout
- Use a line-buffered reader on stdout:
  ```typescript
  import { createInterface } from 'readline';
  
  private readline = createInterface({ input: this.process.stdout });
  ```
- Each `send()` call returns a Promise that resolves when the next stdout line arrives:
  ```typescript
  async send(command: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Lua bridge timeout')), 30000);
      this.readline.once('line', (line) => {
        clearTimeout(timeout);
        try {
          const result = JSON.parse(line);
          if (result.error) reject(new Error(result.error));
          else resolve(result);
        } catch (e) {
          reject(new Error(`Invalid JSON from Lua: ${line}`));
        }
      });
      this.process.stdin.write(JSON.stringify(command) + '\n');
    });
  }
  ```

### 3.3 Error handling and auto-restart
- Listen for process `exit` and `error` events
- Set `this.process = null` on exit
- On next `send()`, if process is null, spawn a new one
- If a build was loaded before crash, store the XML so it can be reloaded after restart
- Stderr should be captured and logged (Lua print() and error messages go to stderr via ConPrintf)

### 3.4 Build code decoding (TypeScript-side)
```typescript
import { inflateRawSync, inflateSync } from 'zlib';
import { Buffer } from 'buffer';

function decodeBuildCode(code: string): string {
  // PoB build codes use URL-safe base64 with - and _ instead of + and /
  const normalized = code.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(normalized, 'base64');
  
  try {
    // Try raw inflate first (PoB uses raw deflate)
    return inflateRawSync(buffer).toString('utf-8');
  } catch {
    // Fall back to standard inflate
    return inflateSync(buffer).toString('utf-8');
  }
}
```

### 3.5 URL fetching (TypeScript-side)
```typescript
async function fetchBuildFromURL(url: string): Promise<string> {
  // Handle pastebin.com URLs
  if (url.includes('pastebin.com')) {
    const id = url.split('/').pop();
    const rawUrl = `https://pastebin.com/raw/${id}`;
    const resp = await fetch(rawUrl);
    const code = await resp.text();
    return decodeBuildCode(code.trim());
  }
  // Handle pobb.in URLs
  if (url.includes('pobb.in')) {
    const resp = await fetch(url, { headers: { 'Accept': 'text/plain' } });
    const code = await resp.text();
    return decodeBuildCode(code.trim());
  }
  throw new Error(`Unsupported URL: ${url}`);
}
```

### 3.6 Public API
```typescript
class LuaBridge {
  async start(): Promise<void>           // Spawn process, wait for init
  async loadBuildXML(xml: string): Promise<BuildInfo>
  async loadBuildCode(code: string): Promise<BuildInfo>  // Decode in TS, then loadXML
  async loadBuildFromURL(url: string): Promise<BuildInfo> // Fetch in TS, decode, loadXML
  async getStats(): Promise<Stats>
  async shutdown(): Promise<void>
  isRunning(): boolean
}
```

---

## Step 4: Create `test/bridge-test.ts`

### 4.1 Test fixtures
- Create a minimal valid PoB XML build inline (or extract one from `spec/TestBuilds/`).
- Alternatively, read an existing test build XML from `spec/TestBuilds/3.13/` directory.

### 4.2 Test cases
1. **Spawn and init**: Verify bridge starts without error
2. **Load XML**: Load a known build, verify class/ascendancy/level returned
3. **Get stats**: After loading, verify stats object contains expected keys (CombinedDPS, Life, etc.) with non-zero values
4. **Build code round-trip**: Take known XML → deflate → base64 in TS → decode → verify matches original
5. **Error handling**: Send malformed XML, verify graceful error (not crash)
6. **Empty build code**: Send empty string, verify error
7. **Auto-restart**: Kill the Lua process, send another command, verify it restarts
8. **Shutdown**: Call shutdown, verify process exits cleanly

### 4.3 Running tests
- Use `tsx` for direct TypeScript execution: `npx tsx test/bridge-test.ts`
- Or set up a test runner (vitest/jest) if preferred

---

## Step 5: Verify Data File Loading

This is the highest-risk item. If path overrides don't work, nothing else works.

### 5.1 Verification steps
1. After bridge.lua loads the engine, add a verification command that checks:
   - `#build.treeTab.spec.nodes > 0` (tree data loaded)
   - `next(data.gems) ~= nil` (gem data loaded)  
   - `next(data.itemBases) ~= nil` (base item data loaded)
2. If any are empty, the path overrides need adjustment. Debug by:
   - Checking what `GetScriptPath()` returns inside the Lua process
   - Tracing which `LoadModule` calls fail
   - Looking at `src/Data/Data.lua` to see how it resolves file paths

### 5.2 Lua path setup
- The Lua `package.path` must include `runtime/lua/?.lua` (for dkjson, xml parser, etc.)
- Set this in bridge.lua before any requires:
  ```lua
  local REPO_ROOT = arg[1]
  package.path = REPO_ROOT .. "/runtime/lua/?.lua;" .. REPO_ROOT .. "/runtime/lua/?/init.lua;" .. package.path
  ```

---

## Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| LuaJIT not on PATH / wrong version | Document requirement, check version on start, provide download link |
| Path overrides insufficient (data files don't load) | Test immediately after init, add diagnostic command |
| dkjson can't serialize large output tables | Limit serialized fields to known stat keys, not full table dump |
| Lua process hangs (infinite loop in calcs) | 30s timeout on all commands, kill process on timeout |
| stdin/stdout buffering issues | Explicit `io.stdout:flush()` after every response, use line-buffered mode |
| ConPrintf output on stdout corrupts JSON protocol | Redirect ConPrintf to stderr: `function ConPrintf(fmt, ...) io.stderr:write(string.format(fmt, ...) .. "\n") end` |

---

## Definition of Done
- [ ] `lua/bridge.lua` loads the PoB engine with correct path overrides
- [ ] Data files (tree, gems, items) load successfully
- [ ] `src/lua-bridge.ts` can spawn the process, send commands, receive responses
- [ ] Build codes decode correctly in TypeScript (base64 + zlib)
- [ ] A known test build loads and returns non-zero stats
- [ ] Error handling works (bad XML, process crash recovery)
- [ ] All tests in `test/bridge-test.ts` pass
