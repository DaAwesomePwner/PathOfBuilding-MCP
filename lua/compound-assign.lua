-- Compound assignment compatibility for stock LuaJIT.
--
-- Path of Building 2.68+ sources use compound assignment (`count += 1`,
-- `url ..= "/" .. x`), which PoB's own patched LuaJIT accepts as
-- `lhs = lhs op (rhs)`. Stock LuaJIT cannot parse it. This module rewrites
-- such statements into plain Lua, only for chunks stock LuaJIT rejects:
--
--   * Fast path: the original source is compiled first; a chunk that compiles
--     is used exactly as before (no rewrite, no extra read).
--   * The rewrite never adds or removes a newline, so chunk names and line
--     numbers in later errors and tracebacks stay those of the original file.
--   * When the source has no compound assignment, uses a shape this rewriter
--     does not support, or still fails to compile after the rewrite, the
--     ORIGINAL compile error is reported.
--
-- Supported: `lhs op= rhs` with op one of + - * / % ^ .., at statement level,
-- where lhs is a name, field or index chain (`a`, `a.b`, `a[i].c`, `f(x).y`)
-- that starts a statement. rhs runs to the end of the expression and may span
-- lines and contain function literals.
-- Not supported (the original error is reported): multiple assignment
-- (`a, b += 1`), `local x += 1`, an lhs ending in a call, an lhs written
-- across a string token that contains a newline, and an lhs that starts with
-- a string or table-constructor call (`f"x".y += 1`).
-- Semantics: the lhs is evaluated twice, as in `lhs = lhs op (rhs)`, so a
-- call inside an index (`t[f()] += 1`) runs twice.
--
-- Loaded by bridge.lua by path (not require): bridge.lua points package.path
-- at the PoB install.

local M = { }

local s_byte, s_sub, s_find, s_match = string.byte, string.sub, string.find, string.match
local t_concat = table.concat
local raw_loadstring, raw_loadfile, raw_dofile, raw_setfenv = loadstring, loadfile, dofile, setfenv
local raw_io_open = io.open
local raw_error, raw_pcall, raw_type = error, pcall, type

local COMPOUND = { ["+="] = "+", ["-="] = "-", ["*="] = "*", ["/="] = "/", ["%="] = "%", ["^="] = "^", ["..="] = ".." }

local KEYWORDS = { }
for kw in ([[and break do else elseif end false for function goto if in local nil not or repeat return then true until while]]):gmatch("%a+") do
	KEYWORDS[kw] = true
end

-- Keywords that cannot continue an expression: at depth 0 they end the rhs.
local RHS_STOP = { }
for kw in ([[end else elseif local return if for while repeat until do then break goto]]):gmatch("%a+") do
	RHS_STOP[kw] = true
end

-- Tokens that can begin a statement right after a finished operand. After an
-- operand-ending token one of these (with no binary operator between) starts
-- the next statement.
local OPERAND_START_KW = { ["function"] = true, ["true"] = true, ["false"] = true, ["nil"] = true, ["not"] = true }

-- ---------------------------------------------------------------------------
-- Lexer. Produces { kind, s, e, text } records with byte offsets into src.
-- kind: "name", "kw", "num", "str", "op", "compound". Comments and whitespace
-- are skipped. Returns nil, reason when the source cannot be tokenised.
-- ---------------------------------------------------------------------------
local function isIdentByte(b)
	return b and ((b >= 48 and b <= 57) or (b >= 65 and b <= 90) or (b >= 97 and b <= 122) or b == 95 or b >= 128)
end
local function isIdentStart(b)
	return b and ((b >= 65 and b <= 90) or (b >= 97 and b <= 122) or b == 95 or b >= 128)
end
local function isDigit(b)
	return b and b >= 48 and b <= 57
end

-- At src[i] == "[": returns the level of a long bracket `[==[` or nil.
local function longBracketLevel(src, i)
	local eqs = s_match(src, "^%[(=*)%[", i)
	if eqs then return #eqs end
	return nil
end

-- Returns the index just past the long bracket closing `]==]` of `level`
-- whose opening ends at `openEnd`, or nil when unterminated.
local function skipLongBracket(src, openEnd, level)
	local close = "]" .. string.rep("=", level) .. "]"
	local _, e = s_find(src, close, openEnd + 1, true)
	return e and e + 1 or nil
end

local OPS3 = { ["..."] = true, ["..="] = true }
local OPS2 = { ["=="] = true, ["~="] = true, ["<="] = true, [">="] = true, [".."] = true, ["::"] = true,
	["+="] = true, ["-="] = true, ["*="] = true, ["/="] = true, ["%="] = true, ["^="] = true }

