// Pure LuaJIT test of lua/compound-assign.lua (no PoB needed): the source
// rewrite behind PoB 2.68's `x += 1` / `s ..= "a"` syntax and PoB 2.69's
// safe-navigation operator (`(s)?.:lower()`), which LuaJIT before a2ce8114
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
    local function pack(...) return { n = select("#", ...), ... } end
    local r = pack(pcall(func))
    if r[1] then
      for i = 2, r.n do r[i] = tostring(r[i]) end
      res = "OK:" .. table.concat(r, "|", 2, r.n)
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
  /** Number of constructs (`?.` and compound assignments) expected to be rewritten. */
  count: number;
  /** Expected run result: "OK:..." exact string, or a RegExp for "ERR:..." messages. */
  run: string | RegExp;
  /**
   * Expected run result when the LuaJIT under test parses compound assignments
   * and `?.` itself (upstream LuaJIT has since a2ce8114, 2026-07-20), so `loadfile`
   * succeeds without the rewrite. Defaults to `run`.
   */
  runNative?: string | RegExp;
}

// The local M.rewriteNav adds at the start of a file it rewrites.
const NAV = 'local __pobmcp_nav = function(r, f) if r == nil then return nil end return (f(r)) end ';

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
    runNative: 'OK:5',
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
    runNative: /^ERR:.*case-retry-fails-original-error\.lua:3: /,
  },
  {
    name: 'statements-after-an-operand-on-one-line',
    src: [
      'local a, b = 1, 2',
      'a += 1; b *= 3; a += b',
      'local c = 1 c += 2 local d = c c ..= "!"',
      'if a > 0 then a -= 1 else a += 1 end',
      'local r do local q = 1 q += 1 r = q end',
      'return a, b, c, d, r',
    ].join('\n'),
    out: [
      'local a, b = 1, 2',
      'a = a + (1); b = b * (3); a = a + (b)',
      'local c = 1 c = c + (2) local d = c c = c .. ("!")',
      'if a > 0 then a = a - (1) else a = a + (1) end',
      'local r do local q = 1 q = q + (1) r = q end',
      'return a, b, c, d, r',
    ].join('\n'),
    count: 8,
    run: 'OK:7|6|3!|3|2',
  },
  {
    name: 'rhs-continues-after-a-trailing-operator',
    src: 'local total = 1\ntotal += 2 +\n\t3 + -- three\n\t4\nlocal after = total\nreturn total, after',
    out: 'local total = 1\ntotal = total + (2 +\n\t3 + -- three\n\t4)\nlocal after = total\nreturn total, after',
    count: 1,
    run: 'OK:10|10',
  },
  {
    name: 'compound-inside-a-function-literal-rhs',
    src: [
      'local f = 0',
      'local function apply(g) return g(2) end',
      'f += apply(function(n)',
      '\tlocal acc = 0',
      '\tfor k = 1, n do',
      '\t\tif k > 0 then acc += k end',
      '\tend',
      '\twhile false do end',
      '\trepeat acc += 0 until true',
      '\treturn acc',
      'end)',
      'local g = { h = 1 }',
      'g.h += (function() return 41 end)()',
      'return f, g.h',
    ].join('\n'),
    count: 4,
    run: 'OK:3|42',
  },
  {
    name: 'lhs-shapes',
    src: [
      'local t = { n = 1, list = { 10, 20 }, sub = { k = { v = 5 } } }',
      'local function get() return t end',
      'local i = 2',
      't.n += 1',
      't.list[i] += 5',
      't.list[ i - 1 ] *= 3',
      't.sub["k"].v -= 1',
      'get().n += 10',
      ';(t).n += 100',
      't . list [1] += 1',
      'return t.n, t.list[1], t.list[2], t.sub.k.v',
    ].join('\n'),
    count: 7,
    run: 'OK:112|31|25|4',
  },
  {
    name: 'number-exponents',
    // In hex, `e` is a digit: `0xe--c` is 0xe followed by a comment.
    src: 'local a = 1\na += 0xe--c\nlocal b = 2\nlocal x = 1 x += 1e-2\nlocal y = 0 y += 0x1p-1\nlocal z = 0 z += 0xE+1\nreturn a, b, x, y, z',
    out: 'local a = 1\na = a + (0xe)--c\nlocal b = 2\nlocal x = 1 x = x + (1e-2)\nlocal y = 0 y = y + (0x1p-1)\nlocal z = 0 z = z + (0xE+1)\nreturn a, b, x, y, z',
    count: 4,
    run: 'OK:15|2|1.01|0.5|15',
  },
  {
    name: 'z-escape-in-strings',
    src: 'local s = "x"\ns ..= "a\\z\n      b" .. \'c\\z\n\'\nreturn s',
    out: 'local s = "x"\ns = s .. ("a\\z\n      b" .. \'c\\z\n\')\nreturn s',
    count: 1,
    run: 'OK:xabc',
  },
  {
    name: 'multi-line-rhs-keeps-later-line-numbers',
    src: 'local a = 0\na += (1 +\n2)\na += 1 +\n2\nerror("boom")',
    count: 2,
    run: /case-multi-line-rhs-keeps-later-line-numbers\.lua:6: boom/,
  },
  {
    name: 'unsupported-local-declaration',
    src: 'local x += 1\nreturn x',
    count: 1,
    run: /^ERR:.*case-unsupported-local-declaration\.lua:1: /,
  },
  {
    name: 'nav-pob-269-method-call',
    // Classes/CompareBuySimilar.lua:80 in PoB 2.69.0.
    src: 'local tradeName = "Mageblood 12"\ntradeName = (tradeName:match("^(.-)%s+%d+$") or tradeName)?.:lower()\nreturn tradeName',
    out:
      NAV +
      'local tradeName = "Mageblood 12"\ntradeName = __pobmcp_nav((tradeName:match("^(.-)%s+%d+$") or tradeName), function(__pobmcp_r) return __pobmcp_r:lower() end)\nreturn tradeName',
    count: 1,
    run: 'OK:mageblood',
  },
  {
    name: 'nav-nil-receiver-gives-nil',
    src: [
      'local s, t, f = nil, {}, nil',
      'local calls = 0',
      'local function arg() calls = calls + 1 return 1 end',
      'return (s)?.:lower(arg()), t.x?.y.z, t?.x, f?.(arg()), s?.[arg()], t.x?.y?.z, calls, "end"',
    ].join('\n'),
    count: 7,
    run: 'OK:nil|nil|nil|nil|nil|nil|0|end',
  },
  {
    name: 'nav-receiver-evaluated-once',
    src: [
      'local n = 0',
      'local function g() n = n + 1 return { v = 5, get = function(self) return self.v * 2 end } end',
      'local a = g()?.v',
      'local b = g()?.:get()',
      'local c = (g())?.["v"]',
      'return a, b, c, n',
    ].join('\n'),
    out: [
      NAV + 'local n = 0',
      'local function g() n = n + 1 return { v = 5, get = function(self) return self.v * 2 end } end',
      'local a = __pobmcp_nav(g(), function(__pobmcp_r) return __pobmcp_r.v end)',
      'local b = __pobmcp_nav(g(), function(__pobmcp_r) return __pobmcp_r:get() end)',
      'local c = __pobmcp_nav((g()), function(__pobmcp_r) return __pobmcp_r["v"] end)',
      'return a, b, c, n',
    ].join('\n'),
    count: 3,
    run: 'OK:5|10|5|3',
  },
  {
    name: 'nav-forms',
    src: [
      'local t = { a = { b = { c = 1 } }, f = function(x) return x end, s = "Ab" }',
      'local function id(x) return x end',
      'return t?.a.b.c, t?.a?.b?.c, t?.["a"].b.c, t.f?.(7), t?.f"str", t?.f{ 1 }[1],',
      '  t.s?.:upper(), id(t?.a)?.b.c, t . a ?. b . c, select("#", t.f?.(1, 2))',
    ].join('\n'),
    count: 13,
    run: 'OK:1|1|1|7|str|1|AB|1|1|1',
  },
  {
    // Upstream LuaJIT gives a `?.` chain one value here too.
    name: 'nav-final-call-gives-one-value',
    src: 'local t = { f = function() return 1, 2, 3 end }\nreturn t?.f(), select("#", t.f?.()), #{ t?.f() }',
    count: 3,
    run: 'OK:1|1|1',
  },
  {
    name: 'nav-statement-after-an-expression-line',
    src: 'local t = { b = { c = function(self) self.hit = true end } }\nlocal x = t\nt?.b:c()\nlocal none\nnone?.b:c()\nreturn t.b.hit',
    count: 2,
    run: 'OK:true',
  },
  {
    name: 'nav-in-strings-and-comments-untouched',
    src: 'local s = "a?.b" .. \'c?.:d()\' -- x?.:y()\n--[[ z?.w\n]] local l = [[q?.r]]\nreturn s .. l',
    count: 0,
    run: 'OK:a?.bc?.:d()q?.r',
  },
  {
    name: 'nav-and-compound-on-one-line',
    src: 'local t, o, s = { n = 1 }, { v = 2 }, "a"\nt.n += o?.v; s ..= s?.:upper() t.n *= o.w?.x or 3\nreturn t.n, s',
    out:
      NAV +
      'local t, o, s = { n = 1 }, { v = 2 }, "a"\nt.n = t.n + (__pobmcp_nav(o, function(__pobmcp_r) return __pobmcp_r.v end)); s = s .. (__pobmcp_nav(s, function(__pobmcp_r) return __pobmcp_r:upper() end)) t.n = t.n * (__pobmcp_nav(o.w, function(__pobmcp_r) return __pobmcp_r.x end) or 3)\nreturn t.n, s',
    count: 6,
    run: 'OK:9|aA',
  },
  {
    name: 'nav-across-lines-keeps-line-numbers',
    src: 'local t = { a = { b = 1 } }\nlocal v = t\n  ?.a -- field\n  .b\nlocal w = (t)?.:\nnoMethod()\nerror("boom " .. v)',
    count: 2,
    run: /^ERR:.*case-nav-across-lines-keeps-line-numbers\.lua:6: attempt to call method 'noMethod'/,
  },
  {
    name: 'nav-error-line',
    src: 'local t = {}\nlocal v = t?.x\nerror("boom")',
    count: 1,
    run: /case-nav-error-line\.lua:3: boom/,
  },
  {
    name: 'nav-method-value-check-left-alone',
    src: 'local o = {}\nreturn o:m?.(1), "end"',
    count: 0,
    run: /^ERR:.*case-nav-method-value-check-left-alone\.lua:2: .*near '\?'$/,
    runNative: 'OK:nil|end',
  },
  {
    name: 'nav-vararg-in-chain-left-alone',
    src: 'local function f(...) local t = { x = select } return t?.x("#", ...) end\nreturn f(1, 2)',
    count: 0,
    run: /^ERR:.*case-nav-vararg-in-chain-left-alone\.lua:1: .*near '\?'$/,
    runNative: 'OK:2',
  },
  {
    name: 'nav-retry-fails-original-error',
    src: 'local t = {}\nlocal v = t?.x\nreturn )',
    count: 1,
    run: /^ERR:.*case-nav-retry-fails-original-error\.lua:2: .*near '\?'$/,
    runNative: /^ERR:.*case-nav-retry-fails-original-error\.lua:3: /,
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

  // Newer upstream LuaJIT parses `x += 1` natively; then loadfile never needs
  // the rewrite and only cases that depend on a parse failure differ.
  const native = spawnSync(luajit, ['-e', 'assert(loadstring("local x = 1 x += 1"))']).status === 0;
  console.log(`LuaJIT ${native ? 'parses' : 'rejects'} compound assignments natively`);

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

      if (count !== c.count) fail(`${c.name}: rewrote ${count} construct(s), expected ${c.count}`);
      if (c.out !== undefined && out !== c.out) {
        fail(`${c.name}: rewrite mismatch\n--- expected\n${c.out}\n--- got\n${out}`);
      }
      if (c.count === 0 && out !== c.src) fail(`${c.name}: source without rewritable constructs was modified`);
      if (out.split('\n').length !== c.src.split('\n').length) fail(`${c.name}: line count changed by the rewrite`);
      const want = native && c.runNative !== undefined ? c.runNative : c.run;
      const runOk = typeof want === 'string' ? run === want : want.test(run);
      if (!runOk) fail(`${c.name}: run result ${JSON.stringify(run)} does not match ${String(want)}`);
      console.log(`PASS: ${c.name}`);
    }
    console.log('ALL LUA-COMPAT TESTS PASSED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
