-- Compound assignment and safe navigation support for older LuaJIT.
--
-- Path of Building ships a LuaJIT v2.1 that has the syntax extensions
-- upstream backported from LuaJIT 3.0 (a2ce8114, 2026-07-20). PoB 2.68 uses
-- `x += 1`, `s ..= "a"` and friends; PoB 2.69 uses the safe-navigation
-- operator (`(name)?.:lower()`). Older LuaJIT rejects both. This module loads
-- a file exactly as `loadfile` does and, only when that fails, retries after
-- rewriting each `<recv>?.<chain>` into a nil-checked call (`M.rewriteNav`,
-- below) and then each compound assignment `<lhs> <op>= <rhs>` into
-- `<lhs> = <lhs> <op> (<rhs>)`. The other backported extensions (bit
-- operators, `!=` / `&&` / `||`, `?:`, `??`, `continue`, `const`, short
-- functions, `1_000`) are not rewritten: no PoB release uses them yet.
--
-- The compound rewrite is a small scanner, not a parser. It skips short strings
-- (including `\z` escapes), long brackets (`[[ ]]`, `[==[ ]==]`) and comments,
-- and never adds or removes a newline, so line numbers in errors stay right.
-- A file the rewrite does not fix reports its original error. Limitations:
--   * <lhs> starts at the beginning of its line, after `;`, `then`, `do`,
--     `else` or `repeat`, or right after a finished operand on the same line
--     (`a = 1 a += 1`, `f() x += 1`). A statement continued from the previous
--     line is not handled. A lhs that itself contains a newline (a block
--     comment inside it) is left alone, so line numbers never shift.
--   * <rhs> ends at the end of the line, a trailing comment, a `;`, an
--     `end`/`else`/`elseif`/`until` that closes the enclosing block, or a word
--     that starts the next statement on the same line. It keeps going past a
--     newline while a bracket or a block (`function ... end`) is open or the
--     line ends with an operator (`x += 1 +` / `2`). Compound assignments
--     inside it (in a function literal) are rewritten too.
--   * The lhs is evaluated twice (`t[f()] += 1` calls f twice).

local M = {}

local OPS = { ["+"] = true, ["-"] = true, ["*"] = true, ["/"] = true, ["%"] = true, ["^"] = true }
local STMT_START_WORDS = { ["then"] = true, ["do"] = true, ["else"] = true, ["repeat"] = true }
local BLOCK_OPEN = { ["function"] = true, ["if"] = true, ["do"] = true }
local BLOCK_END = { ["end"] = true, ["else"] = true, ["elseif"] = true, ["until"] = true }
local KEYWORDS = { }
for kw in ("and break do else elseif end false for function goto if in local nil not or repeat return then true until while"):gmatch("%a+") do
	KEYWORDS[kw] = true
end
-- Keywords that end an operand, like a name does.
local OPERAND_WORDS = { ["true"] = true, ["false"] = true, ["nil"] = true, ["end"] = true }
-- Keywords that continue an expression after an operand.
local BINARY_WORDS = { ["and"] = true, ["or"] = true }

