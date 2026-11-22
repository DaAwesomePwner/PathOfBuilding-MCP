// Pure LuaJIT test of lua/compound-assign.lua (no PoB needed): the source
// rewrite behind PoB 2.68's `x += 1` / `s ..= "a"` syntax, which stock LuaJIT
// does not parse. Needs only a luajit binary.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaJITNotFoundError, resolveLuaJIT } from '../src/luajit-paths.js';
import { skipOrFail } from './_skip.js';

const moduleFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lua', 'compound-assign.lua');

// For each case name in cases.txt: writes the rewritten source to <name>.out and
// the result of loading + running the file through the module's loadfile to
// <name>.run ("OK:<returns joined by |>" or "ERR:<message>").
const DRIVER = `
local ca = dofile(arg[1])
local dir = arg[2]
for name in io.lines(dir .. "/cases.txt") do
  local path = dir .. "/" .. name .. ".lua"
  local f = assert(io.open(path, "rb")); local src = f:read("*a"); f:close()
  local out, count = ca.rewrite(src)
  local o = assert(io.open(dir .. "/" .. name .. ".out", "wb")); o:write(out, "\\n#", tostring(count)); o:close()
  local func, err = ca.loadfile(path)
  local res
  if not func then
    res = "ERR:" .. err
  else
    local r = { pcall(func) }
    if r[1] then
      for i = 2, #r do r[i] = tostring(r[i]) end
      res = "OK:" .. table.concat(r, "|", 2)
    else
      res = "ERR:" .. tostring(r[2])
    end
  end
  local r = assert(io.open(dir .. "/" .. name .. ".run", "wb")); r:write(res); r:close()
end
`;

interface Case {
  name: string;
  src: string;
  /** Exact rewritten source (omit to skip the check). */
  out?: string;
  /** Number of compound assignments expected to be rewritten. */
  count: number;
  /** Expected run result: "OK:..." exact string, or a RegExp for "ERR:..." messages. */
  run: string | RegExp;
}

const cases: Case[] = [
  {
    name: 'add',
    src: 'local x = 1\nx += 1\nreturn x',
    out: 'local x = 1\nx = x + (1)\nreturn x',
    count: 1,
    run: 'OK:2',
  },
  {
    name: 'indexed-lhs-call-rhs',
    src: 'local function f(x) return x * 2 end\nlocal t = { a = { 5 } }\nlocal b, x = 1, 3\nt.a[b] -= f(x)\nreturn t.a[1]',
    out: 'local function f(x) return x * 2 end\nlocal t = { a = { 5 } }\nlocal b, x = 1, 3\nt.a[b] = t.a[b] - (f(x))\nreturn t.a[1]',
    count: 1,
    run: 'OK:-1',
  },
  {
    name: 'concat',
    src: 'local s, b = "x", "b"\ns ..= "a" .. b\nreturn s',
    out: 'local s, b = "x", "b"\ns = s .. ("a" .. b)\nreturn s',
    count: 1,
    run: 'OK:xab',
  },
  {
    name: 'all-operators-and-precedence',
    src: 'local a = 10\na -= 2 + 3\na *= 4\na /= 2\na %= 7\na ^= 2\na += 1\nreturn a',
    out: 'local a = 10\na = a - (2 + 3)\na = a * (4)\na = a / (2)\na = a % (7)\na = a ^ (2)\na = a + (1)\nreturn a',
    count: 6,
    run: 'OK:10',
  },
  {
    name: 'strings-and-comments-untouched',
    src: [
      'local s = "a += 1"',
      "local s2 = 'b -= 2 \\' c *= 3'",
      '-- x += 1',
      '--[[ y -= 2',
      ' z ..= 3 ]]',
      '--[==[ q /= 2 ]] still comment ]==]',
      'local l = [==[ q *= 2 ]]',
      ' w ..= "4" ]==]',
      'return s .. s2 .. l',
    ].join('\n'),
    count: 0,
    run: /^OK:a \+= 1b -= 2 ' c \*= 3 q \*= 2 \]\]\n w \.\.= "4" $/,
  },
  {
    name: 'real-compound-next-to-literals',
    src: 'local n = 1 -- n += 100\nlocal s = "n += 100"\nn += 2 --[[ n += 5 ]]\nreturn n .. s',
    out: 'local n = 1 -- n += 100\nlocal s = "n += 100"\nn = n + (2) --[[ n += 5 ]]\nreturn n .. s',
    count: 1,
    run: 'OK:3n += 100',
  },
  {
    name: 'comparison-operators-untouched',
    src: 'local a, b = 1, 2\nreturn tostring(a == b) .. tostring(a ~= b) .. tostring(a <= b) .. tostring(a >= b)',
    count: 0,
    run: 'OK:falsetruetruefalse',
  },
  {
    name: 'comparisons-around-a-real-compound',
    src: 'local a = 3\nif a >= 0 and a <= 5 then a += 10 end\nreturn a',
    out: 'local a = 3\nif a >= 0 and a <= 5 then a = a + (10) end\nreturn a',
    count: 1,
    run: 'OK:13',
  },
  {
    name: 'trailing-comment',
    src: 'local n = 1\nn *= 3   -- triple += x\nreturn n',
    out: 'local n = 1\nn = n * (3)   -- triple += x\nreturn n',
    count: 1,
    run: 'OK:3',
  },
  {
    name: 'semicolons',
    src: 'local n = 1; n += 2; n += 3\nreturn n',
    out: 'local n = 1; n = n + (2); n = n + (3)\nreturn n',
    count: 2,
    run: 'OK:6',
  },
  {
    name: 'multi-line-rhs',
    src: 'local t = { 1 }\nt[1] += #{\n  1,\n  2 }\nreturn t[1]',
    out: 'local t = { 1 }\nt[1] = t[1] + (#{\n  1,\n  2 })\nreturn t[1]',
    count: 1,
    run: 'OK:3',
  },
  {
    name: 'function-in-rhs',
    src: 'local c = 1\nif c then c += (function() local z = 2 return z end)() end\nreturn c',
    count: 1,
    run: 'OK:3',
  },
  {
    name: 'block-comment-inside-rhs',
    src: 'local x = 10\nx -= 1 --[[c]] - 2\nreturn x',
    out: 'local x = 10\nx = x - (1 --[[c]] - 2)\nreturn x',
    count: 1,
    run: 'OK:11',
  },
  {
    name: 'block-comment-after-rhs',
    src: 'local x = 10\nx -= 1 --[[ c\n]] -- d\nreturn x',
    out: 'local x = 10\nx = x - (1) --[[ c\n]] -- d\nreturn x',
    count: 1,
    run: 'OK:9',
  },
  {
    name: 'multi-line-comment-before-lhs',
    src: 'local n = 1\n--[[ a\nb ]] n += 4\nreturn n',
    out: 'local n = 1\n--[[ a\nb ]] n = n + (4)\nreturn n',
    count: 1,
    run: 'OK:5',
  },
  {
    name: 'multi-line-comment-inside-lhs-left-alone',
    src: 'local t = { 1 }\nt --[[ a\nb ]] [1] += 4\nreturn t[1]',
    count: 0,
    run: /multi-line-comment-inside-lhs-left-alone\.lua:3: '=' expected near '\+'$/,
  },
  {
    name: 'crlf',
    src: 'local x = 1\r\nx += 1\r\nreturn x\r\n',
    out: 'local x = 1\r\nx = x + (1)\r\nreturn x\r\n',
    count: 1,
    run: 'OK:2',
  },
  {
    name: 'parses-as-is-unchanged',
    src: 'local x = 1 -- x += 1\nx = x + 1\nreturn x',
    out: 'local x = 1 -- x += 1\nx = x + 1\nreturn x',
    count: 0,
    run: 'OK:2',
  },
  {
    name: 'runtime-error-line',
    src: 'local x = 1\nx += 1\nerror("boom")',
    count: 1,
    run: /case-runtime-error-line\.lua:3: boom/,
  },
  {
    name: 'retry-fails-original-error',
    src: 'local x = 1\nx += 1\nreturn )',
    count: 1,
    run: /^ERR:.*case-retry-fails-original-error\.lua:2: '=' expected near '\+'$/,
  },
];

