# tsx Orphan Process Investigation — 2026-05-21

## Background

After commit `ea39f5a0` ("fix(server): clean shutdown on MCP disconnect + per-candidate errors")
the original ~120 LuaJIT / `node` orphan leak was fully resolved. The task was to
investigate a *separate* report of ~11 lingering `node` processes (tsx test-runner
orphans, not MCP servers) that were allegedly still visible after `npm run test:all`.

## Reproduction Attempt

### Method

```powershell
# Step 1 — baseline
$baseline = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
"Baseline: $baseline"   # → 6
```

```bash
# Step 2 — run the full suite in foreground (Bash tool, timeout 600 000 ms)
npm run test:all
```

All 11 test phases passed (identical output to what was seen during the original
`ea39f5a0` verification). Wall-clock time: ~4 min.

```powershell
# Step 3 — count immediately after
$after = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
"After: $after — orphans introduced: $($after - 6)"  # → 0
```

Repeated with a single-phase run (`npm run test:server`): same result — 0 orphans.

### Baseline process inventory

The 6 node processes that existed before the run (and were still there after) are all
unrelated to this repo:

| PID | Description |
|-----|-------------|
| 53848 | Elgato Stream Deck plugin (node 20, `plugin.js`) |
| 61524 | Claude Code Pro plugin (`mcp-server.cjs`) |
| 57384 | `npx @upstash/context7-mcp` launcher |
| 22976 | `npx @playwright/mcp@latest` launcher |
| 60768 | `@playwright/mcp` worker |
| 43616 | `@upstash/context7-mcp` worker |

None were spawned by this project and none accumulated during the test run.

## Spawn/Shutdown Chain Analysis

Each MCP integration test (server-test, phase3..phase7, state-integrity, error-handling)
does the following:

```
tsx test/phaseN-test.ts          ← the test-runner node process
  └─ StdioClientTransport spawns: npx tsx src/server.ts
       └─ tsx resolves to: node src/server.ts  ← MCP server
            └─ bridge.lua spawns: luajit        ← Lua engine
```

### Why it worked before ea39f5a0 was problematic

Before `ea39f5a0`, `src/server.ts` only listened for SIGINT/SIGTERM. On Windows,
closing the stdio pipe from the client side does **not** deliver SIGTERM to the child.
The server therefore kept running after the client called `client.close()`, and so did
the LuaJIT grandchild. Because LuaJIT held an open handle to the MCP server's stdout
pipe, the MCP SDK's 2 s / SIGTERM / 2 s / SIGKILL sequence in `StdioClientTransport.close()`
eventually delivered a SIGKILL, but the tsx runner process may have lingered briefly
waiting for the pipe to drain.

### Why it is clean now

`ea39f5a0` added:
```typescript
process.stdin.on('end',  () => void shutdown('stdin-eof'));
process.stdin.on('close', () => void shutdown('stdin-close'));
```

When `client.close()` calls `processToClose.stdin?.end()`, the MCP server immediately
gets a `stdin-eof` event, calls `bridge.shutdown()` (which terminates LuaJIT), then
`process.exit(0)`. The whole child-process tree exits cleanly before the SDK's 2 s
timeout triggers, leaving no orphans.

### SDK transport close() detail

`StdioClientTransport.close()` (from
`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js`):

1. Sets `this._process = undefined` (no double-close).
2. Calls `processToClose.stdin?.end()` — sends EOF.
3. Awaits process `close` event with a 2 000 ms race.
4. If still running: sends SIGTERM, waits another 2 000 ms.
5. If still running: sends SIGKILL.

With the `ea39f5a0` fix the server exits at step 3 — no SIGTERM/SIGKILL needed.

### All test files use try/finally

A grep of `client.close()` across `test/*.ts` confirmed every MCP-client test has
the cleanup call inside a `finally` block:

| File | Pattern |
|------|---------|
| server-test.ts | `} finally { try { await client.close(); } catch { /* ignore */ } }` |
| phase3-test.ts | `} finally { try { await client.close(); } catch { /* ignore */ } }` |
| phase4-test.ts | same |
| phase5-test.ts | same |
| phase6-test.ts | same |
| phase7-test.ts | same |
| state-integrity-test.ts | `await client.close().catch(() => {})` |
| error-handling-test.ts | `await client.close().catch(() => {})` |

`bridge-test.ts` and `session-test.ts` do not use `StdioClientTransport`; they
instantiate `LuaBridge` / `BuildSession` directly and have their own `shutdown()`
calls in `finally` blocks.

`paths-test.ts` and `_skip.ts` have no external process dependencies.

## Verdict

**No orphan leak exists in the current codebase.** The reported ~11 orphan count
was from a build before `ea39f5a0` landed (or from a system with already-running
tsx processes from a previous run that had the old bug). After `ea39f5a0`, the
stdin-EOF handler causes clean shutdown of the MCP server + LuaJIT before the SDK
transport's 2 s timeout fires, resulting in exactly 0 net node processes added per
`npm run test:all` run.

**No code changes are required.** The test cleanup pattern (`client.close()` in
`finally`) is already correct and consistent across all 8 MCP integration test
files.

## Decision: Deferral / Action

- **Deferral**: nothing to fix. The orphan leak was the same root cause that
  `ea39f5a0` already addressed. No additional `client.close()` call sites are
  missing, and no alternative cleanup mechanism is needed.
- If orphans are observed in a future run, check whether the server's
  `process.stdin.on('end', ...)` handler is still present — the most likely
  regression would be inadvertently removing it.