-- If a string literal or comment starts at `i`, returns the index just past
-- it (for a line comment: the index of its newline, or #src + 1).
local function skipLiteral(src, i)
	local c = src:sub(i, i)
	if c == '"' or c == "'" then
		local j = i + 1
		while true do
			local ch = src:sub(j, j)
			if ch == "" then return j end -- unterminated: the parse error will say so
			if ch == "\\" then
				local nx, after = src:sub(j + 1, j + 1), src:sub(j + 2, j + 2)
				if nx == "z" then
					-- `\z` skips the following whitespace, newlines included
					j = j + 2
					while src:find("^%s", j) do j = j + 1 end
				elseif (nx == "\r" and after == "\n") or (nx == "\n" and after == "\r") then
					j = j + 3
				else
					j = j + 2
				end
			elseif ch == c then
				return j + 1
			elseif ch == "\n" then
				return j
			else
				j = j + 1
			end
		end
	end
	local isComment = src:sub(i, i + 1) == "--"
	local bracketAt = isComment and i + 2 or i
	local eqs = src:match("^%[(=*)%[", bracketAt)
	if eqs then
		local _, closeEnd = src:find("]" .. eqs .. "]", bracketAt + #eqs + 2, true)
		return (closeEnd or #src) + 1
	end
	if isComment then
		return src:find("\n", i, true) or (#src + 1)
	end
	return nil
end

-- If a number starts at `i`, returns the index just past it. Same rule as
-- LuaJIT's scanner: identifier bytes and dots, plus a sign right after the
-- exponent letter of the number's base (e/E decimal, p/P hex: `0xe-1` is 0xe
-- minus 1).
local function skipNumber(src, i)
	if not (src:find("^%d", i) or src:find("^%.%d", i)) then return nil end
	local exp = src:find("^0[xX]", i) and "[pP]" or "[eE]"
	local j, prev = i, ""
	while true do
		local ch = src:sub(j, j)
		if ch ~= "" and (ch:find("[%w_.]") or (ch:find("[+-]") and prev:find(exp))) then
			prev = ch
			j = j + 1
		else
			return j
		end
	end
end

-- Finds where the rhs of a compound assignment that starts at `i` ends
-- (exclusive, trailing whitespace excluded).
local function rhsEnd(src, i)
	local depth, blocks, last = 0, 0, i - 1
	-- operand: the last token ends an operand; pending: the rhs so far ends
	-- with an operator (or is empty), so it continues on the next line.
	local operand, pending = false, true
	local n = #src
	while i <= n do
		local skipTo = skipLiteral(src, i)
		local numberEnd = not skipTo and skipNumber(src, i)
		local c = src:sub(i, i)
		local top = depth <= 0 and blocks == 0
		if skipTo then
			if src:sub(i, i + 1) ~= "--" then
				last = skipTo - 1 -- a string belongs to the rhs
				operand, pending = true, false
			elseif top and not pending and not src:find("^%-%-%[=*%[", i) then
				return last + 1 -- a trailing line comment ends the rhs
			end
			-- Comments are skipped without extending the rhs, so a block
			-- comment after the rhs stays outside the parentheses while one in
			-- the middle (`x -= 1 --[[c]] - 2`) does not cut the rhs short.
			i = skipTo
		elseif numberEnd then
			if top and operand then return last + 1 end -- the next statement
			last = numberEnd - 1; operand, pending = true, false
			i = numberEnd
		elseif c == "\n" then
			if top and not pending then return last + 1 end
			i = i + 1
		elseif c == ";" and top then
			return last + 1
		elseif c:find("[%(%[{]") then
			depth = depth + 1; last = i; i = i + 1
			operand, pending = false, false
		elseif c:find("[%)%]}]") then
			depth = depth - 1; last = i; i = i + 1
			operand, pending = true, false
		elseif c:find("[%a_]") then
			local word = src:match("^[%w_]+", i)
			if top and (BLOCK_END[word] or (operand and not BINARY_WORDS[word])) then
				-- closes the enclosing block, or starts the next statement
				return last + 1
			end
			if BLOCK_OPEN[word] then
				blocks = blocks + 1
			elseif word == "end" then
				blocks = blocks - 1
			end
			i = i + #word; last = i - 1
			operand = not KEYWORDS[word] or OPERAND_WORDS[word] == true
			pending = BINARY_WORDS[word] == true or word == "not"
		else
			if not c:find("%s") then
				last = i
				operand, pending = false, true
			end
			i = i + 1
		end
	end
	return last + 1
end

--- Rewrites compound assignments in Lua source. Returns the new source and
--- the number of assignments rewritten.
function M.rewriteCompound(src)
	local out, outN, pos, count = {}, 0, 1, 0
	-- operand: the last token ends an operand, so a name after it starts a
	-- new statement (`a = 1 a += 1`).
	local i, stmt, n, operand = 1, 1, #src, false
	while i <= n do
		local skipTo = skipLiteral(src, i)
		local numberEnd = not skipTo and skipNumber(src, i)
		local c = src:sub(i, i)
		if skipTo then
			if src:sub(i, i + 1) == "--" then
				-- a comment before the lhs is not part of it (it may span lines)
				if not src:sub(stmt, i - 1):find("%S") then stmt = skipTo end
			else
				operand = true
			end
			i = skipTo
		elseif numberEnd then
			i = numberEnd; operand = true
		elseif c == "\n" or c == ";" then
			i = i + 1; stmt = i; operand = false
		elseif c:find("[%a_]") then
			local word = src:match("^[%w_]+", i)
			if operand and not KEYWORDS[word] then stmt = i end
			i = i + #word
			if STMT_START_WORDS[word] then stmt = i end
			operand = not KEYWORDS[word] or OPERAND_WORDS[word] == true
		else
			local op = (src:sub(i, i + 2) == "..=" and "..")
				or (OPS[c] and src:sub(i + 1, i + 1) == "=" and src:sub(i + 2, i + 2) ~= "=" and c)
				or nil
			local lhs = op and src:sub(stmt, i - 1):match("^%s*(.-)%s*$")
			-- a lhs spanning lines would add a newline to the output
			if op and lhs ~= "" and not lhs:find("\n", 1, true) then
				local rhsStart = i + #op + 1
				local stop = rhsEnd(src, rhsStart)
				-- compound assignments inside the rhs (in a function literal)
				local rhs, inner = M.rewriteCompound(src:sub(rhsStart, stop - 1))
				outN = outN + 1
				out[outN] = src:sub(pos, i - 1) .. "= " .. lhs .. " " .. op .. " ("
					.. rhs:match("^%s*(.-)$") .. ")"
				pos = stop
				i = stop
				count = count + 1 + inner
				stmt, operand = stop, true
			else
				i = i + (op and #op + 1 or 1)
				if not c:find("%s") then operand = c:find("[%)%]}]") ~= nil end
			end
		end
	end
	if count == 0 then return src, 0 end
	out[outN + 1] = src:sub(pos)
	return table.concat(out), count
end

-- Safe navigation (`?.`). Tokens of `src`: { t = kind, s = start, e = end
-- (inclusive) }, kinds "name", "kw", "str", "num" and punctuation by its text
-- ("?." for the operator). Comments are left out. `match[i]` pairs brackets.
local MULTI_CHAR_OPS = { ["..."] = true, [".."] = true, ["=="] = true, ["~="] = true, ["<="] = true, [">="] = true, ["::"] = true }
local function tokenize(src)
	local toks, match, stack, i, n = {}, {}, {}, 1, #src
	local function add(t, s, e) toks[#toks + 1] = { t = t, s = s, e = e } end
	while i <= n do
		local c = src:sub(i, i)
		local skipTo = skipLiteral(src, i)
		if skipTo then
			if src:sub(i, i + 1) ~= "--" then add("str", i, skipTo - 1) end
			i = skipTo
		elseif src:sub(i, i + 1) == "?." then
			add("?.", i, i + 1); i = i + 2
		else
			local numberEnd = skipNumber(src, i)
			if numberEnd then
				add("num", i, numberEnd - 1); i = numberEnd
			elseif c:find("[%a_]") then
				local word = src:match("^[%w_]+", i)
				add(KEYWORDS[word] and word ~= "goto" and "kw" or "name", i, i + #word - 1)
				i = i + #word
			elseif c:find("%s") then
				i = i + 1
			else
				local op = src:sub(i, i + 2) == "..." and "..." or src:sub(i, i + 1)
				if not MULTI_CHAR_OPS[op] then op = c end
				add(op, i, i + #op - 1)
				if op == "(" or op == "[" or op == "{" then
					stack[#stack + 1] = #toks
				elseif op == ")" or op == "]" or op == "}" then
					local o = table.remove(stack)
					if o then match[o], match[#toks] = #toks, o end
				end
				i = i + #op
			end
		end
	end
	return toks, match
end

local CLOSE = { [")"] = true, ["]"] = true, ["}"] = true }
local function endsPrimary(tok)
	return tok ~= nil and (tok.t == "name" or tok.t == "str" or CLOSE[tok.t] == true)
end

-- Call arguments starting at token j: the index just past them, or nil.
local function skipArgs(toks, match, j)
	local t = toks[j] and toks[j].t
	if t == "str" then return j + 1 end
	if (t == "(" or t == "{") and match[j] then return match[j] + 1 end
	return nil
end

-- The receiver of the `?.` at token k: the index of its first token, or nil
-- when it is not a prefix expression this rewrite handles.
local function receiverStart(toks, match, k)
	local j = k - 1
	while j >= 1 do
		local t = toks[j].t
		if t == "]" then
			if not match[j] or not endsPrimary(toks[match[j] - 1]) then return nil end
			j = match[j] - 1
		elseif t == ")" or t == "}" then
			local o = match[j]
			if not o then return nil end
			if endsPrimary(toks[o - 1]) then
				j = o - 1 -- call arguments
			elseif t == ")" then
				return o -- a parenthesized expression
			else
				return nil -- a table constructor is not a prefix expression
			end
		elseif t == "str" then
			if not endsPrimary(toks[j - 1]) then return nil end
			j = j - 1 -- string call argument
		elseif t == "name" then
			local before = toks[j - 1] and toks[j - 1].t
			if before == ":" and j == k - 1 then
				return nil -- `a:m?.(x)` nil-checks a method: not handled
			elseif before == "." or before == ":" then -- a field or a method call
				j = j - 2
			else
				return j
			end
			if not endsPrimary(toks[j]) then return nil end
		else
			return nil
		end
	end
	return nil
end

-- The last token of the suffix chain that the `?.` at token k short-circuits
-- (later `?.` included), or nil when the chain is malformed.
local function chainEnd(toks, match, k)
	-- first: right after a `?.`, where a bare name is a field
	local j, first = k + 1, true
	while true do
		local t = toks[j] and toks[j].t
		if t == "?." and not first then
			j, first = j + 1, true
		else
			if first and t == "name" then
				j = j + 1
			elseif t == "." and not first and toks[j + 1] and toks[j + 1].t == "name" then
				j = j + 2
			elseif t == "[" and match[j] then
				j = match[j] + 1
			elseif t == ":" and toks[j + 1] and toks[j + 1].t == "name" then
				j = skipArgs(toks, match, j + 2)
			elseif t == "str" or t == "(" or t == "{" then
				j = skipArgs(toks, match, j)
			elseif first then
				return nil
			else
				return j - 1
			end
			if not j then return nil end
			first = false
		end
	end
end

local NAV_HELPER = "__pobmcp_nav"
local NAV_RECEIVER = "__pobmcp_r"

--- Rewrites LuaJIT's safe-navigation operator `?.` (upstream LuaJIT v2.1
--- since a2ce8114, "v3.0 syntax backport") into plain Lua: `<recv>?.<chain>`
--- becomes `__pobmcp_nav(<recv>, function(__pobmcp_r) return __pobmcp_r<chain> end)`,
--- with `<chain>` the rest of the suffix chain (`.f`, `[k]`, `:m(...)`, call
--- arguments, later `?.` too). The receiver is evaluated once and the chain
--- only when it is not nil; a nil receiver gives nil. The result is one
--- value, as upstream gives in argument lists, returns and table constructors
--- (only a multiple assignment from `f?.()` sees more values there). The
--- helper is a local added at the start of the first line. Returns the new
--- source and the number of `?.` rewritten. Left alone (the file keeps its parse error):
--- `a:m?.(x)`, a `...` in the chain, and a chain assigned to.
function M.rewriteNav(src)
	-- No `?.` anywhere (2.68 files with only `+=`): skip the tokenizer.
	if not src:find("?.", 1, true) then return src, 0 end
	local count, skip = 0, 0
	while true do
		local toks, match = tokenize(src)
		local k, seen = nil, 0
		for idx, tok in ipairs(toks) do
			if tok.t == "?." then
				seen = seen + 1
				if seen > skip then k = idx; break end
			end
		end
		if not k then break end
		local b = receiverStart(toks, match, k)
		-- a receiver right after a `?.` left alone is part of that chain
		if b and toks[b - 1] and toks[b - 1].t == "?." then b = nil end
		local z = b and chainEnd(toks, match, k)
		local ok = z ~= nil and not (toks[z + 1] and toks[z + 1].t == "=")
		for idx = k + 1, ok and z or 0 do
			if toks[idx].t == "..." then ok = false end
		end
		if ok then
			-- Both keep their whitespace and comments, so no newline is lost.
			local recv = src:sub(toks[b].s, toks[k].s - 1)
			local suffix = src:sub(toks[k].e + 1, toks[z].e)
			if toks[k + 1].t == "name" then -- `?.f` reads field f
				suffix = src:sub(toks[k].e + 1, toks[k + 1].s - 1) .. "." .. src:sub(toks[k + 1].s, toks[z].e)
			end
			src = src:sub(1, toks[b].s - 1) .. NAV_HELPER .. "(" .. recv .. ", function(" .. NAV_RECEIVER
				.. ") return " .. NAV_RECEIVER .. suffix .. " end)" .. src:sub(toks[z].e + 1)
			count = count + 1
		else
			skip = skip + 1
		end
	end
	if count == 0 then return src, 0 end
	return "local " .. NAV_HELPER .. " = function(r, f) if r == nil then return nil end return (f(r)) end " .. src, count
end

--- Rewrites every syntax extension this module handles (safe navigation,
--- then compound assignments). Returns the new source and the number of
--- constructs rewritten.
function M.rewrite(src)
	local navSrc, navCount = M.rewriteNav(src)
	local out, count = M.rewriteCompound(navSrc)
	return out, navCount + count
end

--- Drop-in for `loadfile(path)`: same results for any file that parses
--- untouched; otherwise retries with `M.rewrite` (safe navigation and
--- compound assignments rewritten), keeping
--- the chunk name `@path` and, if the retry also fails, the original error.
function M.loadfile(path)
	local func, err = loadfile(path)
	if func then return func end
	local f = io.open(path, "rb")
	if not f then return nil, err end
	local src = f:read("*a")
	f:close()
	if src:sub(1, 3) == "\239\187\191" then src = src:sub(4) end
	if src:sub(1, 1) == "#" then src = "--" .. src end
	local rewritten, count = M.rewrite(src)
	if count == 0 then return nil, err end
	local func2 = loadstring(rewritten, "@" .. path)
	if func2 then return func2 end
	return nil, err
end

--- A `package.loaders` entry equivalent to the stock Lua searcher (it searches
--- `package.path`) but loading through `M.loadfile`. PoB `require`s its
--- `Classes.*` modules, so `loadfile` alone does not cover them.
function M.searcher(name)
	local rel = name:gsub("%.", "/")
	local tried = {}
	for template in package.path:gmatch("[^;]+") do
		local path = template:gsub("%?", (rel:gsub("%%", "%%%%")))
		local f = io.open(path, "rb")
		if f then
			f:close()
			local func, err = M.loadfile(path)
			if not func then
				error("error loading module '" .. name .. "' from file '" .. path .. "':\n\t" .. err, 0)
			end
			return func
		end
		tried[#tried + 1] = "\n\tno file '" .. path .. "'"
	end
	return table.concat(tried)
end

return M