function fail(message: string): never {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

function main(): void {
  let luajit: string;
  try {
    luajit = resolveLuaJIT(os.tmpdir()).luajitPath;
  } catch (e) {
    if (e instanceof LuaJITNotFoundError) {
      skipOrFail(' lua-compat', e.message);
      return;
    }
    throw e;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'pob-mcp-lua-compat-'));
  try {
    // Files are named `case-<name>.lua`; the driver maps a case name to its files.
    const names = cases.map((c) => `case-${c.name}`);
    writeFileSync(path.join(dir, 'cases.txt'), names.join('\n') + '\n');
    writeFileSync(path.join(dir, 'driver.lua'), DRIVER);
    cases.forEach((c, i) => writeFileSync(path.join(dir, `${names[i]}.lua`), c.src));

    const r = spawnSync(luajit, [path.join(dir, 'driver.lua'), moduleFile, dir.replace(/\\/g, '/')], {
      encoding: 'utf8',
    });
    if (r.status !== 0) fail(`luajit driver exited ${r.status}: ${r.stderr || r.error}`);

    for (const [i, c] of cases.entries()) {
      const outRaw = readFileSync(path.join(dir, `${names[i]}.out`), 'utf8');
      const marker = outRaw.lastIndexOf('\n#');
      const out = outRaw.slice(0, marker);
      const count = Number(outRaw.slice(marker + 2));
      const run = readFileSync(path.join(dir, `${names[i]}.run`), 'utf8');

      if (count !== c.count) fail(`${c.name}: rewrote ${count} compound assignment(s), expected ${c.count}`);
      if (c.out !== undefined && out !== c.out) {
        fail(`${c.name}: rewrite mismatch\n--- expected\n${c.out}\n--- got\n${out}`);
      }
      if (c.count === 0 && out !== c.src) fail(`${c.name}: source without compound assignments was modified`);
      if (out.split('\n').length !== c.src.split('\n').length) fail(`${c.name}: line count changed by the rewrite`);
      const runOk = typeof c.run === 'string' ? run === c.run : c.run.test(run);
      if (!runOk) fail(`${c.name}: run result ${JSON.stringify(run)} does not match ${String(c.run)}`);
      console.log(`PASS: ${c.name}`);
    }
    console.log('ALL LUA-COMPAT TESTS PASSED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
