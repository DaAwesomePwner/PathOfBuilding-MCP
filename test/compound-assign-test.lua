-- Unit tests for lua/compound-assign.lua. Needs only LuaJIT (no PoB).
-- Usage: luajit test/compound-assign-test.lua <path to lua/compound-assign.lua> <scratch dir>
-- Prints one line per case and exits 1 if any case fails.

local modulePath, scratchDir = arg[1], arg[2]
assert(modulePath and scratchDir, "usage: compound-assign-test.lua <module> <scratch dir>")
local CA = dofile(modulePath)

local failures, passed = 0, 0
local function case(name, fn)
	local ok, err = pcall(fn)
	if ok then
		passed = passed + 1
		print("PASS " .. name)
	else
		failures = failures + 1
		print("FAIL " .. name .. ": " .. tostring(err))
	end
end

local function eq(actual, expected, what)
	if actual ~= expected then
		error((what or "value") .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual), 2)
	end
end

local function countNewlines(s)
	local _, n = s:gsub("\n", "")
	return n
end

-- Compiles `src` through the module and runs it with `env` as globals.
local function run(src, env)
	local fn, err = CA.loadstring(src, "=test")
	if not fn then error("compile failed: " .. tostring(err), 2) end
	env = env or { }
	setmetatable(env, { __index = _G })
	setfenv(fn, env)
	return fn(), env
end

-- Asserts the exact rewrite and that it keeps every newline.
local function rewritesTo(src, expected)
	local out, why = CA.rewrite(src)
	if not out then error("not rewritten: " .. tostring(why), 2) end
	eq(out, expected, "rewrite")
	eq(countNewlines(out), countNewlines(src), "newline count")
end

case("each operator", function()
	local _, env = run([[
a = 10 a += 5
b = 10 b -= 3
c = 10 c *= 4
d = 10 d /= 4
e = 10 e %= 4
f = 2  f ^= 10
g = "x" g ..= "y"
]])
	eq(env.a, 15, "+=")
	eq(env.b, 7, "-=")
	eq(env.c, 40, "*=")
	eq(env.d, 2.5, "/=")
	eq(env.e, 2, "%=")
	eq(env.f, 1024, "^=")
	eq(env.g, "xy", "..=")
end)

case("exact rewrite text", function()
	rewritesTo("count += 1", "count = count + ( 1)")
	rewritesTo("url ..= \"/\" .. x", "url = url .. ( \"/\" .. x)")
	rewritesTo("t[i].n -= 2 -- note += 1", "t[i].n = t [ i ] . n - ( 2) -- note += 1")
end)

case("..= with chained concatenation", function()
	local _, env = run([[
local x, y = "b", "c"
s = "a"
s ..= x .. "-" .. y
s ..= 1 .. 2
]])
	eq(env.s, "ab-c12")
end)

case("precedence: rhs is parenthesised", function()
	local _, env = run([[
x = 2  x *= 3 + 4
y = 10 y -= 2 - 1
z = 2  z ^= 1 + 1
w = 1  w += 2 * 3 ^ 2
]])
	eq(env.x, 14, "x *= 3 + 4")
	eq(env.y, 9, "y -= 2 - 1")
	eq(env.z, 4, "z ^= 1 + 1")
	eq(env.w, 19, "w += 2 * 3 ^ 2")
end)

case("indexed and field lhs", function()
	local _, env = run([[
t = { n = 1, list = { 10, 20 }, sub = { [ "k" ] = { v = 5 } } }
local function get() return t end
local i = 2
t.n += 1
t.list[i] += 5
t.list[ i - 1 ] *= 3
t.sub["k"].v -= 1
get().n += 10
;(t).n += 100
t . list [1] += 1
]])
	eq(env.t.n, 112, "t.n")
	eq(env.t.list[1], 31, "t.list[1]")
	eq(env.t.list[2], 25, "t.list[2]")
	eq(env.t.sub.k.v, 4, "t.sub.k.v")
end)

case("multi-line rhs", function()
	local _, env = run([[
total = 1
total += 2 +
	3 +
	4
after = total
]])
	eq(env.total, 10)
	eq(env.after, 10)
end)

case("function-literal rhs", function()
	local _, env = run([[
f = 0
local function apply(g) return g(2) end
f += apply(function(n)
	local acc = 0
	for k = 1, n do
		if k > 0 then acc += k end
	end
	while false do end
	repeat acc += 0 until true
	return acc
end)
g = { }
g.h = 1
g.h += (function() return 41 end)()
]])
	eq(env.f, 3, "f")
	eq(env.g.h, 42, "g.h")
end)

case("statements on one line, separated by ; and whitespace", function()
	local _, env = run([[
a = 1; b = 2
a += 1; b *= 3; a += b
c = 1 c += 2 d = c c ..= "!"
if a > 0 then a -= 1 else a += 1 end
do local q = 1 q += 1 r = q end
]])
	eq(env.a, 7, "a")
	eq(env.b, 6, "b")
	eq(env.c, "3!", "c")
	eq(env.d, 3, "d")
	eq(env.r, 2, "r")
end)

