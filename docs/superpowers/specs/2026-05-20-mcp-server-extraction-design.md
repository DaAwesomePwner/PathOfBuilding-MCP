# Standalone MCP Server Extraction — Design

**Status:** Draft
**Date:** 2026-05-20
**Owner:** dap

## Goal

Convert this repo from "upstream PoB clone + mcp-server bolted on top" into a standalone `pob-mcp-server` project that depends on the user's own Path of Building Community installation (the AppData install produced by the Windows installer). The repo's purpose narrows from "fork of PoB" to "MCP server for PoB."

## Non-Goals

- No new MCP tools or feature work. The 33 existing tools must continue to function bit-for-bit.
- No bundled LuaJIT binary, no FFI shim into `lua51.dll`, no PoB submodule.
- No CI/GitHub Actions setup. (Tracked as a follow-up; documented in README.)
- No code-quality refactors outside what is needed for path decoupling.
- No support for non-AppData install locations beyond best-effort macOS/Linux probes.

## Background

The current repo contains two intertwined projects:

1. **Upstream PoB:** `src/`, `runtime/`, `spec/`, `docs/`, `tests/`, `Dockerfile`, `manifest.xml`, the Windows binaries (`Path of Building.exe`, `lua51.dll`, etc.), and the rest of the upstream tree.
2. **MCP server:** Everything under `mcp-server/` — a Node/TypeScript MCP server plus a Lua adapter (`mcp-server/lua/bridge.lua`).

The two are coupled through path assumptions:

- `mcp-server/src/lua-bridge.ts` takes a `repoRoot` and uses `path.join(repoRoot, 'mcp-server', 'lua', 'bridge.lua')` and `path.join(repoRoot, 'src')` as its working directory.
- `mcp-server/lua/bridge.lua` receives that same `repoRoot` as `arg[1]` and resolves `<repoRoot>/runtime/lua/`, `<repoRoot>/src/HeadlessWrapper.lua`, etc.
- `mcp-server/src/lua-bridge.ts#findLuaJITPath()` probes `<repoRoot>/runtime/luajit`, etc.
- Test files compute `repoRoot = path.resolve(__dirname, '../..')` — i.e., they assume `mcp-server/` sits one level below an upstream PoB checkout.

