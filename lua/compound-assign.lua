-- Compound assignment support for plain LuaJIT.
--
-- Path of Building 2.68+ is written for PoB's patched LuaJIT and uses
-- `x += 1`, `s ..= "a"` and friends, which stock LuaJIT rejects with
-- `'=' expected near '+'`. This module loads a file exactly as `loadfile`
-- does and, only when that fails, retries after rewriting each compound
-- assignment `<lhs> <op>= <rhs>` into `<lhs> = <lhs> <op> (<rhs>)`.
--
-- The rewrite is a small scanner, not a parser. It skips short strings, long
-- brackets (`[[ ]]`, `[==[ ]==]`) and comments, and never adds or removes a
-- newline, so line numbers in errors stay right. Limitations:
--   * <lhs> starts at the beginning of its line, or after `;`, `then`, `do`,
--     `else` or `repeat` on the same line. A statement continued from the
--     previous line, or following `)`/`end` on the same line, is not handled.
--   * <rhs> ends at the end of the line, a trailing comment, a `;`, or an
--     `end`/`else`/`elseif`/`until` that closes the enclosing block. It keeps
--     going past a newline only while a bracket is still open, so a rhs that
--     continues on the next line after a trailing operator is not handled.
--   * The lhs is evaluated twice (`t[f()] += 1` calls f twice).

local M = {}

local OPS = { ["+"] = true, ["-"] = true, ["*"] = true, ["/"] = true, ["%"] = true, ["^"] = true }
local STMT_START_WORDS = { ["then"] = true, ["do"] = true, ["else"] = true, ["repeat"] = true }
local BLOCK_OPEN = { ["function"] = true, ["if"] = true, ["do"] = true }
local BLOCK_END = { ["end"] = true, ["else"] = true, ["elseif"] = true, ["until"] = true }

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
				j = j + 2
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

-- Finds where the rhs of a compound assignment that starts at `i` ends
-- (exclusive, trailing whitespace excluded).
local function rhsEnd(src, i)
	local depth, blocks, last = 0, 0, i - 1
	local n = #src
	while i <= n do
		local skipTo = skipLiteral(src, i)
		local c = src:sub(i, i)
		if skipTo then
			if src:sub(i, i + 1) == "--" and depth == 0 and blocks == 0 then
				return last + 1
			end
			-- a string, or a comment inside brackets/function body
			if src:sub(i, i + 1) ~= "--" then last = skipTo - 1 end
			i = skipTo
		elseif c == "\n" then
			if depth <= 0 and blocks == 0 then return last + 1 end
			i = i + 1
		elseif c == ";" and depth <= 0 and blocks == 0 then
			return last + 1
		elseif c:find("[%(%[{]") then
			depth = depth + 1; last = i; i = i + 1
		elseif c:find("[%)%]}]") then
			depth = depth - 1; last = i; i = i + 1
		elseif c:find("[%w_]") then
			local word = src:match("^[%w_]+", i)
			if BLOCK_END[word] and blocks == 0 and depth <= 0 then
				return last + 1
			end
			if BLOCK_OPEN[word] then
				blocks = blocks + 1
			elseif word == "end" then
				blocks = blocks - 1
			end
			i = i + #word; last = i - 1
		else
			if not c:find("%s") then last = i end
			i = i + 1
		end
	end
	return last + 1
end

--- Rewrites compound assignments in Lua source. Returns the new source and
--- the number of assignments rewritten.
function M.rewrite(src)
	local out, outN, pos, count = {}, 0, 1, 0
	local i, stmt, n = 1, 1, #src
	while i <= n do
		local skipTo = skipLiteral(src, i)
		local c = src:sub(i, i)
		if skipTo then
			i = skipTo
		elseif c == "\n" or c == ";" then
			i = i + 1; stmt = i
		elseif c:find("[%a_]") then
			local word = src:match("^[%w_]+", i)
			i = i + #word
			if STMT_START_WORDS[word] then stmt = i end
		else
			local op = (src:sub(i, i + 2) == "..=" and "..")
				or (OPS[c] and src:sub(i + 1, i + 1) == "=" and src:sub(i + 2, i + 2) ~= "=" and c)
				or nil
			local lhs = op and src:sub(stmt, i - 1):match("^%s*(.-)%s*$")
			if op and lhs ~= "" then
				local rhsStart = i + #op + 1
				local stop = rhsEnd(src, rhsStart)
				outN = outN + 1
				out[outN] = src:sub(pos, i - 1) .. "= " .. lhs .. " " .. op .. " ("
					.. src:sub(rhsStart, stop - 1):match("^%s*(.-)$") .. ")"
				pos = stop
				i = stop
				count = count + 1
			else
				i = i + (op and #op + 1 or 1)
			end
		end
	end
	if count == 0 then return src, 0 end
	out[outN + 1] = src:sub(pos)
	return table.concat(out), count
end

--- Drop-in for `loadfile(path)`: same results for any file that parses
--- untouched; otherwise retries with compound assignments rewritten, keeping
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
