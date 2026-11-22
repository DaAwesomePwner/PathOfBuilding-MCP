-- Compound assignment support for plain LuaJIT.
--
-- Path of Building 2.68+ is written for PoB's patched LuaJIT and uses
-- `x += 1`, `s ..= "a"` and friends, which stock LuaJIT rejects with
-- `'=' expected near '+'`. This module loads a file exactly as `loadfile`
-- does and, only when that fails, retries after rewriting each compound
-- assignment `<lhs> <op>= <rhs>` into `<lhs> = <lhs> <op> (<rhs>)`.
--
-- The rewrite is a small scanner, not a parser. It skips short strings
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
function M.rewrite(src)
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
				local rhs, inner = M.rewrite(src:sub(rhsStart, stop - 1))
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