A compiled PoB Community install at `%APPDATA%\Path of Building Community\` already contains exactly the directory layout the bridge needs (`src/HeadlessWrapper.lua`, `runtime/lua/`, `lua51.dll`). The extraction is therefore "swap `repoRoot` for `pobPath`, source `pobPath` from the environment."

## Design Decisions (resolved during brainstorming)

| Axis                  | Decision                                                                                                   |
|-----------------------|------------------------------------------------------------------------------------------------------------|
| PoB target            | Compiled PoB Community install (the Windows installer's AppData layout).                                   |
| Install discovery     | `POB_PATH` env var override; otherwise auto-detect `%APPDATA%\Path of Building Community\` on Windows.     |
| LuaJIT discovery      | `LUAJIT_PATH` override; else probe the PoB install's `runtime/luajit{,.exe}`; else `luajit` on PATH.       |
| Repo strategy         | Rewrite this repo in place — delete upstream, promote `mcp-server/*` to root, keep git history.            |
| Test strategy         | Tests share the server's `POB_PATH` discovery; skip with a clear message (exit 0) when unset.              |
| Distribution          | Publish to npm as `pob-mcp-server`; users run via `npx -y pob-mcp-server`.                                 |
| Existing design docs  | Promote and rewrite `GETTING_STARTED.md` + `TROUBLESHOOTING.md`; archive `plans/*` under `docs/history/`.  |

## Architecture After Extraction

The three-layer architecture is unchanged in shape; only the source of `src/`, `runtime/`, and `luajit` moves from "this repo's parent dirs" to "the user's PoB install":

```
Claude Desktop  <--stdio MCP-->  pob-mcp-server (Node)  <--stdio JSON-->  bridge.lua (LuaJIT)
                                                                                |
                                                                                v
                                                       %APPDATA%\Path of Building Community\
                                                       (src/, runtime/lua/, lua51.dll, …)
```

Ownership boundary: the standalone repo owns `lua/bridge.lua` (our adapter) and the TS server. It does **not** own `HeadlessWrapper.lua`, the calculation engine, or any PoB data — those live in the user's install and are loaded at runtime.

## Components

### `src/paths.ts` (new)

Single source of truth for install discovery. Used by both the server and the tests.

**Exports:**

```ts
export class PoBInstallNotFoundError extends Error {}
export class LuaJITNotFoundError extends Error {}

export interface ResolvedPaths {
  pobPath: string;      // root of the user's PoB install
  luajitPath: string;   // executable to spawn
  bridgeLua: string;    // <this repo>/lua/bridge.lua, resolved relative to import.meta.url
}

export function resolvePoBPath(): string;
export function resolveLuaJITPath(pobPath: string): string;
export function resolvePaths(): ResolvedPaths;
```

**`resolvePoBPath()` order:**

1. `process.env.POB_PATH` (if set, *must* validate; do not silently fall through).
2. `path.join(process.env.APPDATA, 'Path of Building Community')` on Windows.
3. `path.join(os.homedir(), 'Library/Application Support/Path of Building Community')` on macOS.
4. `path.join(os.homedir(), '.local/share/Path of Building Community')` on Linux.
5. Throw `PoBInstallNotFoundError` listing what was probed and how to set `POB_PATH`.

**Validation:** an accepted path must contain `src/HeadlessWrapper.lua`. If it also contains either `runtime/lua/` or `lua51.dll`, that's an additional confidence check; absence is a hard error with a message saying "this looks like a PoB *source* clone, not a compiled install — use the Steam/installer build instead."

**`resolveLuaJITPath(pobPath)` order:**

1. `process.env.LUAJIT_PATH` if set and the file exists.
2. `<pobPath>/runtime/luajit` (Linux/Mac convention).
3. `<pobPath>/runtime/luajit.exe` (Windows convention).
4. `<pobPath>/runtime/bin/luajit{,.exe}` (alternate convention).
5. `luajit` (or `luajit.exe`) on PATH via `which`/`where`.
6. Throw `LuaJITNotFoundError` with install hints (winget, scoop, brew, apt-get).

### `src/lua-bridge.ts` (refactored)

- Constructor signature changes: `new LuaBridge(repoRoot, luajitPath?, timeoutMs?)` → `new LuaBridge(paths: ResolvedPaths, timeoutMs?)`.
- `findLuaJITPath()` is **removed**; that logic now lives in `paths.ts`.
- `spawnProcess()` uses `paths.bridgeLua` for the script and `paths.pobPath` as `arg[1]` and as `cwd = path.join(paths.pobPath, 'src')`.
- All other behavior (mutex, snapshot/restore, crash circuit breaker, undo stack, error classification) is unchanged.

### `src/build-session.ts` and `src/server.ts`

Single call-site update each: instead of computing `repoRoot` from a parent directory, they call `resolvePaths()` once at construction. On `PoBInstallNotFoundError` or `LuaJITNotFoundError`, `server.ts` writes a friendly message to stderr and `process.exit(1)`. MCP clients (Claude Desktop, Claude Code) will surface the stderr output to the user.

### `lua/bridge.lua` (no behavior change)

The Lua adapter is moved verbatim from `mcp-server/lua/bridge.lua` to `lua/bridge.lua`. Its `arg[1]` is now the user's PoB install path, but the directory shape under that path (`src/HeadlessWrapper.lua`, `runtime/lua/`) is identical to what the upstream repo provides, so `package.path`, `package.cpath`, and `dofile('HeadlessWrapper.lua')` continue to work.

### Tests (`test/*.ts`)

Each test currently has roughly:

```ts
const repoRoot = path.resolve(__dirname, '../..');
const bridge = new LuaBridge(repoRoot);
```

Becomes:

```ts
import { resolvePaths, PoBInstallNotFoundError, LuaJITNotFoundError } from '../src/paths.js';

let paths: ResolvedPaths;
try {
  paths = resolvePaths();
} catch (e) {
  if (e instanceof PoBInstallNotFoundError || e instanceof LuaJITNotFoundError) {
    console.log(`SKIPPED: ${e.message}`);
    process.exit(0);
  }
  throw e;
}
const bridge = new LuaBridge(paths);
```

A small helper in `test/_skip.ts` factors that block so each test file is one import + one call.

## Repository Layout (Final State)

```
pob-mcp-server/
├── README.md
├── GETTING_STARTED.md
├── TROUBLESHOOTING.md
├── CLAUDE.md
├── LICENSE                 (MIT, for our code only)
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── server.ts
│   ├── build-session.ts
│   ├── lua-bridge.ts
│   ├── paths.ts            (new)
│   ├── timing.ts
│   └── validation.ts
├── lua/
│   └── bridge.lua
├── test/
│   ├── _skip.ts            (new helper)
│   ├── bridge-test.ts
│   ├── session-test.ts
│   ├── server-test.ts
│   ├── phase3-test.ts
│   ├── phase4-test.ts
│   ├── phase5-test.ts
│   ├── phase6-test.ts
│   ├── phase7-test.ts
│   ├── state-integrity-test.ts
│   └── error-handling-test.ts
└── docs/
    └── history/
        ├── README.md
        ├── pob-mcp-build-instructions-v2.md
        ├── phase3.md
        ├── phase4.md
        ├── phase5.md
        ├── phase6.md
        └── phase7.md
```

### Files Deleted

- `src/` — upstream PoB Lua sources (replaced by our own `src/` from `mcp-server/src/`).
- `runtime/`, `runtime-win32.zip` — upstream PoB runtime.
- `spec/`, `tests/` — upstream PoB busted specs.
- `docs/` (upstream content) — replaced by our new `docs/history/`.
(Note: `plans/` and `pob-mcp-build-instructions-v2.md` are *moved* to `docs/history/`, not deleted — see the "Files Moved" section.)
- Root binaries: `Path of Building.exe`, `Update.exe`, `SimpleGraphic*`, every `*.dll`, `runtime-win32.zip`.
- `Dockerfile`, `docker-compose.yml`.
- `manifest.xml`, `manifest.cfg`, `update_manifest.py`, `fix_ascendancy_positions.py`.
- `CHANGELOG.md`, `changelog.txt`, `RELEASE.md`, `help.txt`.
- `CONTRIBUTING.md` (PoB's), `LICENSE.md` (PoB's — replaced by MIT `LICENSE` for our code).
- `README.md` (PoB's — replaced).
- `pob-mcp-build-instructions-v2.md` — moved to `docs/history/`.

### Files Moved (via `git mv` to preserve history)

- `mcp-server/src/*` → `src/*`
- `mcp-server/lua/bridge.lua` → `lua/bridge.lua`
- `mcp-server/test/*` → `test/*`
- `mcp-server/package.json` → `package.json` (then modified)
- `mcp-server/tsconfig.json` → `tsconfig.json`
- `mcp-server/README.md` → `README.md` (then rewritten)
- `mcp-server/GETTING_STARTED.md` → `GETTING_STARTED.md` (then revised)
- `mcp-server/TROUBLESHOOTING.md` → `TROUBLESHOOTING.md` (then revised)
- `plans/phase*.md` → `docs/history/phase*.md`

## Package Configuration

`package.json`:

```json
{
  "name": "pob-mcp-server",
  "version": "0.1.0",
  "description": "MCP server exposing Path of Building Community's calculation engine to LLM clients",
  "type": "module",
  "bin": { "pob-mcp": "./dist/server.js" },
  "main": "./dist/server.js",
  "files": ["dist/", "lua/", "README.md", "GETTING_STARTED.md", "TROUBLESHOOTING.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc && chmod +x dist/server.js",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "prepublishOnly": "npm run build",
    "test:bridge": "tsx test/bridge-test.ts",
    "test:session": "tsx test/session-test.ts",
    "test:server": "tsx test/server-test.ts",
    "test:phase3": "tsx test/phase3-test.ts",
    "test:phase4": "tsx test/phase4-test.ts",
    "test:phase5": "tsx test/phase5-test.ts",
    "test:phase6": "tsx test/phase6-test.ts",
    "test:phase7": "tsx test/phase7-test.ts",
    "test:integrity": "tsx test/state-integrity-test.ts",
    "test:errors": "tsx test/error-handling-test.ts",
    "test:all": "npm run test:bridge && npm run test:session && npm run test:server && npm run test:phase3 && npm run test:phase4 && npm run test:phase5 && npm run test:phase6 && npm run test:phase7 && npm run test:integrity && npm run test:errors"
  },
  "repository": { "type": "git", "url": "git+https://github.com/dap/pob-mcp-server.git" },
  "bugs": { "url": "https://github.com/dap/pob-mcp-server/issues" },
  "homepage": "https://github.com/dap/pob-mcp-server#readme",
  "license": "MIT",
  "dependencies": { "@modelcontextprotocol/sdk": "^1.29.0", "zod": "^4.3.6" },
  "devDependencies": { "@types/node": "^22.15.3", "tsx": "^4.19.4", "typescript": "^5.8.3" }
}
```

(The `repository`/`bugs`/`homepage` URLs assume the repo will live at `github.com/dap/pob-mcp-server`. Confirm during execution; substitute the real owner if different.)

`tsconfig.json`: `rootDir: "./src"`, `outDir: "./dist"`. Because `src/` is now at repo root (no `mcp-server/` prefix), the `bin` field becomes `./dist/server.js` rather than `./dist/src/server.js`.

## Documentation

### `README.md` (new, ~150 lines)

Sections in order:

1. **What it is** — one paragraph.
2. **Prerequisites** — Node 20+, Path of Building Community installed (Windows installer), and a LuaJIT 5.1 binary. (PoB installs ship `lua51.dll` for their own GUI but not always a standalone `luajit` executable — users may need to install one separately. Document install commands per platform.)
3. **Quick start** — `npx -y pob-mcp-server` smoke test; then sample MCP client config snippets for Claude Desktop and Claude Code.
4. **Configuration table** — `POB_PATH`, `LUAJIT_PATH`, `POB_TIMING` env vars, with defaults and detection rules.
5. **Tool catalog** — one-line summary of each of the 33 tools, with a link to `GETTING_STARTED.md` for the narrative tour.
6. **Troubleshooting** — link to `TROUBLESHOOTING.md`.
7. **Development** — clone, install, build, test (note: tests need PoB installed and discoverable).
8. **CI follow-up** — a callout that GitHub Actions wiring is not yet present.
9. **License + acknowledgments** — MIT for this code; PoB Community remains under its own license at the user's install.

### `GETTING_STARTED.md`

Existing tour content. Only the setup section is rewritten — drop `cd mcp-server`, drop the parent-repo assumption, replace with `npx -y pob-mcp-server` and the `POB_PATH` env var. Tool walkthroughs unchanged.

### `TROUBLESHOOTING.md`

Existing entries kept. Two new entries promoted to the top:

- **"PoB install not found"** — what `POB_PATH` should point at, how to verify with `dir %APPDATA%\Path of Building Community\src\HeadlessWrapper.lua`, what to do on macOS/Linux.
- **"LuaJIT not found"** — install commands per platform (winget, scoop, choco, brew, apt-get) and how to set `LUAJIT_PATH`. Clarify that PoB's bundled `lua51.dll` is *not* sufficient — a standalone executable is required.

### `CLAUDE.md` (rewritten)

Single-project version. Sections:

- **What this repo is** — MCP server for PoB. PoB itself is an external runtime dependency.
- **Common commands** — `npm run dev`, `npm test:*`, `npm run build`. Env vars (`POB_PATH`, `LUAJIT_PATH`, `POB_TIMING`).
- **Architecture** — same three-layer description, but with PoB as an external dependency.
- **Invariants** — same list: one process per session, async mutex, snapshot-and-restore, three-strike circuit breaker, undo-stack semantics, error classification.
- **Conventions** — drop upstream PoB items (PR target branch, generated `src/Data/*`, dev mode, manifest hashes). Keep MCP-server items (item text must start with `Rarity:`, build-code round-trip is lossless).
- **Reference files** — `GETTING_STARTED.md`, `TROUBLESHOOTING.md`, `docs/history/` for design rationale.

### `docs/history/README.md` (new)

Two paragraphs: what the historical docs are (design rationale and phase plans from the original build), why they're kept (provenance and decision history), and a note that they reference the pre-extraction repo layout and shouldn't be taken as the current architecture.

## Execution Sequence

A single feature branch, eight commits, each individually green:

1. **Add `src/paths.ts` + unit tests for path discovery.** Still inside `mcp-server/`. Tests cover: env-var override wins, AppData detection works with `APPDATA` mocked, validation rejects bad paths, errors carry actionable messages, LuaJIT order is correct.
2. **Refactor `lua-bridge.ts` to take `ResolvedPaths`.** `BuildSession` updates one call site; `server.ts` updates one call site. Delete `findLuaJITPath()` from `lua-bridge.ts`. All existing tests still pass because passing `POB_PATH=<this repo root>` produces the same paths as the old code path.
3. **Update integration tests to use `resolvePaths()` and the new `_skip.ts` helper.** Still running against the in-repo PoB.
4. **Delete upstream tree; `git mv mcp-server/* .` to promote contents.** Adjust `tsconfig.json` and `bin` in `package.json`. After this commit, `npm run test:bridge` requires the user's external PoB install — verify locally against `%APPDATA%\Path of Building Community\` before committing.
5. **Rewrite docs.** New `README.md`, revised `GETTING_STARTED.md` and `TROUBLESHOOTING.md`, new `CLAUDE.md`, `docs/history/README.md`. `git mv plans/* docs/history/` and `git mv pob-mcp-build-instructions-v2.md docs/history/`.
6. **Package metadata.** Add MIT `LICENSE`, fill `repository`/`bugs`/`homepage`, set `files`, drop `private: true`, add `prepublishOnly`.
7. **Verify locally.** `npm install`, `npm run build`, `npm pack`, `npx ./pob-mcp-server-0.1.0.tgz --version`. Run `npm run test:all` against the real install.
8. **(Out of scope for the implementation plan.)** `npm publish` when you're ready.

## Validation Plan

After step 7, verification checklist:

- `npm run build` succeeds with no TypeScript errors.
- `npm run test:bridge` passes against `%APPDATA%\Path of Building Community\`.
- `npm run test:integrity` passes (bit-exact snapshot/restore invariant).
- `npm run test:all` passes end-to-end.
- Smoke test from a packed tarball: `npm pack && npx ./pob-mcp-server-0.1.0.tgz` and confirm the server starts and reports a ready line.
- Negative test: unset `POB_PATH`, run `npm run test:bridge`, confirm it skips with the expected message (when also no AppData install).
- Negative test: set `POB_PATH` to a bogus directory, confirm `PoBInstallNotFoundError` with helpful text.
- Negative test: set `LUAJIT_PATH` to a non-existent file, confirm `LuaJITNotFoundError`.

## Risks and Mitigations

| Risk                                                                    | Mitigation                                                                                                                                 |
|-------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| Step 4 (the destructive commit) leaves a hidden path assumption behind. | Steps 1–3 introduce `paths.ts` and convert all call sites *first*, so step 4 is purely file deletion. Any breakage bisects to a known spot. |
| AppData detection fires when user has a *source clone* there, not an installer build. | Validate by checking for `lua51.dll` or `runtime/lua/`; if absent, error with "this looks like a source clone, not a compiled install."     |
| LuaJIT executable absent from typical PoB Community installs.           | Fall back to `luajit` on PATH; document install commands per platform in TROUBLESHOOTING; make `LuaJITNotFoundError` actionable (lists what was probed and how to install).                                                  |
| Compiled PoB install layout changes in a future upstream release.       | Validation is structural (looks for `src/HeadlessWrapper.lua`), not version-specific. Tests will fail loudly if the layout actually changes.|
| npm name `pob-mcp-server` is taken.                                     | Check before publish; fall back to `@dap/pob-mcp-server` scoped package. Decision deferred to step 8.                                       |
| Existing users of this repo lose their workflow.                        | Out of scope — this is a fork, the upstream PoB repo continues to exist for users who want the planner. Document the split in README.       |

## Open Questions

None at design time. Items deferred to execution:

- Final GitHub repo name and owner (affects `package.json` URLs).
- Whether to add a CI workflow (currently out of scope; noted as follow-up).