local function tokenize(src)
	local toks = { }
	local n = #src
	local i = 1
	-- UTF-8 BOM and a first line starting with "#" are skipped, as LuaJIT does.
	if s_sub(src, 1, 3) == "\239\187\191" then i = 4 end
	if s_sub(src, i, i) == "#" then
		local nl = s_find(src, "\n", i, true)
		i = nl or n + 1
	end
	while i <= n do
		local b = s_byte(src, i)
		if b == 32 or b == 9 or b == 10 or b == 13 or b == 11 or b == 12 then
			i = i + 1
		elseif b == 45 and s_byte(src, i + 1) == 45 then -- "--" comment
			local level = s_byte(src, i + 2) == 91 and longBracketLevel(src, i + 2)
			if level then
				local _, openEnd = s_find(src, "^%[=*%[", i + 2)
				local after = skipLongBracket(src, openEnd, level)
				if not after then return nil, "unterminated long comment" end
				i = after
			else
				local nl = s_find(src, "\n", i, true)
				i = nl or n + 1
			end
		elseif isIdentStart(b) then
			local j = i + 1
			while isIdentByte(s_byte(src, j)) do j = j + 1 end
			local text = s_sub(src, i, j - 1)
			toks[#toks + 1] = { kind = KEYWORDS[text] and "kw" or "name", s = i, e = j - 1, text = text }
			i = j
		elseif isDigit(b) or (b == 46 and isDigit(s_byte(src, i + 1))) then
			-- Same rule as LuaJIT's number scanner: identifier bytes and dots,
			-- plus a sign right after the exponent letter of the number's base
			-- (e/E for decimal, p/P for hex: `0xe-1` is 0xe minus 1).
			local j = i
			local prev
			local isHex = b == 48 and (s_byte(src, i + 1) == 120 or s_byte(src, i + 1) == 88)
			local expLower = isHex and 112 or 101 -- "p" or "e"
			while true do
				local c = s_byte(src, j)
				if isIdentByte(c) or c == 46 or ((c == 43 or c == 45) and prev and (prev == expLower or prev == expLower - 32)) then
					prev = c
					j = j + 1
				else
					break
				end
			end
			toks[#toks + 1] = { kind = "num", s = i, e = j - 1, text = s_sub(src, i, j - 1) }
			i = j
		elseif b == 34 or b == 39 then -- short string
			local j = i + 1
			while true do
				local c = s_byte(src, j)
				if not c or c == 10 or c == 13 then return nil, "unterminated string" end
				if c == b then break end
				if c == 92 then
					local d = s_byte(src, j + 1)
					if d == 13 and s_byte(src, j + 2) == 10 or d == 10 and s_byte(src, j + 2) == 13 then
						j = j + 3
					elseif d == 122 then -- "\z" skips the following whitespace, newlines included
						j = j + 2
						while true do
							local w = s_byte(src, j)
							if w == 32 or w == 9 or w == 10 or w == 13 or w == 11 or w == 12 then
								j = j + 1
							else
								break
							end
						end
					else
						j = j + 2
					end
				else
					j = j + 1
				end
			end
			toks[#toks + 1] = { kind = "str", s = i, e = j, text = s_sub(src, i, j) }
			i = j + 1
		elseif b == 91 and longBracketLevel(src, i) then -- long string
			local level = longBracketLevel(src, i)
			local _, openEnd = s_find(src, "^%[=*%[", i)
			local after = skipLongBracket(src, openEnd, level)
			if not after then return nil, "unterminated long string" end
			toks[#toks + 1] = { kind = "str", s = i, e = after - 1, text = s_sub(src, i, after - 1) }
			i = after
		else
			local three, two = s_sub(src, i, i + 2), s_sub(src, i, i + 1)
			local text
			if OPS3[three] then
				text = three
			elseif OPS2[two] then
				text = two
			else
				text = s_sub(src, i, i)
			end
			toks[#toks + 1] = { kind = COMPOUND[text] and "compound" or "op", s = i, e = i + #text - 1, text = text }
			i = i + #text
		end
	end
	return toks
end

-- ---------------------------------------------------------------------------
-- Statement shape analysis on the token list.
-- ---------------------------------------------------------------------------
local function isOp(tok, text)
	return tok ~= nil and tok.kind == "op" and tok.text == text
end

-- A token that can end an operand (the last token of an expression).
local function endsOperand(tok)
	if not tok then return false end
	local k = tok.kind
	if k == "name" or k == "num" or k == "str" then return true end
	if k == "kw" then
		return tok.text == "true" or tok.text == "false" or tok.text == "nil" or tok.text == "end"
	end
	return tok.text == ")" or tok.text == "]" or tok.text == "}" or tok.text == "..."
end

-- A token that starts a new operand and cannot continue the previous one.
local function startsNewOperand(tok)
	if not tok then return false end
	local k = tok.kind
	if k == "name" or k == "num" then return true end
	if k == "kw" then return OPERAND_START_KW[tok.text] == true end
	return tok.text == "..." or tok.text == "#" or tok.text == "::"
end

-- Tokens after which a new statement may begin.
local STMT_BOUNDARY_KW = { ["do"] = true, ["then"] = true, ["else"] = true, ["end"] = true, ["repeat"] = true, ["break"] = true }
local function precedesStatement(tok)
	if tok == nil then return true end
	if tok.kind == "kw" then
		if STMT_BOUNDARY_KW[tok.text] then return true end
	elseif tok.text == ";" or tok.text == "::" then
		return true
	end
	-- The previous statement ended with an operand (`x = y  z += 1`, `f()  z += 1`).
	return endsOperand(tok)
end

-- Index of the bracket opening the one closing at `i`, or nil.
local MATCH_OPEN = { [")"] = "(", ["]"] = "[", ["}"] = "{" }
local function matchBackward(toks, i)
	local close = toks[i].text
	local open = MATCH_OPEN[close]
	local depth = 0
	for j = i, 1, -1 do
		local t = toks[j]
		if t.kind == "op" then
			if t.text == close then
				depth = depth + 1
			elseif t.text == open then
				depth = depth - 1
				if depth == 0 then return j end
			end
		end
	end
	return nil
end

-- First token index of the assignable expression ending just before the
-- compound operator at `k`, or nil when the shape is unsupported.
local function findLhsStart(toks, k)
	local i = k - 1
	local t = toks[i]
	if not t or not (t.kind == "name" or isOp(t, "]")) then return nil end
	while true do
		t = toks[i]
		if not t then return nil end
		if t.kind == "name" then
			local p = toks[i - 1]
			if isOp(p, ".") or isOp(p, ":") then
				i = i - 2
			else
				return i
			end
		elseif isOp(t, "]") or isOp(t, ")") then
			local j = matchBackward(toks, i)
			if not j then return nil end
			local p = toks[j - 1]
			if t.text == ")" and not (p and (p.kind == "name" or isOp(p, "]") or isOp(p, ")"))) then
				return j -- parenthesised prefix expression: `(a).b += 1`
			end
			if t.text == "]" and not (p and (p.kind == "name" or isOp(p, "]") or isOp(p, ")"))) then
				return nil
			end
			i = j - 1
		else
			return nil
		end
	end
end

-- Last token index of the expression starting at `k + 1`, or nil.
local function findRhsEnd(toks, k)
	local i = k + 1
	if not toks[i] then return nil end
	local depth, blocks = 0, 0
	local last = nil
	while true do
		local t = toks[i]
		if not t then break end
		if depth == 0 and blocks == 0 then
			if isOp(t, ";") or isOp(t, "::") then break end
			-- Another compound operator means the next statement's lhs was
			-- taken into this rhs (`x += f` then a line `(t).n += 1`, which
			-- Lua reads as a call): ambiguous, refuse.
			if t.kind == "compound" then return nil end
			if t.kind == "kw" and RHS_STOP[t.text] then break end
			if last and endsOperand(toks[last]) and startsNewOperand(t) then break end
			-- `=` or `,` at the top level cannot belong to an rhs expression.
			if isOp(t, "=") or isOp(t, ",") then return nil end
		end
		if t.kind == "op" then
			local x = t.text
			if x == "(" or x == "[" or x == "{" then
				depth = depth + 1
			elseif x == ")" or x == "]" or x == "}" then
				if depth == 0 then break end
				depth = depth - 1
			end
		elseif t.kind == "kw" then
			local x = t.text
			if x == "function" or x == "if" or x == "do" or x == "repeat" then
				blocks = blocks + 1
			elseif x == "end" or x == "until" then
				if blocks == 0 then break end
				blocks = blocks - 1
			end
		end
		last = i
		i = i + 1
	end
	if depth ~= 0 or blocks ~= 0 or not last then return nil end
	return last
end

-- Rewrites every compound assignment in `src`. Returns the new source, or
-- nil plus a reason when there is none or one has an unsupported shape. The
-- result has exactly the same newlines as `src`.
function M.rewrite(src)
	if raw_type(src) ~= "string" then return nil, "not a string" end
	if s_byte(src, 1) == 27 then return nil, "bytecode" end
	local toks, lexErr = tokenize(src)
	if not toks then return nil, lexErr end
	local edits = { } -- { pos, kind = "replace"|"insert", e?, text }
	for k, tok in ipairs(toks) do
		if tok.kind == "compound" then
			local ls = findLhsStart(toks, k)
			if not ls then return nil, "unsupported left-hand side at byte " .. tok.s end
			if not precedesStatement(toks[ls - 1]) then
				return nil, "compound assignment not at statement level at byte " .. tok.s
			end
			local re = findRhsEnd(toks, k)
			if not re then return nil, "unsupported right-hand side at byte " .. tok.s end
			local parts = { }
			for j = ls, k - 1 do
				local text = toks[j].text
				if s_find(text, "[\r\n]") then return nil, "multi-line string in left-hand side at byte " .. tok.s end
				parts[#parts + 1] = text
			end
			edits[#edits + 1] = { pos = tok.s, e = tok.e, text = "= " .. t_concat(parts, " ") .. " " .. COMPOUND[tok.text] .. " (" }
			edits[#edits + 1] = { pos = toks[re].e + 1, text = ")" }
		end
	end
	if #edits == 0 then return nil, "no compound assignment" end
	table.sort(edits, function(a, b)
		if a.pos ~= b.pos then return a.pos < b.pos end
		return (a.e and 1 or 0) < (b.e and 1 or 0) -- an insertion before a replacement at the same byte
	end)
	local out, cursor = { }, 1
	for _, ed in ipairs(edits) do
		out[#out + 1] = s_sub(src, cursor, ed.pos - 1)
		out[#out + 1] = ed.text
		cursor = ed.e and ed.e + 1 or ed.pos
	end
	out[#out + 1] = s_sub(src, cursor)
	return t_concat(out)
end

-- Compiles `src` like loadstring. Only when stock LuaJIT rejects it is the
-- rewritten source tried; if that fails too, the original error is returned.
function M.loadstring(src, chunkname)
	local fn, err = raw_loadstring(src, chunkname)
	if fn then return fn end
	local rewritten = M.rewrite(src)
	if rewritten then
		local fn2 = raw_loadstring(rewritten, chunkname)
		if fn2 then return fn2 end
	end
	return nil, err
end

-- Reads a file and compiles its rewritten source with LuaJIT's chunk name
-- for files ("@" .. path). nil when unreadable, unchanged or still invalid.
local function loadRewrittenFile(path)
	local f = raw_io_open(path, "rb")
	if not f then return nil end
	local src = f:read("*a")
	f:close()
	if not src then return nil end
	local rewritten = M.rewrite(src)
	if not rewritten then return nil end
	return (raw_loadstring(rewritten, "@" .. path))
end

-- loadfile with the fallback. Takes LuaJIT's optional mode and env.
function M.loadfile(path, mode, env)
	local fn, err = raw_loadfile(path, mode, env)
	if fn or raw_type(path) ~= "string" then return fn, err end
	if mode ~= nil and not s_find(tostring(mode), "t", 1, true) then return fn, err end
	local fn2 = loadRewrittenFile(path)
	if not fn2 then return nil, err end
	if raw_type(env) == "table" then raw_setfenv(fn2, env) end -- as LuaJIT's loadfile
	return fn2
end

function M.dofile(path)
	if path == nil then return raw_dofile() end
	local fn, err = M.loadfile(path)
	if not fn then raw_error(err, 0) end
	return fn()
end

-- Wraps a package.loaders Lua-file searcher: the original runs first, and
-- only a module it fails to compile is retried with the rewrite.
function M.wrapSearcher(searcher)
	return function(name)
		local ok, res = raw_pcall(searcher, name)
		if ok then return res end
		local path = package.searchpath and package.searchpath(name, package.path)
		local fn = path and loadRewrittenFile(path)
		if fn then return fn end
		raw_error(res, 0)
	end
end

-- Replaces the global loadfile and dofile and the Lua-file searcher in
-- package.loaders. Anything that calls the global loadfile at run time (the
-- bridge's LoadModule/PLoadModule) gets the fallback through it. Idempotent.
function M.install()
	if M.installed then return end
	M.installed = true
	loadfile = M.loadfile
	dofile = M.dofile
	local loaders = package.loaders or package.searchers
	if loaders and raw_type(loaders[2]) == "function" then
		loaders[2] = M.wrapSearcher(loaders[2])
	end
end

return M