case("operators inside strings and comments are untouched", function()
	local src = table.concat({
		'x = 1',
		's1 = "a += 1"',
		"s2 = 'b ..= \\'c\\' -= 2'",
		's3 = [[d *= 3]]',
		's4 = [==[e /= ]] 4]==]',
		'-- f += 5',
		'--[[ g ^= 6',
		'h %= 7 ]]',
		'--[=[ i += ]] 8 ]=]',
		'x += 1 -- y += 2',
		'eqs = (1 == 1) and (2 ~= 3) and (1 <= 2) and (3 >= 2)',
	}, "\n")
	local out = assert(CA.rewrite(src))
	eq(select(2, out:gsub(" = x %+ %( 1%)", "")), 1, "one rewrite")
	local _, env = run(src)
	eq(env.x, 2, "x")
	eq(env.s1, "a += 1", "s1")
	eq(env.s2, "b ..= 'c' -= 2", "s2")
	eq(env.s3, "d *= 3", "s3")
	eq(env.s4, "e /= ]] 4", "s4")
	eq(env.eqs, true, "comparison operators")
end)

case("number exponents: sign only after the base's exponent letter", function()
	-- In hex, `e` is a digit: `0xe--c` is 0xe followed by a comment.
	local src = "a = 1\na += 0xe--c\nb = 2\nx = 1 x += 1e-2\ny = 0 y += 0x1p-1\nz = 0 z += 0xE+1\n"
	local _, env = run(src)
	eq(env.a, 15, "a += 0xe")
	eq(env.b, 2, "b after the comment")
	eq(env.x, 1.01, "x += 1e-2")
	eq(env.y, 0.5, "y += 0x1p-1")
	eq(env.z, 15, "z += 0xE+1")
end)

case("\\z in short strings", function()
	local src = 's = "x"\ns ..= "a\\z\n      b" .. \'c\\z\n\'\nlocal t\nt.x = 1 -- line 6\n'
	local fn = assert(CA.loadstring(src, "=zesc"))
	local env = setmetatable({ }, { __index = _G })
	setfenv(fn, env)
	local ok, err = pcall(fn)
	eq(env.s, "xabc", "s")
	eq(ok, false, "runtime error raised")
	assert(tostring(err):find("^zesc:6:"), "expected an error on line 6, got " .. tostring(err))
end)

case("line numbers are preserved", function()
	local src = "local a = 0\na += 1\na += (1 +\n2)\nlocal t = { }\nt.x.y = 1 -- line 6\n"
	local fn = assert(CA.loadstring(src, "=lines"))
	local ok, err = pcall(fn)
	eq(ok, false, "runtime error raised")
	assert(tostring(err):find("^lines:6:"), "expected an error on line 6, got " .. tostring(err))
	-- A compile error after a rewritten line, in a file that still fails,
	-- keeps the original (line 2) error.
	local bad = "local a = 0\na += 1\nlocal = 3\n"
	local fn2, err2 = CA.loadstring(bad, "=bad")
	eq(fn2, nil, "still fails")
	assert(tostring(err2):find("^bad:2:"), "expected the original line 2 error, got " .. tostring(err2))
end)

case("fast path: valid source is returned unchanged", function()
	local src = "local x = 1\nx = x + 1\nreturn x\n"
	local _, why = CA.rewrite(src)
	eq(why, "no compound assignment", "rewrite reason")
	local fn = assert(CA.loadstring(src, "=valid"))
	eq(string.dump(fn), string.dump(assert(loadstring(src, "=valid"))), "bytecode")
end)

case("unsupported shapes surface the original error", function()
	for _, src in ipairs({
		"local a, b = 1, 2\na, b += 1\n",       -- multiple assignment
		"local x += 1\n",                        -- local declaration
		"local function f() end\nf() += 1\n",    -- lhs ends in a call
		"y = 1 + x += 1\n",                      -- not at statement level
		"x = 1\nx += 1, 2\n",                    -- expression list rhs
		"x = 0\nlocal f = 1\nx += f\n(t).n += 1\n", -- next line reads as a call: ambiguous
	}) do
		local fn, err = CA.loadstring(src, "=unsupported")
		local _, orig = loadstring(src, "=unsupported")
		eq(fn, nil, "compiled: " .. src)
		eq(err, orig, "error for " .. src)
	end
end)

case("loadfile, dofile and require fall back to the rewrite", function()
	local dir = scratchDir:gsub("\\", "/")
	local file = dir .. "/ca_mod.lua"
	local h = assert(io.open(file, "wb"))
	h:write("local n = 1\nn += 41\nreturn n\n")
	h:close()
	local okFile = dir .. "/ca_ok.lua"
	h = assert(io.open(okFile, "wb"))
	h:write("return 7\n")
	h:close()
	local savedPath = package.path
	CA.install()
	local ok, err = pcall(function()
		eq(assert(loadfile(file))(), 42, "loadfile")
		eq(dofile(file), 42, "dofile")
		eq(dofile(okFile), 7, "dofile fast path")
		package.path = dir .. "/?.lua;" .. savedPath
		package.loaded.ca_mod = nil
		eq(require("ca_mod"), 42, "require")
		local fn, lerr = loadfile(dir .. "/missing.lua")
		eq(fn, nil, "missing file")
		assert(tostring(lerr):find("missing"), "missing-file error: " .. tostring(lerr))
	end)
	package.path = savedPath
	os.remove(file)
	os.remove(okFile)
	if not ok then error(err, 0) end
end)

print(string.format("%d passed, %d failed", passed, failures))
os.exit(failures == 0 and 0 or 1)
