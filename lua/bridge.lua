-- JSON-lines bridge entrypoint for PoB's headless Lua engine.

io.stdout:setvbuf("line")
io.stderr:setvbuf("line")

local POB_PATH = arg[1] or "."

-- Detect install layout. A compiled Windows installer puts Launch.lua and
-- Modules/ etc. directly under POB_PATH and ships its Lua libs in <pob>/lua/
-- and native libs at the root. A source clone (cloned upstream PoB repo) puts
-- Lua sources under src/ and its libs under runtime/lua/, runtime/?.dll. We
-- look for Launch.lua to decide which one we have.
local function fileExists(p)
	local f = io.open(p, "r")
	if f then f:close() return true end
	return false
end

-- The rule mirrors `detectLayout` in src/pob-install.ts, which also picks the
-- working directory LuaJIT is spawned in, so the two cannot disagree: installed
-- only when Launch.lua and Modules/Build.lua are both at the root; otherwise a
-- source clone when both are under src/. Any other shape keeps the older
-- behaviour (flat when the root has Launch.lua, else src/).
local function hasPoBFiles(base)
	return fileExists(base .. "/Launch.lua") and fileExists(base .. "/Modules/Build.lua")
end
local IS_FLAT_INSTALL
if hasPoBFiles(POB_PATH) then
	IS_FLAT_INSTALL = true
elseif hasPoBFiles(POB_PATH .. "/src") then
	IS_FLAT_INSTALL = false
else
	IS_FLAT_INSTALL = fileExists(POB_PATH .. "/Launch.lua")
end
local SCRIPT_PATH = IS_FLAT_INSTALL and POB_PATH or (POB_PATH .. "/src")
local REPO_ROOT = POB_PATH  -- kept for the legacy GetWorkDir/GetUserPath/GetRuntimePath helpers below

package.path = SCRIPT_PATH .. "/?.lua;"
	.. SCRIPT_PATH .. "/?/init.lua;"
	.. POB_PATH .. "/lua/?.lua;"
	.. POB_PATH .. "/lua/?/init.lua;"
	.. POB_PATH .. "/runtime/lua/?.lua;"
	.. POB_PATH .. "/runtime/lua/?/init.lua;"
	.. package.path
package.cpath = POB_PATH .. "/?.dll;"
	.. POB_PATH .. "/?.so;"
	.. POB_PATH .. "/runtime/?.dll;"
	.. POB_PATH .. "/runtime/?.so;"
	.. package.cpath

-- PoB 2.68+ uses compound assignments (`count += 1`) that only PoB's patched
-- LuaJIT parses. Every PoB file is loaded through this loadfile, which tries the
-- file as-is first and rewrites compound assignments only when that fails to
-- parse. Nothing is written to the PoB install; the rewrite happens in memory.
local pobLoadfile
do
	local bridgeDir = (arg and arg[0] or ""):match("^(.*)[/\\][^/\\]*$") or "."
	local compoundAssign = dofile(bridgeDir .. "/compound-assign.lua")
	pobLoadfile = compoundAssign.loadfile
	-- `require` of PoB modules (e.g. Classes.CompareBuySimilar) goes through the same loader.
	table.insert(package.loaders, 2, compoundAssign.searcher)
end

-- ---------------------------------------------------------------------------
-- Protocol stream protection. stdout carries exactly one JSON object per line
-- and nothing else. Anything PoB (or a library) prints goes to stderr instead.
-- ---------------------------------------------------------------------------
local STDOUT = io.stdout
local STDERR = io.stderr
function print(...)
	local n = select("#", ...)
	local parts = { }
	for i = 1, n do
		parts[i] = tostring((select(i, ...)))
	end
	STDERR:write(table.concat(parts, "\t"), "\n")
end
io.output(STDERR)

local ffiOk, ffi = pcall(require, "ffi")
if not ffiOk then ffi = nil end
local IS_WINDOWS = (ffi and ffi.os == "Windows") or package.config:sub(1, 1) == "\\"

-- ---------------------------------------------------------------------------
-- Install write guard. The bridge must never modify the user's PoB install:
-- io.open in any write/append/update mode, os.remove and os.rename are refused
-- for paths that resolve inside POB_PATH. Reads are untouched. Installed before
-- Launch.lua so every PoB module (and any locals they cache) sees the guard.
-- ---------------------------------------------------------------------------
local raw_io_open, raw_os_remove, raw_os_rename, raw_io_output = io.open, os.remove, os.rename, io.output
local GUARD_MSG = "read-only: pob-mcp bridge never writes inside the Path of Building install"
local guardStats = { blockedWrites = 0, lastBlocked = nil }

local function getCwd()
	if ffi then
		local ok, cwd = pcall(function()
			local buf = ffi.new("char[?]", 4096)
			if IS_WINDOWS then
				ffi.cdef("uint32_t GetCurrentDirectoryA(uint32_t nBufferLength, char *lpBuffer);")
				local n = ffi.C.GetCurrentDirectoryA(4096, buf)
				if n > 0 and n < 4096 then return ffi.string(buf, n) end
			else
				ffi.cdef("char *getcwd(char *buf, size_t size);")
				if ffi.C.getcwd(buf, 4096) ~= nil then return ffi.string(buf) end
			end
		end)
		if ok and cwd then return cwd end
	end
	return os.getenv("PWD")
end
-- Lua cannot change directory and SetWorkDir is stubbed, so the cwd is fixed.
local CWD = getCwd()

-- Canonical absolute form of a path: forward slashes, "." / ".." resolved,
-- and on Windows lower-cased with trailing dots/spaces trimmed per segment
-- (Win32 ignores them). Returns nil when the path cannot be resolved.
local function canonPath(p)
	if type(p) ~= "string" or p == "" then return nil end
	p = p:gsub("\\", "/"):gsub("^//[%?%.]/", "")
	local head, rest
	if p:match("^%a:/") then
		head, rest = p:sub(1, 2), p:sub(4)
	elseif p:sub(1, 2) == "//" then
		head, rest = "/", p:sub(3)
	elseif p:sub(1, 1) == "/" then
		head, rest = "", p:sub(2)
	elseif p:match("^%a:") then
		return nil -- drive-relative ("C:foo"): depends on per-drive cwd
	else
		if not CWD then return nil end
		return canonPath(CWD .. "/" .. p)
	end
	local parts = { }
	for seg in rest:gmatch("[^/]+") do
		if IS_WINDOWS and seg ~= "." and seg ~= ".." then
			seg = seg:gsub("[%. ]+$", "")
		end
		if seg == ".." then
			if #parts > 0 then parts[#parts] = nil end
		elseif seg ~= "." and seg ~= "" then
			parts[#parts + 1] = seg
		end
	end
	local out = head .. "/" .. table.concat(parts, "/")
	if IS_WINDOWS then out = out:lower() end
	return out
end

local INSTALL_ROOT = canonPath(POB_PATH)

-- True when `path` is inside the install, or cannot be resolved (fail closed).
local function isProtectedPath(path)
	if not INSTALL_ROOT then return true end
	local c = canonPath(path)
	if not c then return true end
	return c == INSTALL_ROOT or c:sub(1, #INSTALL_ROOT + 1) == INSTALL_ROOT .. "/"
end

-- Allowlist: only plain read modes count as reads. Anything else ("w", "a",
-- "+", MSVC extensions such as "rD" delete-on-close, non-strings) is a write.
local READ_MODES = { r = true, rb = true }
local function isWriteMode(mode)
	if mode == nil then return false end
	return not READ_MODES[mode]
end

-- Files the bridge pretends not to see. Launch.lua treats an existing
-- `first.run` as a fresh install: it deletes it and runs the online updater.
local HIDDEN_INSTALL_FILES = { }
if INSTALL_ROOT then
	HIDDEN_INSTALL_FILES[INSTALL_ROOT .. "/first.run"] = true
end

local function noteBlocked(op, path)
	guardStats.blockedWrites = guardStats.blockedWrites + 1
	guardStats.lastBlocked = op .. " " .. tostring(path)
	STDERR:write("[pob-mcp] blocked ", op, " inside PoB install: ", tostring(path), "\n")
end

function io.open(path, mode, ...)
	if isWriteMode(mode) and isProtectedPath(path) then
		noteBlocked("io.open(" .. tostring(mode) .. ")", path)
		return nil, tostring(path) .. ": " .. GUARD_MSG, 13
	end
	local c = canonPath(path)
	if c and HIDDEN_INSTALL_FILES[c] then
		return nil, tostring(path) .. ": No such file or directory", 2
	end
	return raw_io_open(path, mode, ...)
end

function os.remove(path)
	if isProtectedPath(path) then
		noteBlocked("os.remove", path)
		return nil, tostring(path) .. ": " .. GUARD_MSG, 13
	end
	return raw_os_remove(path)
end

function os.rename(src, dst)
	if isProtectedPath(src) or isProtectedPath(dst) then
		noteBlocked("os.rename", tostring(src) .. " -> " .. tostring(dst))
		return nil, tostring(src) .. ": " .. GUARD_MSG, 13
	end
	return raw_os_rename(src, dst)
end

function io.output(file)
	if type(file) == "string" and isProtectedPath(file) then
		noteBlocked("io.output", file)
		error(file .. ": " .. GUARD_MSG, 2)
	end
	if file == nil then return raw_io_output() end
	return raw_io_output(file)
end

-- ---------------------------------------------------------------------------
-- Native helpers PoB normally gets from SimpleGraphic: zlib Inflate/Deflate
-- and NewFileSearch. Implemented with LuaJIT FFI; each degrades gracefully
-- (nil result) when the native library is unavailable.
-- ---------------------------------------------------------------------------
local zlib = nil
local zlibInfo = { available = false }
do
	-- Windows: only the install's own zlib1.dll, by absolute path (a bare name
	-- would let LoadLibrary search the cwd and PATH). Elsewhere: the system
	-- zlib by its standard soname.
	local candidates = { }
	if IS_WINDOWS then
		if INSTALL_ROOT and INSTALL_ROOT:match("^%a:/") then
			for _, rel in ipairs({ "/zlib1.dll", "/runtime/zlib1.dll" }) do
				local full = INSTALL_ROOT .. rel
				local f = raw_io_open(full, "rb")
				if f then
					f:close()
					candidates[#candidates + 1] = (full:gsub("/", "\\"))
				end
			end
		end
	else
		candidates = { "libz.so.1", "z", "libz.1.dylib", "libz.dylib" }
	end
	if ffi then
		local ok = pcall(ffi.cdef, [[
			typedef struct pobmcp_z_stream {
				const unsigned char *next_in; unsigned int avail_in; unsigned long total_in;
				unsigned char *next_out; unsigned int avail_out; unsigned long total_out;
				const char *msg; void *state; void *zalloc; void *zfree; void *opaque;
				int data_type; unsigned long adler; unsigned long reserved;
			} pobmcp_z_stream;
			const char *zlibVersion(void);
			int inflateInit2_(pobmcp_z_stream *strm, int windowBits, const char *version, int stream_size);
			int inflate(pobmcp_z_stream *strm, int flush);
			int inflateEnd(pobmcp_z_stream *strm);
			unsigned long compressBound(unsigned long sourceLen);
			int compress2(unsigned char *dest, unsigned long *destLen, const unsigned char *source, unsigned long sourceLen, int level);
		]])
		if ok then
			for _, name in ipairs(candidates) do
				local okLoad, lib = pcall(ffi.load, name)
				if okLoad then
					local okVer, ver = pcall(function() return ffi.string(lib.zlibVersion()) end)
					if okVer then
						zlib = lib
						zlibInfo = { available = true, version = ver, library = name }
						break
					end
				end
			end
		end
	end
	if not zlib then
		STDERR:write("[pob-mcp] zlib not available; timeless/abyss jewel data and Inflate/Deflate are disabled\n")
	end
end

local Z_OK, Z_STREAM_END = 0, 1

local function zInflate(data, windowBits)
	local strm = ffi.new("pobmcp_z_stream")
	strm.next_in = ffi.cast("const unsigned char *", data)
	strm.avail_in = #data
	if zlib.inflateInit2_(strm, windowBits, zlib.zlibVersion(), ffi.sizeof("pobmcp_z_stream")) ~= Z_OK then
		return nil
	end
	local chunk = math.min(math.max(#data * 4, 65536), 16 * 1024 * 1024)
	local out = ffi.new("unsigned char[?]", chunk)
	local parts = { }
	local ret
	repeat
		strm.next_out = out
		strm.avail_out = chunk
		ret = zlib.inflate(strm, 0)
		if ret ~= Z_OK and ret ~= Z_STREAM_END then
			zlib.inflateEnd(strm)
			return nil
		end
		parts[#parts + 1] = ffi.string(out, chunk - strm.avail_out)
	until ret == Z_STREAM_END
	zlib.inflateEnd(strm)
	-- keep `data` alive until here (next_in points into it)
	local _ = data
	return table.concat(parts)
end

function Inflate(data)
	if not zlib or type(data) ~= "string" or data == "" then
		return nil
	end
	-- 15+32: zlib or gzip header (what PoB's Deflate emits); -15: raw deflate.
	return zInflate(data, 15 + 32) or zInflate(data, -15)
end

function Deflate(data)
	if not zlib or type(data) ~= "string" then
		return nil
	end
	local bound = zlib.compressBound(#data)
	local dest = ffi.new("unsigned char[?]", bound)
	local destLen = ffi.new("unsigned long[1]", bound)
	if zlib.compress2(dest, destLen, ffi.cast("const unsigned char *", data), #data, 9) ~= Z_OK then
		return nil
	end
	return ffi.string(dest, destLen[0])
end

-- NewFileSearch(pattern, dirOnly): SimpleGraphic's directory iterator. Returns
-- nil when nothing matches, else a handle with NextFile/GetFileName/
-- GetFileSize/GetFileModifiedTime. Windows uses FindFirstFile (supports
-- wildcards and real mtimes). Elsewhere only exact paths are found and the
-- mtime is reported as 0, which makes PoB prefer its compressed data.
local fileSearchClass = { }
fileSearchClass.__index = fileSearchClass
function fileSearchClass:GetFileName() return self.entries[self.index].name end
function fileSearchClass:GetFileSize() return self.entries[self.index].size end
function fileSearchClass:GetFileModifiedTime() return self.entries[self.index].modified end
function fileSearchClass:NextFile()
	if self.index < #self.entries then
		self.index = self.index + 1
		return true
	end
	return false
end

local findFirst = nil
if ffi and IS_WINDOWS then
	local ok = pcall(ffi.cdef, [[
		typedef struct pobmcp_find_data {
			uint32_t dwFileAttributes;
			uint32_t ftCreationTime[2]; uint32_t ftLastAccessTime[2]; uint32_t ftLastWriteTime[2];
			uint32_t nFileSizeHigh; uint32_t nFileSizeLow; uint32_t dwReserved0; uint32_t dwReserved1;
			char cFileName[260]; char cAlternateFileName[14];
		} pobmcp_find_data;
		void *FindFirstFileA(const char *lpFileName, pobmcp_find_data *lpFindFileData);
		int FindNextFileA(void *hFindFile, pobmcp_find_data *lpFindFileData);
		int FindClose(void *hFindFile);
	]])
	if ok then
		local INVALID = ffi.cast("void *", -1)
		findFirst = function(pattern, dirOnly)
			local fd = ffi.new("pobmcp_find_data")
			local h = ffi.C.FindFirstFileA(pattern, fd)
			if h == INVALID or h == nil then return { } end
			local entries = { }
			repeat
				local name = ffi.string(fd.cFileName)
				local isDir = bit.band(fd.dwFileAttributes, 0x10) ~= 0
				if name ~= "." and name ~= ".." and isDir == (dirOnly and true or false) then
					local wt = fd.ftLastWriteTime
					local ticks = wt[1] * 4294967296 + wt[0]
					entries[#entries + 1] = {
						name = name,
						size = fd.nFileSizeHigh * 4294967296 + fd.nFileSizeLow,
						modified = ticks / 1e7 - 11644473600,
					}
				end
			until ffi.C.FindNextFileA(h, fd) == 0
			ffi.C.FindClose(h)
			return entries
		end
	end
end

function NewFileSearch(pattern, dirOnly)
	if type(pattern) ~= "string" then return nil end
	local entries
	if findFirst then
		entries = findFirst(pattern, dirOnly)
	else
		entries = { }
		if not dirOnly and not pattern:find("[%*%?]") then
			local f = raw_io_open(pattern, "rb")
			if f then
				local size = f:seek("end")
				f:close()
				entries[1] = { name = pattern:match("([^/\\]+)$") or pattern, size = size or 0, modified = 0 }
			end
		end
	end
	if #entries == 0 then return nil end
	return setmetatable({ entries = entries, index = 1 }, fileSearchClass)
end

local function createUtf8Fallback()
	local utf8Fallback = { }
	utf8Fallback.reverse = function(str)
		return string.reverse(str)
	end
	utf8Fallback.gsub = function(str, pattern, repl, n)
		return string.gsub(str, pattern, repl, n)
	end
	utf8Fallback.find = function(str, pattern, init, plain)
		return string.find(str, pattern, init, plain)
	end
	utf8Fallback.sub = function(str, i, j)
		return string.sub(str, i, j)
	end
	utf8Fallback.match = function(str, pattern, init)
		return string.match(str, pattern, init)
	end
	utf8Fallback.next = function(str, charpos, offset)
		local nextPos = charpos + offset
		if nextPos < 1 or nextPos > #str + 1 then
			return nil
		end
		return nextPos
	end
	return utf8Fallback
end

-- The host/graphics stubs below (callbacks, image handles, rendering, input and
-- console functions) are adapted from src/HeadlessWrapper.lua in Path of
-- Building Community (https://github.com/PathOfBuildingCommunity/PathOfBuilding),
-- which is MIT licensed:
--
--   Copyright (c) 2016 David Gowor
--
--   Permission is hereby granted, free of charge, to any person obtaining a copy
--   of this software and associated documentation files (the "Software"), to deal
--   in the Software without restriction, including without limitation the rights
--   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
--   copies of the Software, and to permit persons to whom the Software is
--   furnished to do so, subject to the following conditions:
--
--   The above copyright notice and this permission notice shall be included in all
--   copies or substantial portions of the Software.
--
--   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
--   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
--   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
--   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
--   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
--   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
--   SOFTWARE.

-- Callbacks
local callbackTable = { }
local mainObject
function runCallback(name, ...)
	if callbackTable[name] then
		return callbackTable[name](...)
	elseif mainObject and mainObject[name] then
		return mainObject[name](mainObject, ...)
	end
end
function SetCallback(name, func)
	callbackTable[name] = func
end
function GetCallback(name)
	return callbackTable[name]
end
function SetMainObject(obj)
	mainObject = obj
end

-- Image Handles
local imageHandleClass = { }
imageHandleClass.__index = imageHandleClass
function NewImageHandle()
	return setmetatable({ }, imageHandleClass)
end
function imageHandleClass:Load(fileName, ...)
	self.valid = true
end
function imageHandleClass:Unload()
	self.valid = false
end
function imageHandleClass:IsValid()
	return self.valid
end
function imageHandleClass:SetLoadingPriority(pri) end
function imageHandleClass:ImageSize()
	return 1, 1
end

-- Rendering
function RenderInit(flag, ...) end
function GetScreenSize()
	return 1920, 1080
end
function GetScreenScale()
	return 1
end
function GetVirtualScreenSize()
	return GetScreenSize()
end
function GetDPIScaleOverridePercent()
	return 1
end
function SetDPIScaleOverridePercent(scale) end
function SetClearColor(r, g, b, a) end
function SetDrawLayer(layer, subLayer) end
function SetViewport(x, y, width, height) end
function SetDrawColor(r, g, b, a) end
function DrawImage(imgHandle, left, top, width, height, tcLeft, tcTop, tcRight, tcBottom) end
function DrawImageQuad(imageHandle, x1, y1, x2, y2, x3, y3, x4, y4, s1, t1, s2, t2, s3, t3, s4, t4) end
function DrawString(left, top, align, height, font, text) end
function DrawStringWidth(height, font, text)
	return 1
end
function DrawStringCursorIndex(height, font, text, cursorX, cursorY)
	return 0
end
function StripEscapes(text)
	return text:gsub("%^%d",""):gsub("%^x%x%x%x%x%x%x","")
end
function GetAsyncCount()
	return 0
end

-- General Functions
function SetWindowTitle(title) end
function GetCursorPos()
	return 0, 0
end
function SetCursorPos(x, y) end
function ShowCursor(doShow) end
function IsKeyDown(keyName) end
function Copy(text) end
function Paste() end
function GetTime()
	return 0
end
function GetScriptPath()
	return SCRIPT_PATH
end
function GetRuntimePath()
	return REPO_ROOT .. "/runtime"
end
function GetUserPath()
	return REPO_ROOT
end
function MakeDir(path) end
function RemoveDir(path) end
function SetWorkDir(path) end
function GetWorkDir()
	return REPO_ROOT
end
function LaunchSubScript(scriptText, funcList, subList, ...) end
function AbortSubScript(ssID) end
function IsSubScriptRunning(ssID) end
function LoadModule(fileName, ...)
	if not fileName:match("%.lua") then
		fileName = fileName .. ".lua"
	end
	local func, err = pobLoadfile(fileName)
	if func then
		return func(...)
	else
		error("LoadModule() error loading '"..fileName.."': "..err)
	end
end
function PLoadModule(fileName, ...)
	if not fileName:match("%.lua") then
		fileName = fileName .. ".lua"
	end
	local func, err = pobLoadfile(fileName)
	if func then
		return PCall(func, ...)
	else
		error("PLoadModule() error loading '"..fileName.."': "..err)
	end
end
function PCall(func, ...)
	local ret = { pcall(func, ...) }
	if ret[1] then
		table.remove(ret, 1)
		return nil, unpack(ret)
	else
		return ret[2]
	end
end
function ConPrintf(fmt, ...)
	io.stderr:write(string.format(fmt, ...) .. "\n")
	io.stderr:flush()
end
function ConPrintTable(tbl, noRecurse) end
function ConExecute(cmd) end
function ConClear() end
function SpawnProcess(cmdName, args) end
function OpenURL(url) end
function SetProfiling(isEnabled) end
function Restart() end
function Exit() end
function TakeScreenshot() end

---@return string? provider
---@return string? version
---@return number? status
function GetCloudProvider(fullPath)
	return nil, nil, nil
end

local l_require = require
function require(name)
	-- Hack to stop it looking for lcurl, which we don't really need
	if name == "lcurl.safe" then
		return
	end
	if name == "lua-utf8" then
		local ok, mod = pcall(l_require, name)
		if ok then
			return mod
		end
		return createUtf8Fallback()
	end
	return l_require(name)
end

local dkjson = require("dkjson")

-- Mark an error as "user input" so the TS side surfaces it verbatim
-- rather than wrapping it as "Internal error: ...". The marker is the
-- magic prefix __USER__ on the message; the JSON dispatcher strips it
-- and sets userError = true in the response. Level 0 keeps Lua from
-- prepending "<script path>:<line>:", whose shape depends on the bridge
-- script's path and would hide the marker.
local USER_ERROR_PREFIX = "__USER__"
local function userError(msg)
  error(USER_ERROR_PREFIX .. msg, 0)
end

-- A command failed and putting things back failed too: always an internal
-- error (the build may have changed, so the client is pointed at
-- reset_build), keeping the original message without the user-error marker.
local function failedRecoveryError(err, what, detail)
	local msg = tostring(err)
	if msg:sub(1, #USER_ERROR_PREFIX) == USER_ERROR_PREFIX then
		msg = msg:sub(#USER_ERROR_PREFIX + 1)
	end
	error(msg .. " (" .. what .. " also failed: " .. tostring(detail) .. ")", 0)
end

-- Test-only fault injection, read once from the environment of the LuaJIT
-- process (never from a command, so MCP tool arguments cannot reach it).
-- POB_MCP_TEST_FAULTS is a comma-separated list of fault names; see the
-- uses of TEST_FAULTS below. Unset in normal use.
local TEST_FAULTS = { }
for name in tostring(os.getenv("POB_MCP_TEST_FAULTS") or ""):gmatch("[%w_]+") do
	TEST_FAULTS[name] = true
end

-- Test fault: stall without answering (a hung engine). Bounded, so a process
-- nobody kills still ends on its own.
local function testFaultStall()
	local deadline = os.clock() + 300
	while os.clock() < deadline do end
end

-- Test faults for any command: exitOn_<cmd> ends the process, hangOn_<cmd>
-- stalls and failOn_<cmd> raises an error before running it. exitAfterChange
-- ends the process on the first command after a successful build change
-- (equipItem, unequipItem, setConfig, convertTreeToLatest); failAfterChange
-- instead raises an error on that command, once per change.
local TEST_CHANGE_COMMANDS = { equipItem = true, unequipItem = true, setConfig = true, convertTreeToLatest = true }
local testChangeDone = false
local function testFaultsForCommand(name)
	if TEST_FAULTS.exitAfterChange and testChangeDone then os.exit(3) end
	if TEST_FAULTS.failAfterChange and testChangeDone then
		testChangeDone = false
		error("test fault: the command after a change failed", 0)
	end
	if TEST_FAULTS["exitOn_" .. tostring(name)] then os.exit(3) end
	if TEST_FAULTS["hangOn_" .. tostring(name)] then testFaultStall() end
	if TEST_FAULTS["failOn_" .. tostring(name)] then error("test fault: " .. tostring(name) .. " failed", 0) end
end

local function encodeJSON(obj)
	local ok, encoded = pcall(dkjson.encode, obj)
	if ok and type(encoded) == "string" then
		return encoded
	end
	local fallbackOk, fallback = pcall(dkjson.encode, {
		error = "Failed to encode bridge response as JSON: " .. tostring(ok and "encoder returned no string" or encoded),
	})
	if fallbackOk and type(fallback) == "string" then
		return fallback
	end
	return '{"error":"Failed to encode bridge response as JSON"}'
end

local function respond(obj)
	STDOUT:write(encodeJSON(obj) .. "\n")
	STDOUT:flush()
end

-- PoB colour escapes (^7, ^xRRGGBB) are noise in an error message.
local function stripColorCodes(text)
	return (tostring(text):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", ""))
end

assert(pobLoadfile(SCRIPT_PATH .. "/Launch.lua"))()
mainObject.continuousIntegrationMode = os.getenv("CI")
runCallback("OnInit")
runCallback("OnFrame")

if mainObject.promptMsg then
	respond({ error = "Path of Building failed to initialise: " .. stripColorCodes(mainObject.promptMsg) })
	os.exit(1)
end

build = mainObject.main.modes["BUILD"]

-- A source clone runs PoB in dev mode: switching away from the BUILD mode
-- (every load does) autosaves the open build to `~~temp~~.xml` in the clone's
-- build directory. The write guard refuses that, PoB opens an error popup and
-- the load is reported as failed. Stop PoB from trying instead of relaxing the
-- guard. Settings.xml can set the flag back to false, so it is re-asserted
-- before every build switch. Harmless for an installed layout (not dev mode).
local function suppressDevAutoSave()
	if mainObject.main then
		mainObject.main.disableDevAutoSave = true
	end
end
suppressDevAutoSave()

-- A build whose load aborted part-way leaves a TreeTab with no active spec on
-- the (reused) Build module. The next Build:Init constructs ConfigTab before
-- replacing TreeTab, and ConfigTab -> SyncLoadouts indexes the stale tab and
-- crashes. Drop such a tab so Init starts from a clean slate.
local function scrubStaleBuildState()
	local b = mainObject.main and mainObject.main.modes and mainObject.main.modes["BUILD"]
	local tab = b and b.treeTab
	if tab and not (type(tab.specList) == "table" and tab.activeSpec and tab.specList[tab.activeSpec]) then
		b.treeTab = nil
	end
end

function newBuild()
	scrubStaleBuildState()
	suppressDevAutoSave()
	mainObject.main:SetMode("BUILD", false, "Help, I'm stuck in Path of Building!")
	runCallback("OnFrame")
	build = mainObject.main.modes["BUILD"]
end

function loadBuildFromXML(xmlText, name)
	scrubStaleBuildState()
	suppressDevAutoSave()
	mainObject.main:SetMode("BUILD", false, name or "", xmlText)
	runCallback("OnFrame")
	build = mainObject.main.modes["BUILD"]
	-- Force a full rebuild + extra frame so calc results stabilize before
	-- the first stat query. Without this, EHP and a few derived stats can
	-- drift by ~5-10% on the very first getStats vs subsequent queries.
	if build then
		build.buildFlag = true
		runCallback("OnFrame")
		build.buildFlag = true
		runCallback("OnFrame")
	end
end

local function tableHasAny(tbl)
	return type(tbl) == "table" and next(tbl) ~= nil
end

local function getMainSkillName()
	local group = build and build.skillsTab and build.skillsTab.socketGroupList and build.skillsTab.socketGroupList[build.mainSocketGroup]
	if not group then
		return nil
	end
	if group.displaySkillList and group.mainActiveSkill and group.displaySkillList[group.mainActiveSkill] then
		local active = group.displaySkillList[group.mainActiveSkill]
		if active.activeEffect and active.activeEffect.grantedEffect then
			return active.activeEffect.grantedEffect.name
		end
		return active.name or active.skillName
	end
	return group.displayLabel
end

local function getBuildInfo()
	local treeVersion = build.spec and build.spec.treeVersion
	local latest = rawget(_G, "latestTreeVersion")
	local secondary = build.spec and build.spec.curSecondaryAscendClassName
	return {
		class = build.className or (build.spec and build.spec.curClassName),
		ascendancy = build.ascendClassName or (build.spec and build.spec.curAscendClassName),
		-- Only when one is chosen (a bloodline on 3.25+ trees).
		secondaryAscendancy = (secondary ~= nil and secondary ~= "None") and secondary or nil,
		level = build.characterLevel,
		mainSkill = getMainSkillName(),
		treeVersion = treeVersion ~= nil and tostring(treeVersion) or nil,
		latestTreeVersion = latest ~= nil and tostring(latest) or nil,
	}
end

local function pumpAndRead()
	runCallback("OnFrame")
	build = mainObject.main.modes["BUILD"]
	return build.calcsTab and build.calcsTab.mainOutput or { }
end

local statKeys = {
	"CombinedDPS", "CombinedAvg", "TotalDPS", "TotalDot", "WithBleedDPS", "WithPoisonDPS", "TotalEHP",
	"Life", "Spec:LifeInc", "EnergyShield", "Mana", "Ward", "Armour", "Evasion", "FireResist",
	"ColdResist", "LightningResist", "ChaosResist", "FireResistOverCap", "ColdResistOverCap",
	"LightningResistOverCap", "ChaosResistOverCap", "NetLifeRegen", "LifeRegen", "LifeLeechGainRate",
	"ManaRegen", "EnergyShieldRegen", "EffectiveMovementSpeedMod", "FullDPS"
}

local function copyValue(value)
	if type(value) == "number" or type(value) == "string" or type(value) == "boolean" then
		return value
	end
	return nil
end

local function getStats()
	local output = pumpAndRead()
	local stats = { }
	for _, key in ipairs(statKeys) do
		stats[key] = copyValue(output[key])
	end
	local playerOutput = build.calcsTab and build.calcsTab.mainEnv and build.calcsTab.mainEnv.player and build.calcsTab.mainEnv.player.output or { }
	for _, key in ipairs(statKeys) do
		if stats[key] == nil then
			stats[key] = copyValue(playerOutput[key])
		end
	end
	return stats
end

local function getConfig()
	local result = { }
	local input = build.configTab and build.configTab.input or { }
	for key, value in pairs(input) do
		result[key] = copyValue(value)
	end
	return result
end

local function verifyData()
	local treeNodeCount = 0
	local nodeSource = nil
	if build and build.spec and build.spec.nodes then
		nodeSource = build.spec.nodes
	elseif build and build.spec and build.spec.tree and build.spec.tree.nodes then
		nodeSource = build.spec.tree.nodes
	elseif build and build.latestTree and build.latestTree.nodes then
		nodeSource = build.latestTree.nodes
	elseif build and build.treeTab and build.treeTab.spec and build.treeTab.spec.nodes then
		nodeSource = build.treeTab.spec.nodes
	end
	if nodeSource then
		for _ in pairs(nodeSource) do
			treeNodeCount = treeNodeCount + 1
		end
	end
	return {
		treeNodes = treeNodeCount,
		gemsLoaded = data and tableHasAny(data.gems) or false,
		itemBasesLoaded = data and tableHasAny(data.itemBases) or false,
		paths = {
			script = GetScriptPath(),
			runtime = GetRuntimePath(),
			user = GetUserPath(),
			workDir = GetWorkDir(),
		},
	}
end

local function getItemInSlot(slotName)
	local slot = build.itemsTab.slots[slotName]
	if not slot then
		userError("Unknown slot: " .. tostring(slotName))
	end
	local itemId = slot.selItemId or 0
	if itemId == 0 then
		return { slot = slotName, itemId = 0, raw = nil }
	end
	local item = build.itemsTab.items[itemId]
	if not item then
		return { slot = slotName, itemId = itemId, raw = nil }
	end
	return {
		slot = slotName,
		itemId = itemId,
		raw = item.raw,
		rarity = item.rarity,
		name = item.name,
		baseName = item.baseName,
	}
end

-- Slot checks shared by the item commands and the slot listings (one table,
-- not separate top-level locals: the main chunk is close to LuaJIT's limit).
local slotChecks = { }

-- Slots Path of Building shows only on some passive tree versions: its
-- ItemsTab gives them a `shown` function testing spec.treeVersion (Wickerman
-- on 3.30, grafts on 3.27). Only these follow PoB's visibility here; weapon
-- swap, Ring 3 and abyssal sockets are listed and accepted as before.
-- `counted` says whether PoB's CalcSetup still uses an item left in the slot
-- while it is hidden: grafts are skipped off 3.27, but its Wickerman check
-- (`^Wickerman `) matches no slot name, so Viscera items keep counting.
do
	local wickerman = {
		what = "the Wickerman slots (Head, Body, Arm, Leg)", tree = "3.30", counted = true,
		remedy = "convert_tree_to_latest moves the build to the latest passive tree, where they are shown",
	}
	local graft = {
		what = "the Graft slots", tree = "3.27", counted = false,
		remedy = "they are usable only on a 3.27 tree; no tree conversion makes them available",
	}
	slotChecks.treeGated = {
		Head = wickerman, Body = wickerman, Arm = wickerman, Leg = wickerman,
		["Graft 1"] = graft, ["Graft 2"] = graft,
	}
end

-- The tree gate of `slot` when PoB currently hides it, else nil. A slot
-- without a `shown` property counts as shown (older PoB versions).
function slotChecks.hiddenGate(slot)
	local gate = slotChecks.treeGated[slot.slotName]
	if not gate then return nil end
	local shown = slot.shown
	if type(shown) == "function" then shown = shown(slot) end
	if shown == nil and slot.shown == nil then shown = true end
	if shown then return nil end
	return gate
end

-- Why PoB currently hides `slot`, or nil when it is shown.
function slotChecks.hiddenReason(slot)
	local gate = slotChecks.hiddenGate(slot)
	if not gate then return nil end
	local treeVersion = build.spec and build.spec.treeVersion or "unknown"
	return string.format("Path of Building shows %s only on %s passive trees (this build uses tree %s)",
		gate.what, gate.tree, (tostring(treeVersion):gsub("_", ".")))
end

-- The slot named `slotName`. Unknown slots are refused; with `equipping`,
-- so is a slot PoB hides (removing an item from one is always allowed).
function slotChecks.usableSlot(slotName, equipping)
	local slot = build.itemsTab.slots[slotName]
	if not slot then
		userError("Unknown slot: " .. tostring(slotName))
	end
	local reason = equipping and slotChecks.hiddenReason(slot)
	if reason then
		userError(string.format("Cannot equip an item in %s: %s; %s", slotName, reason,
			slotChecks.hiddenGate(slot).remedy))
	end
	return slot
end

-- For an abyssal socket slot: its index on the parent slot, the abyssal
-- socket count of the parent's item (0 when empty) and the parent slot; nil
-- for any other slot. PoB's ItemSlot:Populate empties sockets beyond the count.
function slotChecks.abyssalSocket(slot)
	local parent = slot.parentSlot
	if not parent then return nil end
	local index = 0
	for i, s in ipairs(parent.abyssalSocketList or { }) do
		if s == slot then index = i end
	end
	local parentItem = build.itemsTab.items[parent.selItemId or 0]
	return index, parentItem and parentItem.abyssalSocketCount or 0, parent
end

-- The node id of a passive-tree jewel socket that is not allocated, else nil.
-- PoB's CalcSetup skips such a socket: a jewel there counts for nothing.
function slotChecks.unallocatedSocket(slot)
	if slot.nodeId and not (build.spec and build.spec.allocNodes[slot.nodeId]) then return slot.nodeId end
	return nil
end

-- For a socket a cluster jewel adds that does not exist on the tree yet
-- (PassiveSpec keeps such sockets out of spec.nodes until a cluster jewel in
-- the parent socket builds them): the parent socket's node id; else nil.
function slotChecks.clusterParent(nodeId)
	local spec = build.spec
	if not spec or spec.nodes[nodeId] ~= nil then return nil end
	local treeNode = spec.tree and spec.tree.nodes[nodeId]
	local parent = treeNode and treeNode.expansionJewel and treeNode.expansionJewel.parent
	return parent and tonumber(parent) or nil
end

-- What makes a jewel in passive-tree socket `nodeId` count, as a sentence.
function slotChecks.socketRemedy(nodeId)
	local parent = slotChecks.clusterParent(nodeId)
	if parent then
		return string.format("It is a socket a cluster jewel adds, and no cluster jewel in Jewel %d adds it: socket a cluster "
			.. "jewel with jewel sockets in Jewel %d (swap_item), then allocate node %d (allocate_nodes)", parent, parent, nodeId)
	end
	return string.format("Allocate node %d first (allocate_nodes)", nodeId)
end

-- With `inVariant` (probe and apply_changes variants), an existing socket
-- may also be allocated by the same variant.
function slotChecks.unallocatedText(slotName, nodeId, inVariant)
	return string.format("%s is an unallocated passive tree jewel socket: a jewel there counts for nothing in "
		.. "Path of Building's calculations. %s%s", slotName, slotChecks.socketRemedy(nodeId),
		(inVariant and not slotChecks.clusterParent(nodeId)) and ", or allocate it in the same variant" or "")
end

-- Why ItemsTab:IsItemValidForSlot refused `item` for `slotName`.
function slotChecks.refusalReason(tab, item, slotName)
	local kind = item.type or (item.base and item.base.type) or "unknown"
	if slotName:match("^Jewel %d+$") then
		if kind ~= "Jewel" then
			return "only jewels go in passive tree jewel sockets"
		end
		return "this jewel does not fit that socket (no such socket node, cluster jewel too large, or charm/socket mismatch)"
	end
	if slotName == "Weapon 2" or slotName == "Weapon 2 Swap" then
		local mainSlot = slotName == "Weapon 2" and "Weapon 1" or "Weapon 1 Swap"
		local entry = tab.activeItemSet[mainSlot]
		local mainItem = entry and tab.items[entry.selItemId or 0]
		if mainItem then
			return "a " .. kind .. " cannot be used alongside the " .. tostring(mainItem.base and mainItem.base.type or mainItem.type)
				.. " in " .. mainSlot
		end
		return "a " .. kind .. " cannot go in the off-hand slot"
	end
	return "a " .. kind .. " item does not go in that slot"
end

-- Flask slots (Flask 1-5; tinctures go there too). PoB's ItemSlot gives them
-- an "Activate this flask" check box that sets slot.active and the active
-- item set's entry (`active`, what ItemsTab saves); CalcSetup counts a flask
-- or tincture (env.flasks / env.tinctures) only while slot.active is on.
-- That per-slot state is not the `conditionUsingFlask` config option (the
-- `flasks` alias), which only says whether the character counts as using a
-- flask for "while using a flask" modifiers.
function slotChecks.isFlaskSlot(slot)
	return type(slot) == "table" and not slot.nodeId and not slot.parentSlot and type(slot.slotName) == "string"
		and slot.slotName:match("^Flask %d+$") ~= nil
end

-- The flask slot named `slotName`; anything else is refused.
function slotChecks.flaskSlot(slotName)
	local slot = build.itemsTab.slots[slotName]
	if not slot then userError("Unknown slot: " .. tostring(slotName)) end
	if not slotChecks.isFlaskSlot(slot) then
		userError(tostring(slotName) .. " is not a flask slot: only Flask 1 to Flask 5 can be set active or inactive")
	end
	return slot
end

-- A flag that may be nil, as a JSON-safe code (item states keep nil and
-- false apart so a restore puts back exactly what was there): 1, 0, -1.
function slotChecks.flagCode(v)
	if v == nil then return -1 end
	return v and 1 or 0
end

function slotChecks.flagValue(code)
	if code == 1 then return true elseif code == 0 then return false end
	return nil
end

-- What PoB's check box sets (without PoB's own undo state): slot.active, the
-- active item set's entry and the box's state. Returns a function putting
-- back exactly what was there.
function slotChecks.setFlaskFlags(slot, slotActive, entryActive)
	local entry = build.itemsTab.activeItemSet[slot.slotName]
	local box = slot.controls and slot.controls.activate
	local was = { slot.active, entry and entry.active, box and box.state }
	slot.active = slotActive
	if entry then entry.active = entryActive end
	if box then box.state = slotActive end
	return function()
		slot.active = was[1]
		if entry then entry.active = was[2] end
		if box then box.state = was[3] end
	end
end

-- An item what-if into an inactive flask slot would count for nothing.
function slotChecks.inactiveFlaskText(slotName, remedy)
	return string.format("%s is not active, so Path of Building does not apply the flask or tincture there (its effects "
		.. "and charges-related stats stay off) and the comparison would show next to no difference. %s", slotName, remedy)
end

-- The weapon set (1 or 2) of a weapon slot, or of an abyssal socket on one,
-- when the build does not use that set, else nil. PoB's CalcSetup skips
-- such a slot: an item there counts for nothing.
function slotChecks.inactiveWeaponSet(slot)
	local set = slot.weaponSet or (slot.parentSlot and slot.parentSlot.weaponSet)
	local itemSet = build.itemsTab.activeItemSet
	if set and set ~= ((itemSet and itemSet.useSecondWeaponSet) and 2 or 1) then return set end
	return nil
end

function slotChecks.inactiveWeaponSetText(slotName, set)
	return string.format("%s belongs to weapon set %d, which the build does not use (it uses weapon set %d), so Path of "
		.. "Building ignores an item there", slotName, set, set == 1 and 2 or 1)
end

-- Flask slots in trade searches. PoB's TradeHelpers maps every flask slot to
-- the "flask" trade category and the generator's "Flask" mod list, which
-- holds every flask mod (its LifeFlask / ManaFlask lists hold a handful of
-- other mods), so every flask kind is weighed from that list; the kind only
-- decides the flask the mods are tried on. PoB has no tincture category: a
-- tincture search weighs PoB's tincture mods itself (tradeCompat.customModData).
slotChecks.FLASK_SUBTYPES = { life = "Life", mana = "Mana", hybrid = "Hybrid", utility = "Utility" }
-- The flask a search of that kind tries mods on when the slot holds no flask
-- of that kind (the highest-level base of the kind when one is missing).
slotChecks.FLASK_STAND_INS = { life = "Divine Life Flask", mana = "Divine Mana Flask",
	hybrid = "Hallowed Hybrid Flask", utility = "Quicksilver Flask" }

-- "life" / "mana" / "hybrid" / "utility" for a flask, "tincture", else nil.
function slotChecks.flaskKind(item)
	if not item then return nil end
	local base = item.base or { }
	local itemType = item.type or base.type
	if itemType == "Tincture" then return "tincture" end
	if itemType ~= "Flask" then return nil end
	for kind, subType in pairs(slotChecks.FLASK_SUBTYPES) do
		if base.subType == subType then return kind end
	end
	local flask = base.flask or { }
	if flask.life and flask.mana then return "hybrid" end
	return flask.life and "life" or flask.mana and "mana" or "utility"
end

-- The one refusal of tinctures in trade searches: a tincture search weighs
-- the tincture in the slot (its base decides its implicit and the search's
-- base type filter), so it needs one there.
slotChecks.VISCERA_TRADE_TEXT = "Viscera parts have fixed implicits and no affixes, so there are no mods to weigh; "
	.. "generate_trade_search ranks the Viscera parts that fit the slot instead"

function slotChecks.tinctureTradeRefusal(slotName, why)
	userError("Cannot build a tincture trade search for " .. tostring(slotName) .. ": " .. why .. ". A tincture search weighs "
		.. "the mods of the tincture in the slot (its base decides its implicit, and the trade search is filtered by that base "
		.. "type, as Path of Building's trade data has no tincture category), so equip the tincture you want to improve first, "
		.. "or pass flaskType \"life\", \"mana\", \"hybrid\" or \"utility\" to search flasks for the slot instead")
end

-- A trade search into flask slot `slot` holding `item`: the flask kind
-- searched (`flaskType`, else the equipped flask's) and, when the slot holds
-- no flask of that kind, the base to try the mods on instead. "tincture"
-- (flaskType, or the item in the slot) needs a tincture there, except with
-- `forMods` (search_trade_mods: the mod list is the same for every kind; an
-- empty slot needs no flaskType: nil, nil).
function slotChecks.tradeFlask(slot, item, flaskType, forMods)
	if flaskType ~= nil and flaskType ~= "tincture" and not slotChecks.FLASK_SUBTYPES[flaskType] then
		userError("flaskType must be \"life\", \"mana\", \"hybrid\", \"utility\" or \"tincture\"")
	end
	local current = slotChecks.flaskKind(item)
	if flaskType == "tincture" or (flaskType == nil and current == "tincture") then
		if current ~= "tincture" and not forMods then
			slotChecks.tinctureTradeRefusal(slot.slotName, item and "the slot holds a flask, not a tincture" or "the slot is empty")
		end
		return "tincture", nil
	end
	local kind = flaskType or current
	if kind == nil then
		if forMods then return nil, nil end
		userError("Cannot build a trade search for " .. slot.slotName .. ": the slot is empty, so pass flaskType "
			.. "(\"life\", \"mana\", \"hybrid\" or \"utility\") to say which flask to search for")
	end
	if kind == current then return kind, nil end
	local baseName = slotChecks.FLASK_STAND_INS[kind]
	if not data.itemBases[baseName] then
		baseName = nil
		local best = -1
		for name, base in pairs(data.itemBases) do
			local level = base.req and base.req.level or 0
			if base.type == "Flask" and base.subType == slotChecks.FLASK_SUBTYPES[kind] and not base.hidden
				and (level > best or (level == best and name < baseName)) then
				baseName, best = name, level
			end
		end
		if not baseName then error("Path of Building has no " .. kind .. " flask base", 0) end
	end
	return kind, baseName
end

-- PoB 2.68 split object construction into `new("X"):X(args)` and rejects
-- `new("X", args)`; older PoB only has the latter. Detected once by asking `new`
-- about a class that does not exist: only the new `new` complains about the
-- extra argument.
local construct
do
	local split
	function construct(className, ...)
		if split == nil then
			local ok, err = pcall(new, "pobmcp-no-such-class", true)
			split = not ok and tostring(err):find("Extra argument", 1, true) ~= nil
		end
		if split then
			local object = new(className)
			return object[className](object, ...)
		end
		return new(className, ...)
	end
end

-- Parse item text exactly as ItemsTab:CreateDisplayItemFromRaw does (without
-- normalising), but never through the items tab's displayItem: a parse
-- failure can then never leave an earlier display item behind to be equipped.
local function parseItemText(itemRaw, slotName)
	local ok, item = pcall(construct, "Item", itemRaw)
	if not ok then
		userError("Could not parse the item text for " .. slotName .. ": " .. stripColorCodes(tostring(item)))
	end
	if not (item and item.base) then
		userError("Could not parse the item text for " .. slotName .. ": Path of Building does not recognise its base type")
	end
	return item
end

-- Everything that stops `item` going into `slot`, checked before anything is
-- changed. PoB's PopulateSlots would otherwise silently empty the slot.
local function assertItemFitsSlot(tab, slot, item)
	local slotName = slot.slotName
	if not tab:IsItemValidForSlot(item, slotName) then
		userError(string.format("%s cannot be equipped in %s: %s", tostring(item.name or "This item"), slotName,
			slotChecks.refusalReason(tab, item, slotName)))
	end
	local index, count, parent = slotChecks.abyssalSocket(slot)
	if parent then
		if index > count then
			userError(string.format("%s cannot be equipped in %s: the item in %s has %d abyssal socket(s)",
				tostring(item.name or "This item"), slotName, parent.slotName, count))
		end
	end
end

-- Remove an item that nothing refers to from the build (no undo state, no
-- slot repopulation; callers repopulate once).
local function removeUnusedItem(tab, id)
	tab.items[id] = nil
	for i = #tab.itemOrderList, 1, -1 do
		if tab.itemOrderList[i] == id then table.remove(tab.itemOrderList, i) end
	end
end

local function equipItemInSlot(slotName, itemRaw)
	local tab = build.itemsTab
	local slot = slotChecks.usableSlot(slotName, true)
	local newItem = parseItemText(itemRaw, slotName)
	assertItemFitsSlot(tab, slot, newItem)
	-- AddItem gives the item the lowest free id (not the highest).
	local previousId = slot.selItemId or 0
	tab:AddItem(newItem, true) -- noAutoEquip = true
	if not newItem.id or tab.items[newItem.id] ~= newItem then
		error("Path of Building did not add the item (ItemsTab:AddItem changed)")
	end
	slot:SetSelItemId(newItem.id)
	build.buildFlag = true
	tab:PopulateSlots()
	if slot.selItemId ~= newItem.id then
		-- Not expected after assertItemFitsSlot; put the slot back rather than
		-- leave it silently empty.
		slot:SetSelItemId(previousId)
		removeUnusedItem(tab, newItem.id)
		tab:PopulateSlots()
		runCallback("OnFrame")
		error("Path of Building did not keep the item in " .. slotName .. " (slot validation changed?)")
	end
	runCallback("OnFrame")
end

-- Re-select an item the build already holds. Returns false (changing
-- nothing) when `itemId` is gone or now holds a different item than `itemRaw`.
local function selectItemInSlot(slotName, itemId, itemRaw)
	local tab = build.itemsTab
	local slot = tab.slots[slotName]
	if not slot then
		userError("Unknown slot: " .. tostring(slotName))
	end
	local item = tab.items[itemId or 0]
	if not item or (itemRaw ~= nil and item.raw ~= itemRaw) then
		return false
	end
	assertItemFitsSlot(tab, slot, item)
	slot:SetSelItemId(item.id)
	build.buildFlag = true
	tab:PopulateSlots()
	runCallback("OnFrame")
	return true
end

-- Item state of the active item set: the item id in every equipment slot
-- that is not a passive-tree jewel socket (weapons and weapon swap, armour,
-- jewellery including Ring 3, grafts, flasks, abyssal sockets), taken from
-- the engine's own slot list, plus the build's item list in order. Jewel
-- sockets are deliberately left out: PoB keeps them on the passive spec
-- (spec.jewels), and the tree state (captureSpecState / restoreTreeState)
-- owns them.
-- Identity tokens for item objects (weak keys: a collected item's token goes
-- with it, and tokens are never reused), so a captured id can be checked to
-- still name the very item it named at capture time, cheaply.
local itemTokens = setmetatable({ }, { __mode = "k" })
-- Tokens are "<process tag>:<counter>". The tag is made once per engine
-- process, at its first token (after PoB has booted and a build is loaded),
-- from the wall clock, the CPU time used so far, the Lua heap size and the
-- addresses of fresh objects (which address-space randomisation varies), so
-- tokens from an engine that has since crashed or been replaced never match
-- this one's by coincidence. PoB's math.random state is left alone.
local itemTokenTag = nil
local function makeItemTokenTag()
	local function address(obj)
		local text = tostring(obj)
		return text:match("0x(%x+)") or text:match("(%x+)$") or "0"
	end
	return string.format("%x-%x-%x-%s-%s", os.time(), math.floor(os.clock() * 1e6),
		math.floor(collectgarbage("count") * 1024), address({ }), address(function() end))
end
local nextItemToken = 0
local function itemToken(item)
	if not item then return "" end
	local token = itemTokens[item]
	if not token then
		itemTokenTag = itemTokenTag or makeItemTokenTag()
		nextItemToken = nextItemToken + 1
		token = itemTokenTag .. ":" .. nextItemToken
		itemTokens[item] = token
	end
	return token
end

-- Token, and raw text to check it against, of every item that has one: kept
-- across a reload of the same build (the failed-load recovery in loadXML).
local function itemIdentities()
	local out = { }
	for id, item in pairs(build and build.itemsTab and build.itemsTab.items or { }) do
		local token = itemTokens[item]
		if token then out[id] = { token = token, raw = item.raw } end
	end
	return out
end

-- After the build was reloaded from its own SaveDB output, every item is a
-- new object with the same id: give each the token its predecessor had, but
-- only where the reloaded item has the same text, so undo entries and
-- snapshots of that build stay valid while anything else still mismatches.
-- The texts compare equal even for items PoB re-serialises (crafted mods,
-- variants, rolled ranges): ItemsTab:Save rewrites each item's raw text
-- (BuildAndParseRaw) before writing it, `identities` is read after that
-- SaveDB, and the reloaded item's raw text is exactly the saved text.
local function carryItemIdentities(identities)
	local carried = 0
	for id, item in pairs(build and build.itemsTab and build.itemsTab.items or { }) do
		local known = identities[id]
		if known and item.raw == known.raw then
			itemTokens[item] = known.token
			carried = carried + 1
		end
	end
	return carried
end

local function captureItemsState()
	local tab = build.itemsTab
	local slots = { }
	for _, slot in ipairs(tab.orderedSlots) do
		local id = slot.selItemId or 0
		if not slot.nodeId and id ~= 0 then
			slots[#slots + 1] = { slot.slotName, id }
		end
	end
	local order, tokens = { }, { }
	for i, id in ipairs(tab.itemOrderList) do
		order[i] = id
		tokens[i] = itemToken(tab.items[id])
	end
	-- Flask slots' active flags (slot and item set entry, as flag codes).
	local flasks = { }
	for _, slot in ipairs(tab.orderedSlots) do
		if slotChecks.isFlaskSlot(slot) then
			local entry = tab.activeItemSet[slot.slotName]
			flasks[#flasks + 1] = { slot.slotName, slotChecks.flagCode(slot.active), slotChecks.flagCode(entry and entry.active) }
		end
	end
	return { slots = slots, itemOrder = order, itemTokens = tokens, flasks = flasks }
end

-- Refuse (internal error, before anything changes) a captured item state
-- whose ids no longer name the captured items: a snapshot taken before the
-- engine was restarted or the build was reloaded, which replaces every item
-- object while keeping the same ids. (The bridge's own failed-load recovery
-- carries identities over, see carryItemIdentities.)
local function checkItemsState(state)
	if type(state) ~= "table" or type(state.itemOrder) ~= "table" or type(state.itemTokens) ~= "table"
		or #state.itemTokens ~= #state.itemOrder then
		error("Item snapshot is malformed; nothing was restored; call reset_build to return to the loaded build", 0)
	end
	local tab = build.itemsTab
	-- Flask slots' active flags (captureItemsState): every entry must name a
	-- flask slot of this build with valid flag codes.
	if state.flasks ~= nil then
		local valid = type(state.flasks) == "table"
		for _, f in ipairs(valid and state.flasks or { }) do
			local slot = type(f) == "table" and type(f[1]) == "string" and tab.slots[f[1]]
			local function isCode(c) return c == 1 or c == 0 or c == -1 end
			if not (slotChecks.isFlaskSlot(slot) and isCode(f[2]) and isCode(f[3])) then valid = false end
		end
		if not valid then
			error("Item snapshot has malformed or unknown flask slot states; nothing was restored; call reset_build to return "
				.. "to the loaded build", 0)
		end
	end
	for i, id in ipairs(state.itemOrder) do
		local item = tab.items[id]
		if not item or itemTokens[item] ~= state.itemTokens[i] then
			error("Item snapshot does not match the build (item " .. tostring(id) .. " is "
				.. (item and "a different item" or "gone") .. ": the snapshot was taken before the engine was "
				.. "restarted or the build was reloaded); nothing was restored; call reset_build to return to "
				.. "the loaded build", 0)
		end
	end
end

-- Where the build still refers to item `id`.
local function itemReferences(tab, id)
	local refs = { }
	for slotName, slot in pairs(tab.slots) do
		if slot.selItemId == id then refs[#refs + 1] = slotName end
	end
	for setId, itemSet in pairs(tab.itemSets or { }) do
		if itemSet ~= tab.activeItemSet then
			for slotName, entry in pairs(itemSet) do
				if type(entry) == "table" and entry.selItemId == id then
					refs[#refs + 1] = "item set " .. tostring(setId) .. " " .. tostring(slotName)
				end
			end
		end
	end
	for i, spec in ipairs(build.treeTab and build.treeTab.specList or { build.spec }) do
		for nodeId, itemId in pairs(spec.jewels or { }) do
			if itemId == id then refs[#refs + 1] = "tree " .. i .. " socket " .. tostring(nodeId) end
		end
	end
	table.sort(refs)
	return refs
end

-- Put a captureItemsState state back: every non-socket slot re-selects the
-- captured item id (by id, so nothing is re-added), items added since the
-- capture (probe items, the item a swap added) are deleted, and the item
-- order is the captured one. Snapshot items are never deleted, so ids held
-- by older snapshots (tree states, undo entries) stay valid. Returns
-- { exact, mismatches?, removedItemIds? }.
local function restoreItemsState(state)
	if type(state) ~= "table" or type(state.slots) ~= "table" or type(state.itemOrder) ~= "table" then
		error("restoreItemsState: malformed item state")
	end
	checkItemsState(state)
	local tab = build.itemsTab
	local mismatches = { }
	local want = { }
	for _, pair in ipairs(state.slots) do
		local name, id = pair[1], pair[2]
		if type(name) ~= "string" or type(id) ~= "number" then
			error("restoreItemsState: malformed slot entry")
		end
		if not tab.slots[name] or tab.slots[name].nodeId then
			mismatches[#mismatches + 1] = "slot " .. name .. " does not exist"
		elseif not tab.items[id] then
			mismatches[#mismatches + 1] = "item " .. id .. " for " .. name .. " no longer exists"
		end
		want[name] = id
	end
	local keep = { }
	for _, id in ipairs(state.itemOrder) do keep[id] = true end

	local changed = false
	for _, slot in ipairs(tab.orderedSlots) do
		if not slot.nodeId then
			local id = want[slot.slotName] or 0
			if not tab.items[id] then id = 0 end
			if (slot.selItemId or 0) ~= id then
				slot:SetSelItemId(id)
				changed = true
			end
		end
	end

	-- Flask slots' active flags, exactly as captured (nil and false apart).
	-- (checkItemsState checked every entry before anything changed.)
	for _, f in ipairs(state.flasks or { }) do
		local slot = tab.slots[f[1]]
		local entry = tab.activeItemSet[slot.slotName]
		local slotActive, entryActive = slotChecks.flagValue(f[2]), slotChecks.flagValue(f[3])
		if slot.active ~= slotActive or (entry and entry.active ~= entryActive) then
			slotChecks.setFlaskFlags(slot, slotActive, entryActive)
			changed = true
		end
	end

	local extra = { }
	for id in pairs(tab.items) do
		if not keep[id] then extra[#extra + 1] = id end
	end
	table.sort(extra)
	local removed = { }
	for _, id in ipairs(extra) do
		local refs = itemReferences(tab, id)
		if #refs > 0 then
			mismatches[#mismatches + 1] = "item " .. id .. " added since the snapshot is still in use (" .. table.concat(refs, ", ") .. ")"
		else
			removeUnusedItem(tab, id)
			removed[#removed + 1] = id
		end
	end

	local orderMatches = #tab.itemOrderList == #state.itemOrder
	for i, id in ipairs(state.itemOrder) do
		if tab.itemOrderList[i] ~= id then orderMatches = false end
	end
	if not orderMatches then
		-- Same items, different order: put the captured order back (in place;
		-- the item list control holds this table).
		local sameItems = true
		for _, id in ipairs(state.itemOrder) do
			if not tab.items[id] then sameItems = false end
		end
		for id in pairs(tab.items) do
			if not keep[id] then sameItems = false end
		end
		if sameItems then
			for i = #tab.itemOrderList, 1, -1 do tab.itemOrderList[i] = nil end
			for i, id in ipairs(state.itemOrder) do tab.itemOrderList[i] = id end
		else
			mismatches[#mismatches + 1] = "item list differs from the snapshot"
		end
	end

	if changed or #removed > 0 then
		tab:PopulateSlots()
		build.buildFlag = true
		runCallback("OnFrame")
	end
	for _, slot in ipairs(tab.orderedSlots) do
		if not slot.nodeId then
			local id = want[slot.slotName] or 0
			if tab.items[id] and (slot.selItemId or 0) ~= id then
				mismatches[#mismatches + 1] = slot.slotName .. " holds item " .. tostring(slot.selItemId) .. ", expected " .. id
			end
		end
	end
	for _, f in ipairs(state.flasks or { }) do
		local slot = tab.slots[f[1]]
		local entry = tab.activeItemSet[slot.slotName]
		if slotChecks.flagCode(slot.active) ~= f[2] or (entry and slotChecks.flagCode(entry.active) ~= f[3]) then
			mismatches[#mismatches + 1] = slot.slotName .. " active state differs from the snapshot"
		end
	end
	local report = { exact = #mismatches == 0 }
	if #mismatches > 0 then
		report.mismatches = mismatches
		STDERR:write("[pob-mcp] warning: item restore is not exact: ", encodeJSON(report), "\n")
	end
	if #removed > 0 then report.removedItemIds = removed end
	return report
end

local function unequipSlot(slotName)
	local slot = slotChecks.usableSlot(slotName, false)
	slot:SetSelItemId(0)
	build.buildFlag = true
	build.itemsTab:PopulateSlots()
	runCallback("OnFrame")
end

local function getAllocatedNodeIds()
	local ids = { }
	if build and build.spec and build.spec.allocNodes then
		for id, _ in pairs(build.spec.allocNodes) do
			table.insert(ids, id)
		end
	end
	return ids
end

local function allocNodeById(nodeId)
	local node = build.spec.nodes[nodeId]
	if not node then
		userError("Unknown node id: " .. tostring(nodeId))
	end
	build.spec:AllocNode(node)
	build.buildFlag = true
	runCallback("OnFrame")
end

local function deallocNodeById(nodeId)
	local node = build.spec.nodes[nodeId]
	if not node then
		userError("Unknown node id: " .. tostring(nodeId))
	end
	build.spec:DeallocNode(node)
	build.buildFlag = true
	runCallback("OnFrame")
end

local function shallowCopy(tbl)
	local out = { }
	for k, v in pairs(tbl or { }) do out[k] = v end
	return out
end

-- Number of declared parameters of a Lua function (including `self` for
-- methods), or nil when it cannot be determined.
local function functionArity(fn)
	if type(fn) ~= "function" or not debug or not debug.getinfo then return nil end
	local ok, info = pcall(debug.getinfo, fn, "u")
	if ok and info and type(info.nparams) == "number" then
		return info.nparams
	end
	return nil
end

-- Replace the allocated passive set with `nodeIds`, keeping class, ascendancy,
-- bloodline, hash overrides, mastery selections and tree version. Prefers
-- PoB's own undo-state API (keyed by field name, so robust to positional
-- signature changes) and falls back to ImportFromNodeList with arity
-- detection. Throws a clear internal error naming the PoB symbol that
-- changed instead of a nil-index trace.
local function restoreTreeFromIds(nodeIds)
	local spec = build.spec
	if type(spec) ~= "table" then
		error("Tree restore failed: build.spec is unavailable (PoB Build module changed?)")
	end
	local hashList = { }
	for _, id in ipairs(nodeIds) do
		hashList[#hashList + 1] = tonumber(id) or id
	end
	local state = {
		classId = spec.curClassId,
		ascendClassId = spec.curAscendClassId,
		secondaryAscendClassId = spec.curSecondaryAscendClassId,
		hashList = hashList,
		hashOverrides = shallowCopy(spec.hashOverrides),
		masteryEffects = shallowCopy(spec.masterySelections),
		treeVersion = spec.treeVersion,
	}
	if state.classId == nil then
		error("Tree restore failed: PassiveSpec.curClassId is missing (PoB PassiveSpec changed)")
	end

	local api, ok, err
	if type(spec.RestoreUndoState) == "function" and type(spec.CreateUndoState) == "function" then
		api = "PassiveSpec:RestoreUndoState"
		ok, err = pcall(spec.RestoreUndoState, spec, state, state.treeVersion)
	elseif type(spec.ImportFromNodeList) == "function" then
		local arity = functionArity(spec.ImportFromNodeList)
		api = "PassiveSpec:ImportFromNodeList/" .. tostring(arity)
		if arity == 9 then
			-- PoB >= 2.66: (self, className, classId, ascendClassId, secondaryAscendClassId, hashList, hashOverrides, masteryEffects, treeVersion)
			ok, err = pcall(spec.ImportFromNodeList, spec, nil, state.classId, state.ascendClassId,
				state.secondaryAscendClassId, hashList, state.hashOverrides, state.masteryEffects, state.treeVersion)
		elseif arity == 8 then
			-- Older PoB: (self, classId, ascendClassId, secondaryAscendClassId, hashList, hashOverrides, masteryEffects, treeVersion)
			ok, err = pcall(spec.ImportFromNodeList, spec, state.classId, state.ascendClassId,
				state.secondaryAscendClassId, hashList, state.hashOverrides, state.masteryEffects, state.treeVersion)
		else
			error("Tree restore failed: unsupported PassiveSpec:ImportFromNodeList signature ("
				.. tostring(arity) .. " params); PoB changed this API")
		end
	else
		error("Tree restore failed: PoB PassiveSpec has neither RestoreUndoState nor ImportFromNodeList")
	end
	if not ok then
		error("Tree restore failed in " .. api .. " (PoB API may have changed): " .. tostring(err))
	end

	build.buildFlag = true
	runCallback("OnFrame")

	-- Report (never fail on) requested nodes PoB did not allocate. This is
	-- legitimate, e.g. nodes supported by an Intuitive Leap-like jewel are
	-- pruned while the tree is restored before that jewel is re-equipped.
	-- Ids PoB does not know (cluster subgraph nodes built later) and masteries
	-- without a selection are not counted.
	local missing = { }
	for _, id in ipairs(hashList) do
		local node = spec.nodes and spec.nodes[id]
		if node and not (spec.allocNodes and spec.allocNodes[id])
			and (node.type ~= "Mastery" or (spec.masterySelections and spec.masterySelections[id])) then
			missing[#missing + 1] = id
		end
	end
	if #missing > 0 then
		local shown = { }
		for i = 1, math.min(#missing, 20) do shown[i] = tostring(missing[i]) end
		STDERR:write("[pob-mcp] warning: tree restore via ", api, " left ", tostring(#missing),
			" node(s) unallocated: ", table.concat(shown, ", "), (#missing > 20 and ", ..." or ""), "\n")
	end
	return missing
end

-- ---------------------------------------------------------------------------
-- Tree version conversion
-- ---------------------------------------------------------------------------

local CONVERT_LIST_CAP = 50

local function listContains(list, value)
	for _, v in pairs(list or { }) do
		if v == value then return true end
	end
	return false
end

-- The version PoB's own "Convert to <latest>" button targets: latestTreeVersion
-- (keeping any suffix the current version already has after it), then
-- ConvertToVersion keeps a ruthless/alternate sub-type when the latest tree
-- has that variant (TreeTab.lua getLatestTreeVersion + ConvertToVersion).
local function latestConvertTarget(curVersion)
	local latest = rawget(_G, "latestTreeVersion")
	if type(latest) ~= "string" or type(curVersion) ~= "string" then
		error("Tree convert failed: latestTreeVersion or the spec's treeVersion is missing (PoB GameVersions changed?)")
	end
	local version = latest .. (curVersion:match("^" .. latest .. "(.*)") or "")
	local subType = curVersion:match("(_%l+_?%l*)")
	if subType and not version:match(subType) and listContains(rawget(_G, "treeVersionList"), version .. subType) then
		version = version .. subType
	end
	return version
end

-- Lua-native copy of everything a spec needs to be rebuilt on any version.
-- Unlike PassiveSpec:CreateUndoState this keeps the secondary ascendancy
-- (CreateUndoState reads a field that does not exist), the title and jewels.
local function captureSpecState(spec)
	local hashList = { }
	for id in pairs(spec.allocNodes or { }) do hashList[#hashList + 1] = id end
	table.sort(hashList)
	return {
		treeVersion = spec.treeVersion,
		title = spec.title,
		classId = spec.curClassId,
		ascendClassId = spec.curAscendClassId,
		secondaryAscendClassId = spec.curSecondaryAscendClassId,
		hashList = hashList,
		masteryEffects = shallowCopy(spec.masterySelections),
		hashOverrides = shallowCopy(spec.hashOverrides),
		jewels = shallowCopy(spec.jewels),
	}
end

local function sortedPairs(map, valueFn)
	local out = { }
	for k, v in pairs(map or { }) do out[#out + 1] = { k, valueFn and valueFn(v) or v } end
	table.sort(out, function(a, b) return a[1] < b[1] end)
	return out
end

-- Override (tattoo) tables seen by encodeSpecState, keyed by tree version,
-- node id and name, so an in-place tree restore can put back the very table
-- PoB had instead of a rebuilt copy. Bounded by the distinct (version, node,
-- tattoo) triples ever captured.
local overrideRegistry = { }
local function overrideKey(treeVersion, nodeId, dn)
	return tostring(treeVersion) .. "\0" .. tostring(nodeId) .. "\0" .. tostring(dn)
end

-- JSON-safe form of a captured state (integer-keyed maps become pair arrays;
-- tattoo overrides are carried by name, the way PassiveSpec:Load reads them).
local function encodeSpecState(state)
	local overrides = { }
	for nodeId, node in pairs(state.hashOverrides or { }) do
		overrides[#overrides + 1] = { nodeId = nodeId, dn = node.dn }
		overrideRegistry[overrideKey(state.treeVersion, nodeId, node.dn)] = node
	end
	table.sort(overrides, function(a, b) return a.nodeId < b.nodeId end)
	return {
		treeVersion = state.treeVersion,
		title = state.title,
		classId = state.classId,
		ascendClassId = state.ascendClassId,
		secondaryAscendClassId = state.secondaryAscendClassId,
		nodeIds = state.hashList,
		masteryEffects = sortedPairs(state.masteryEffects),
		jewels = sortedPairs(state.jewels),
		hashOverrides = overrides,
	}
end

local function decodeIdPairs(list, what)
	local out = { }
	if list == nil then return out end
	if type(list) ~= "table" then error("Tree restore failed: " .. what .. " is not an array") end
	for _, pair in ipairs(list) do
		local k, v = type(pair) == "table" and tonumber(pair[1]), type(pair) == "table" and tonumber(pair[2])
		if not (k and v) then error("Tree restore failed: malformed " .. what .. " entry") end
		out[k] = v
	end
	return out
end

local function decodeSpecState(encoded)
	if type(encoded) ~= "table" or type(encoded.treeVersion) ~= "string" or tonumber(encoded.classId) == nil then
		error("Tree restore failed: malformed spec state")
	end
	local hashList = { }
	for _, id in ipairs(encoded.nodeIds or { }) do
		local n = tonumber(id)
		if not n then error("Tree restore failed: malformed node id") end
		hashList[#hashList + 1] = n
	end
	local overrideNames = { }
	for _, o in ipairs(encoded.hashOverrides or { }) do
		if type(o) == "table" and tonumber(o.nodeId) and type(o.dn) == "string" then
			overrideNames[tonumber(o.nodeId)] = o.dn
		end
	end
	return {
		treeVersion = encoded.treeVersion,
		title = type(encoded.title) == "string" and encoded.title or nil,
		classId = tonumber(encoded.classId),
		ascendClassId = tonumber(encoded.ascendClassId) or 0,
		secondaryAscendClassId = tonumber(encoded.secondaryAscendClassId) or 0,
		hashList = hashList,
		masteryEffects = decodeIdPairs(encoded.masteryEffects, "masteryEffects"),
		jewels = decodeIdPairs(encoded.jewels, "jewels"),
		overrideNames = overrideNames,
	}
end

-- Replace the active spec with a new PassiveSpec on `version` built from
-- `state` (TreeTab:ConvertToVersion with remove=true, minus the popup). Tattoo
-- overrides given by name are looked up in the target tree like
-- PassiveSpec:Load does; ones that tree lacks are dropped and returned.
local function installSpec(version, state)
	local treeTab = build.treeTab
	if not (treeTab and type(treeTab.specList) == "table" and treeTab.activeSpec and type(treeTab.SetActiveSpec) == "function") then
		error("Tree convert failed: build.treeTab spec list is unavailable (PoB TreeTab changed?)")
	end
	local versions = rawget(_G, "treeVersions")
	if type(versions) ~= "table" or not versions[version] then
		error("Tree convert failed: unknown tree version " .. tostring(version))
	end
	local newSpec = construct("PassiveSpec", build, version)
	newSpec.title = state.title
	newSpec.jewels = shallowCopy(state.jewels)
	local overrides = shallowCopy(state.hashOverrides)
	local droppedOverrides = { }
	for nodeId, dn in pairs(state.overrideNames or { }) do
		local tattoo = newSpec.tree.tattoo and newSpec.tree.tattoo.nodes and newSpec.tree.tattoo.nodes[dn]
		if tattoo then
			overrides[nodeId] = copyTable(tattoo, true)
			overrides[nodeId].id = nodeId
		else
			droppedOverrides[#droppedOverrides + 1] = { nodeId = nodeId, name = dn }
		end
	end
	newSpec:RestoreUndoState({
		classId = state.classId,
		ascendClassId = state.ascendClassId,
		secondaryAscendClassId = state.secondaryAscendClassId,
		hashList = state.hashList,
		hashOverrides = overrides,
		masteryEffects = shallowCopy(state.masteryEffects),
		treeVersion = version,
	}, version)
	newSpec:BuildClusterJewelGraphs()

	-- Swap the spec in. Launch.lua's OnFrame catches errors into promptMsg
	-- instead of throwing, so both channels count as failure; on failure the
	-- previous spec goes back so the build is left exactly as it was.
	local index = treeTab.activeSpec
	local previousSpec = treeTab.specList[index]
	local promptBefore = mainObject.promptMsg
	local function activate(spec)
		treeTab.specList[index] = spec
		treeTab:SetActiveSpec(index)
		if build.spec ~= spec then
			error("TreeTab:SetActiveSpec did not activate the spec (PoB TreeTab changed?)", 0)
		end
		build.buildFlag = true
		runCallback("OnFrame")
		if mainObject.promptMsg ~= promptBefore then
			error(stripColorCodes(tostring(mainObject.promptMsg)):gsub("%s+", " "), 0)
		end
	end
	local ok, err = pcall(activate, newSpec)
	if not ok then
		mainObject.promptMsg = promptBefore
		local restored, restoreErr = pcall(activate, previousSpec)
		if not restored then
			mainObject.promptMsg = promptBefore
			error("Tree change to " .. tostring(version) .. " failed (" .. tostring(err)
				.. ") and restoring the previous tree also failed (" .. tostring(restoreErr) .. "); call reset_build", 0)
		end
		error("Tree change to " .. tostring(version) .. " failed; the previous tree was restored: " .. tostring(err), 0)
	end
	return droppedOverrides
end

-- True when `effectId` is one of the effects the tree offers on that mastery node.
local function nodeOffersMasteryEffect(node, effectId)
	for _, effect in ipairs(node and node.masteryEffects or { }) do
		if effect.effect == effectId then return true end
	end
	return false
end

local function masteryEffectText(spec, effectId)
	local effect = spec.tree and spec.tree.masteryEffects and spec.tree.masteryEffects[effectId]
	if effect and type(effect.sd) == "table" then
		return table.concat(effect.sd, " / ")
	end
	return nil
end

local function cappedList(list)
	local shown = { }
	for i = 1, math.min(#list, CONVERT_LIST_CAP) do shown[i] = list[i] end
	return shown, math.max(0, #list - CONVERT_LIST_CAP)
end

local function countKeys(map)
	local n = 0
	for _ in pairs(map or { }) do n = n + 1 end
	return n
end

-- Move the active spec to the latest tree. Returns { converted = false } when
-- it is already there; otherwise a report of what the conversion lost. The
-- caller takes its undo state (captureSpecState command) before calling this.
local function convertTreeToLatest()
	local oldSpec = build.spec
	if type(oldSpec) ~= "table" or type(oldSpec.treeVersion) ~= "string" then
		error("Tree convert failed: build.spec is unavailable (PoB Build module changed?)")
	end
	local fromVersion = oldSpec.treeVersion
	local toVersion = latestConvertTarget(fromVersion)
	if toVersion == fromVersion then
		return { converted = false, fromVersion = fromVersion, toVersion = toVersion }
	end
	local state = captureSpecState(oldSpec)
	local oldNodes = { }
	for id, node in pairs(oldSpec.allocNodes) do oldNodes[id] = node end
	local oldPoints = oldSpec.CountAllocNodes and oldSpec:CountAllocNodes() or nil

	local overrideNames = { }
	for nodeId, node in pairs(state.hashOverrides) do overrideNames[nodeId] = node.dn end
	local convertState = shallowCopy(state)
	convertState.hashOverrides = { }
	convertState.overrideNames = overrideNames
	local droppedOverrides = installSpec(toVersion, convertState)
	local newSpec = build.spec
	-- Test faults: the engine dies or hangs with the new spec already active.
	if TEST_FAULTS.convertExitsAfterSwap then os.exit(3) end
	if TEST_FAULTS.convertHangsAfterSwap then testFaultStall() end

	local lost, changed = { }, { }
	for _, id in ipairs(state.hashList) do
		local before = oldNodes[id]
		local after = newSpec.allocNodes[id]
		if not after then
			lost[#lost + 1] = { id = id, name = before.dn, type = before.type }
		elseif before.dn ~= after.dn then
			changed[#changed + 1] = { id = id, oldName = before.dn, newName = after.dn }
		end
	end
	local droppedMasteries = { }
	for _, pair in ipairs(sortedPairs(state.masteryEffects)) do
		local nodeId, effectId = pair[1], pair[2]
		-- PoB keeps a selection whose effect exists anywhere on the new tree, even
		-- when that node no longer offers it; count that as dropped too.
		if newSpec.masterySelections[nodeId] ~= effectId or not newSpec.allocNodes[nodeId]
			or not nodeOffersMasteryEffect(newSpec.nodes[nodeId], effectId) then
			local node = oldNodes[nodeId] or oldSpec.nodes[nodeId]
			droppedMasteries[#droppedMasteries + 1] = {
				nodeId = nodeId,
				name = node and node.dn,
				effectId = effectId,
				effect = masteryEffectText(oldSpec, effectId),
			}
		end
	end
	local lostShown, lostOmitted = cappedList(lost)
	local changedShown, changedOmitted = cappedList(changed)
	local masteryShown, masteryOmitted = cappedList(droppedMasteries)
	local tattooShown, tattooOmitted = cappedList(droppedOverrides)
	local newPoints = newSpec.CountAllocNodes and newSpec:CountAllocNodes() or nil
	return {
		converted = true,
		fromVersion = fromVersion,
		toVersion = newSpec.treeVersion,
		allocatedBefore = #state.hashList,
		allocatedAfter = countKeys(newSpec.allocNodes),
		pointsBefore = oldPoints,
		pointsAfter = newPoints,
		lostNodeCount = #lost,
		lostNodes = lostShown,
		lostNodesOmitted = lostOmitted,
		changedNodeCount = #changed,
		changedNodes = changedShown,
		changedNodesOmitted = changedOmitted,
		droppedMasteryCount = #droppedMasteries,
		droppedMasteries = masteryShown,
		droppedMasteriesOmitted = masteryOmitted,
		droppedTattooCount = #droppedOverrides,
		droppedTattoos = tattooShown,
		droppedTattoosOmitted = tattooOmitted,
	}
end

local function restoreSpecState(encoded)
	local state = decodeSpecState(encoded)
	local dropped = installSpec(state.treeVersion, state)
	if #dropped > 0 then
		STDERR:write("[pob-mcp] warning: tree restore could not find ", tostring(#dropped), " tattoo(s) on tree ",
			state.treeVersion, "\n")
	end
end

-- ---------------------------------------------------------------------------
-- Exact tree restore for what-if probes and undo
-- ---------------------------------------------------------------------------

local function sortedKeys(set)
	local out = { }
	for id in pairs(set) do out[#out + 1] = id end
	table.sort(out)
	return out
end

local function socketedJewel(map, nodeId)
	local itemId = map and map[nodeId]
	if itemId == 0 then return nil end
	return itemId
end

-- Every way the active spec differs from a decoded state. Wanted node ids the
-- spec does not know (cluster subgraph nodes whose jewel graph is not built)
-- are `pending`; allocated ids the state does not list are `extra`.
local function treeStateDifferences(spec, state)
	local want = { }
	for _, id in ipairs(state.hashList) do want[id] = true end
	local missing, pending, extra = { }, { }, { }
	for id in pairs(want) do
		if not spec.allocNodes[id] then
			if spec.nodes[id] then missing[id] = true else pending[id] = true end
		end
	end
	for id in pairs(spec.allocNodes) do
		if not want[id] then extra[id] = true end
	end
	local mismatches = { }
	local function check(what, have, wanted)
		if have ~= wanted then
			mismatches[#mismatches + 1] = what .. " is " .. tostring(have) .. ", expected " .. tostring(wanted)
		end
	end
	check("tree version", spec.treeVersion, state.treeVersion)
	check("class", spec.curClassId, state.classId)
	check("ascendancy", spec.curAscendClassId or 0, state.ascendClassId)
	check("secondary ascendancy", spec.curSecondaryAscendClassId or 0, state.secondaryAscendClassId)
	local selections = spec.masterySelections or { }
	local ids = shallowCopy(state.masteryEffects)
	for id in pairs(selections) do ids[id] = true end
	for _, id in ipairs(sortedKeys(ids)) do
		check("mastery " .. id, selections[id], state.masteryEffects[id])
	end
	local overrides = spec.hashOverrides or { }
	ids = shallowCopy(state.overrideNames)
	for id in pairs(overrides) do ids[id] = true end
	for _, id in ipairs(sortedKeys(ids)) do
		check("tattoo on node " .. id, overrides[id] and overrides[id].dn, state.overrideNames[id])
	end
	ids = shallowCopy(state.jewels)
	for id in pairs(spec.jewels or { }) do ids[id] = true end
	for _, id in ipairs(sortedKeys(ids)) do
		check("jewel in socket " .. id, socketedJewel(spec.jewels, id), socketedJewel(state.jewels, id))
	end
	return { missing = sortedKeys(missing), pending = sortedKeys(pending), extra = sortedKeys(extra), mismatches = mismatches }
end

local function treeStateReport(diff, corrected)
	local report = { exact = #diff.missing == 0 and #diff.pending == 0 and #diff.extra == 0 and #diff.mismatches == 0 }
	if #diff.missing > 0 then report.missingNodeIds = diff.missing end
	if #diff.pending > 0 then report.pendingNodeIds = diff.pending end
	if #diff.extra > 0 then report.extraNodeIds = diff.extra end
	if #diff.mismatches > 0 then report.mismatches = diff.mismatches end
	if corrected and #corrected > 0 then report.correctedExtraNodeIds = corrected end
	return report
end

local function verifyTreeState(encoded)
	if type(build.spec) ~= "table" then
		error("Tree verify failed: build.spec is unavailable (PoB Build module changed?)")
	end
	return treeStateReport(treeStateDifferences(build.spec, decodeSpecState(encoded)))
end

-- Override tables for a same-version restore: the exact table captured
-- earlier when known, else the named tattoo from this tree (as
-- PassiveSpec:Load does). Unresolvable ones are left out and show up as a
-- mismatch in the report.
local function resolveOverrides(spec, overrideNames)
	local overrides = { }
	for nodeId, dn in pairs(overrideNames) do
		local key = overrideKey(spec.treeVersion, nodeId, dn)
		local node = overrideRegistry[key]
		if not node then
			local tattoo = spec.tree and spec.tree.tattoo and spec.tree.tattoo.nodes and spec.tree.tattoo.nodes[dn]
			if tattoo then
				node = copyTable(tattoo, true)
				node.id = nodeId
				overrideRegistry[key] = node
			end
		end
		overrides[nodeId] = node
	end
	return overrides
end

-- Put the socketed jewels back (they live on the spec in PoB) before the node
-- list is applied: Intuitive Leap-like support and cluster graphs come from
-- them. Ids are restored as captured, even ones whose item no longer exists
-- (PoB's own TreeTab:SetActiveSpec does the same and its tree code skips
-- them), so a snapshot compares equal to the state it was taken from.
-- Returns true when anything changed.
local function restoreSpecJewels(spec, wanted)
	local jewels = shallowCopy(wanted)
	local changed = false
	for nodeId in pairs(jewels) do
		if socketedJewel(spec.jewels, nodeId) ~= socketedJewel(jewels, nodeId) then changed = true end
	end
	for nodeId in pairs(spec.jewels or { }) do
		if socketedJewel(spec.jewels, nodeId) ~= socketedJewel(jewels, nodeId) then changed = true end
	end
	if not changed then return false end
	-- Updated in place: PassiveSpec:Save writes <Sockets> in this table's
	-- iteration order, which a fresh table would reshuffle.
	if type(spec.jewels) ~= "table" then spec.jewels = { } end
	for nodeId in pairs(spec.jewels) do
		if jewels[nodeId] == nil then spec.jewels[nodeId] = nil end
	end
	for nodeId, itemId in pairs(jewels) do spec.jewels[nodeId] = itemId end
	for nodeId, slot in pairs(build.itemsTab and build.itemsTab.sockets or { }) do
		slot.selItemId = jewels[nodeId] or 0
	end
	return true
end

-- Replace the active tree with a captured spec state (captureSpecState):
-- nodes, masteries, tattoos, class, ascendancies, jewels and tree version.
-- Same version: restored in place through PassiveSpec:RestoreUndoState,
-- feeding it the captured masteries and tattoos (not the current ones).
-- Other version: the spec is rebuilt (restoreSpecState). Afterwards the result
-- is compared with the state; nodes PoB re-allocated on its own (cluster
-- nodes ImportFromNodeList re-allocates from allocExtendedNodes) are
-- deallocated, dropped from allocExtendedNodes (so only the first restore
-- after such a node's deallocation has to correct it) and listed in
-- correctedExtraNodeIds, and anything still different is reported.
local function restoreTreeState(encoded)
	local spec = build.spec
	if type(spec) ~= "table" or type(spec.RestoreUndoState) ~= "function" then
		error("Tree restore failed: build.spec or PassiveSpec:RestoreUndoState is unavailable (PoB changed?)")
	end
	local state = decodeSpecState(encoded)
	local before = state.treeVersion == spec.treeVersion and treeStateDifferences(spec, state)
	local jewelsOnly = before and #before.missing == 0 and #before.pending == 0 and #before.extra == 0
		and #before.mismatches > 0
	if jewelsOnly then
		for _, text in ipairs(before.mismatches) do
			if not text:find("^jewel in socket ") then jewelsOnly = false end
		end
	end
	if jewelsOnly then
		-- Only socketed jewels differ (an item probe on a jewel socket): put
		-- them back without re-importing the node list, which would reshuffle
		-- PoB's allocNodes table and so the order of the saved node list.
		restoreSpecJewels(spec, state.jewels)
		spec:BuildClusterJewelGraphs()
		if build.itemsTab.PopulateSlots then build.itemsTab:PopulateSlots() end
		local diff = treeStateDifferences(spec, state)
		if #diff.missing == 0 and #diff.pending == 0 and #diff.extra == 0 and #diff.mismatches == 0 then
			build.buildFlag = true
			runCallback("OnFrame")
			return treeStateReport(diff)
		end
		-- Something else moved with the jewels: fall through to the full restore.
	end
	if state.treeVersion ~= spec.treeVersion then
		restoreSpecState(encoded)
		spec = build.spec
	else
		local jewelsChanged = restoreSpecJewels(spec, state.jewels)
		local ok, err = pcall(spec.RestoreUndoState, spec, {
			classId = state.classId,
			ascendClassId = state.ascendClassId,
			secondaryAscendClassId = state.secondaryAscendClassId,
			hashList = state.hashList,
			hashOverrides = resolveOverrides(spec, state.overrideNames),
			masteryEffects = shallowCopy(state.masteryEffects),
			treeVersion = state.treeVersion,
		}, state.treeVersion)
		if not ok then
			error("Tree restore failed in PassiveSpec:RestoreUndoState (PoB API may have changed): " .. tostring(err))
		end
		-- ImportFromNodeList only queues cluster subgraph nodes (allocSubgraphNodes);
		-- a graph rebuild allocates them. Needed when the jewels changed, and when
		-- wanted subgraph nodes are still missing: a Large socket that was
		-- deallocated (its subgraph dropped) with its jewel kept, as undoing
		-- deallocate_nodes on the socket does.
		if jewelsChanged or #treeStateDifferences(spec, state).pending > 0 then
			spec:BuildClusterJewelGraphs()
			if build.itemsTab.PopulateSlots then build.itemsTab:PopulateSlots() end
		end
	end

	local diff = treeStateDifferences(spec, state)
	local corrected = { }
	if #diff.extra > 0 then
		local extended = { }
		for _, id in ipairs(diff.extra) do
			local node = spec.allocNodes[id]
			if node and node.type ~= "ClassStart" and node.type ~= "AscendClassStart" then
				spec:DeallocSingleNode(node)
				extended[id] = true
				corrected[#corrected + 1] = id
			end
		end
		if type(spec.allocExtendedNodes) == "table" then
			for i = #spec.allocExtendedNodes, 1, -1 do
				if extended[spec.allocExtendedNodes[i]] then table.remove(spec.allocExtendedNodes, i) end
			end
		end
		spec:BuildAllDependsAndPaths()
		diff = treeStateDifferences(spec, state)
	end
	build.buildFlag = true
	runCallback("OnFrame")
	local report = treeStateReport(diff, corrected)
	if not report.exact then
		STDERR:write("[pob-mcp] warning: tree restore is not exact: ", encodeJSON(report), "\n")
	end
	return report
end

-- The config tables of the active config set. PoB keeps `input` and
-- `placeholder` both on the config set and as configTab.input /
-- configTab.placeholder (the same tables; older PoB has no config sets).
-- PoB 2.67's ConfigTab:Save writes them with pairs(), so their iteration
-- order is part of the export: a key added and removed again can resize the
-- table and reorder it. What-ifs therefore never write to these tables: they
-- swap in copies and later put the very same objects back. (One table of
-- functions: the main chunk is at Lua's limit of 200 locals.)
-- `remembered` holds, by a token the caller chose, the committed tables a
-- change replaced with copies (a probe fallback, apply_changes), untouched
-- since: only the restore sent with that token (the fallback's restore, the
-- rollback or undo of that apply_changes) puts those very tables back, and
-- it forgets them. A plain table holding at most MAX_REMEMBERED entries
-- (oldest dropped: its restore then writes by value), emptied when a build
-- is loaded, so nothing outlives the build it belongs to.
local ConfigTables = { remembered = { }, rememberedOrder = { }, MAX_REMEMBERED = 64 }
do
	local function current()
		local configTab = build.configTab
		local set = configTab.configSets and configTab.activeConfigSetId and configTab.configSets[configTab.activeConfigSetId]
		return { input = configTab.input, placeholder = configTab.placeholder, set = set,
			setInput = set and set.input, setPlaceholder = set and set.placeholder }
	end

	local function attach(t)
		local configTab = build.configTab
		configTab.input, configTab.placeholder = t.input, t.placeholder
		if t.set then t.set.input, t.set.placeholder = t.setInput, t.setPlaceholder end
	end

	local function shallowCopy(t)
		local out = { }
		for k, v in pairs(t or { }) do out[k] = v end
		return out
	end

	ConfigTables.current = current
	ConfigTables.attach = attach

	-- Installs copies of the `orig` config tables (with `changes` applied to
	-- the input copy).
	local function attachCopies(orig, changes)
		local input, placeholder = shallowCopy(orig.input), shallowCopy(orig.placeholder)
		for key, value in pairs(changes or { }) do input[key] = value end
		attach({ input = input, placeholder = placeholder, set = orig.set, setInput = input, setPlaceholder = placeholder })
	end

	-- Installs copies of the active config tables (with `changes` applied to
	-- the input copy) and returns the originals, untouched, for restore.
	function ConfigTables.detach(changes)
		local orig = current()
		attachCopies(orig, changes)
		return orig
	end

	-- Puts the original config tables back and rebuilds the config mod list
	-- (and the config controls, which BuildModList also sets) from them.
	-- BuildModList writes placeholders and the boss damage type into its
	-- tables, so it runs on copies of them: the originals are never written
	-- and keep their iteration order.
	function ConfigTables.restore(orig)
		attachCopies(orig, nil)
		local ok, err = pcall(function() build.configTab:BuildModList() end)
		attach(orig)
		if not ok then error(err, 0) end
	end

	-- True when a live config value and a snapshot value (which came back
	-- through JSON, so a number may be rounded to 14 significant digits) are
	-- the same.
	function ConfigTables.sameValue(live, snap)
		if live == snap then return true end
		if type(live) ~= "number" or type(snap) ~= "number" then return false end
		return math.abs(live - snap) <= 1e-12 * math.max(math.abs(live), math.abs(snap))
	end

	-- True when `input` holds the values of `snapshot` (by value).
	function ConfigTables.sameInput(input, snapshot)
		local n = 0
		for key, value in pairs(input) do
			local v = copyValue(value)
			if v == nil or not ConfigTables.sameValue(v, snapshot[key]) then return false end
			n = n + 1
		end
		for _ in pairs(snapshot) do n = n - 1 end
		return n == 0
	end

	-- probeCommit and apply_changes swapped in copies (`detached` is their
	-- input table) for the committed tables `orig`: restoreInput with `token`
	-- puts orig back instead of writing to the copies. No token: nothing is
	-- remembered.
	function ConfigTables.stashCommitted(token, orig, detached)
		if type(token) ~= "string" then return end
		local order = ConfigTables.rememberedOrder
		if ConfigTables.remembered[token] == nil then order[#order + 1] = token end
		ConfigTables.remembered[token] = { orig = orig, detached = detached }
		while #order > ConfigTables.MAX_REMEMBERED do
			ConfigTables.remembered[table.remove(order, 1)] = nil
		end
	end

	-- Returns the entry of `token` and forgets it.
	function ConfigTables.takeRemembered(token)
		local entry = token and ConfigTables.remembered[token]
		if not entry then return nil end
		ConfigTables.remembered[token] = nil
		for i, t in ipairs(ConfigTables.rememberedOrder) do
			if t == token then table.remove(ConfigTables.rememberedOrder, i) break end
		end
		return entry
	end

	function ConfigTables.forgetAll()
		ConfigTables.remembered, ConfigTables.rememberedOrder = { }, { }
	end
end

function ConfigTables.fullInput()
	local result = { }
	if build.configTab and build.configTab.input then
		for key, value in pairs(build.configTab.input) do
			result[key] = copyValue(value)
		end
	end
	return result
end

-- set_config undo and the full snapshot restore (restoreConfig). `token`:
-- the restore a probe fallback or apply_changes remembered tables for.
function ConfigTables.restoreInput(input, token)
	if not (build.configTab and build.configTab.input) then
		error("Config tab not available")
	end
	input = input or { }
	local entry = ConfigTables.takeRemembered(token)
	local live = ConfigTables.current()
	if entry and entry.detached == live.input and entry.orig.set == live.set and ConfigTables.sameInput(entry.orig.input, input) then
		-- The live tables are still the copies swapped in for the remembered
		-- ones, which hold exactly the target values: those tables, never
		-- written since, go back; the copies are dropped.
		ConfigTables.attach(entry.orig)
	end
	local current = ConfigTables.current()
	if ConfigTables.sameInput(current.input, input) then
		-- Nothing to change (a restore after a fallback variant, or after a
		-- non-config change): rebuild the mod list without writing to the
		-- tables, so their values and order stay.
		ConfigTables.restore(current)
	else
		-- Change only the keys that differ (set_config undo); a value equal
		-- but for JSON rounding is left as it is.
		local target = current.input
		for key in pairs(target) do
			if input[key] == nil then target[key] = nil end
		end
		for key, value in pairs(input) do
			if not ConfigTables.sameValue(target[key], value) then target[key] = value end
		end
		build.configTab:BuildModList()
	end
	build.buildFlag = true
	runCallback("OnFrame")
end

local function exportBuildXML()
	local xml = build:SaveDB("mcp-export")
	if not xml then
		error("SaveDB returned no XML")
	end
	return xml
end

-- Cached list of config variable definitions, loaded lazily from
-- Modules/ConfigOptions. Each entry has at minimum { var, type, label,
-- section?, list? }. We strip non-serializable fields (apply, tooltipFunc).
local _configMetadata = nil
local function getConfigMetadata()
	if _configMetadata then return _configMetadata end
	local ok, varList = pcall(LoadModule, "Modules/ConfigOptions")
	if not ok or type(varList) ~= "table" then
		_configMetadata = { }
		return _configMetadata
	end
	local out = { }
	local currentSection = "Other"
	for _, entry in ipairs(varList) do
		if entry.section and not entry.var then
			-- Section header — remember and continue
			currentSection = entry.section
		elseif entry.var then
			local meta = {
				var = entry.var,
				type = entry.type or "check",
				label = (entry.label or ""):gsub("^%^%w", ""):gsub("%^%w", ""):gsub(":+$", ""),
				section = currentSection,
				ifMult = entry.ifMult,
				ifFlag = entry.ifFlag,
				ifCond = entry.ifCond,
				ifEnemyCond = entry.ifEnemyCond,
				ifSkill = entry.ifSkill,
				ifSkillFlag = entry.ifSkillFlag,
				ifSkillData = entry.ifSkillData,
				ifSkillList = entry.ifSkillList,
				ifNode = entry.ifNode,
				ifOption = entry.ifOption,
				ifVer = entry.ifVer,
				defaultIndex = entry.defaultIndex,
				defaultState = entry.defaultState,
			}
			if type(entry.list) == "table" then
				local choices = { }
				for i, choice in ipairs(entry.list) do
					if type(choice) == "table" then
						choices[i] = { val = choice.val, label = choice.label }
					else
						choices[i] = { val = choice, label = tostring(choice) }
					end
				end
				meta.list = choices
			end
			table.insert(out, meta)
		end
	end
	_configMetadata = out
	return out
end

local function describeGem(gemInstance)
	if not gemInstance then return nil end
	return {
		nameSpec = gemInstance.nameSpec,
		gemId = gemInstance.gemId,
		skillId = gemInstance.skillId,
		level = gemInstance.level,
		quality = gemInstance.quality,
		enabled = gemInstance.enabled ~= false,
		count = gemInstance.count or 1,
	}
end

local function getSkillBreakdown(skillIndex)
	if not (build.skillsTab and build.skillsTab.socketGroupList) then
		error("Skills tab not available")
	end
	local list = build.skillsTab.socketGroupList
	local index = skillIndex
	if index == nil or index < 1 then
		index = build.mainSocketGroup or 1
	end
	local group = list[index]
	if not group then
		userError("No socket group at index " .. tostring(index))
	end

	local gems = { }
	local activeGem = nil
	for _, gemInstance in ipairs(group.gemList or { }) do
		local desc = describeGem(gemInstance)
		if desc then
			-- Tag whether this gem grants an active skill (not a support)
			local isActive = false
			if gemInstance.gemData and gemInstance.gemData.grantedEffect then
				isActive = not gemInstance.gemData.grantedEffect.support
			elseif gemInstance.grantedEffect then
				isActive = not gemInstance.grantedEffect.support
			end
			desc.isActive = isActive
			if isActive and not activeGem then
				activeGem = desc
			end
			table.insert(gems, desc)
		end
	end

	-- Pump the engine so mainOutput reflects current state
	pumpAndRead()
	local isMainGroup = (build.mainSocketGroup == index)
	local stats = nil
	if isMainGroup then
		local out = build.calcsTab and build.calcsTab.mainOutput or { }
		local statKeysLocal = {
			"CombinedDPS", "TotalDPS", "TotalDot", "AverageDamage", "WithBleedDPS",
			"WithPoisonDPS", "WithIgniteDPS", "ImpaleDPS", "ManaCost",
			"Speed", "HitSpeed", "HitChance", "CritChance", "CritMultiplier",
			"PreEffectiveCritChance", "ServerTriggerRate",
		}
		stats = { }
		for _, key in ipairs(statKeysLocal) do
			stats[key] = copyValue(out[key])
		end
	end

	return {
		index = index,
		label = group.displayLabel or group.label,
		slot = group.slot,
		enabled = group.enabled ~= false,
		source = group.source,
		mainActiveSkill = group.mainActiveSkill,
		isMainGroup = isMainGroup,
		activeGem = activeGem,
		gems = gems,
		stats = stats,
	}
end

local function copyStats(sd)
	local out = { }
	if type(sd) == "table" then
		for _, line in ipairs(sd) do
			if type(line) == "string" then
				table.insert(out, line)
			end
		end
	end
	return out
end

local function describeTreeNode(node, includeStats)
	if not node then return nil end
	local desc = {
		id = node.id,
		name = node.dn,
		type = node.type,
		isKeystone = node.type == "Keystone",
		isNotable = node.type == "Notable",
		isJewelSocket = node.type == "Socket",
		isMastery = node.type == "Mastery",
		isAscendancy = node.ascendancyName ~= nil,
		ascendancyName = node.ascendancyName,
		alloc = node.alloc and true or false,
	}
	if node.type == "Mastery" and node.alloc and build.spec.masterySelections then
		-- The chosen effect's id (get_passive_tree's `masteries` lists the options).
		desc.effect = build.spec.masterySelections[node.id]
	end
	if includeStats then
		desc.stats = copyStats(node.sd)
	end
	return desc
end

local function getAllocatedNodesDetailed()
	local result = { }
	if not (build and build.spec and build.spec.allocNodes) then
		return result
	end
	for id, node in pairs(build.spec.allocNodes) do
		table.insert(result, describeTreeNode(node, true))
	end
	return result
end

local function getReachableNodesList()
	local result = { }
	if not (build and build.spec and build.spec.nodes and build.spec.allocNodes) then
		return result
	end
	for id, node in pairs(build.spec.nodes) do
		if not build.spec.allocNodes[id]
			and not node.ascendancyName
			and node.type ~= "ClassStart"
			and node.type ~= "AscendClassStart"
			and node.type ~= "Mastery" then
			local adjacent = false
			if node.linked then
				for _, other in ipairs(node.linked) do
					if other.alloc then
						adjacent = true
						break
					end
				end
			end
			if adjacent then
				table.insert(result, describeTreeNode(node, true))
			end
		end
	end
	return result
end

local function findNodeByName(name)
	if not (build and build.spec and build.spec.nodes) or type(name) ~= "string" then
		return nil
	end
	local target = name:lower()
	for id, node in pairs(build.spec.nodes) do
		if node.dn and node.dn:lower() == target then
			return node
		end
	end
	return nil
end

local function getNodeInfo(arg)
	local node
	if arg.nodeId then
		node = build.spec.nodes[arg.nodeId]
	elseif arg.name then
		node = findNodeByName(arg.name)
	end
	if not node then
		return nil
	end
	local info = describeTreeNode(node, true)
	info.linked = { }
	if node.linked then
		for _, other in ipairs(node.linked) do
			table.insert(info.linked, other.id)
		end
	end
	return info
end

-- Node batches are all-or-nothing: every id is checked against the current
-- tree before the first node changes, so a user error leaves the build
-- untouched (and its export byte-identical).
local function nodeLabel(node)
	return tostring(node.id) .. (node.dn and (" (" .. node.dn .. ")") or "")
end

local function batchNodes(nodeIds)
	if type(nodeIds) ~= "table" then
		userError("nodeIds must be an array of node ids")
	end
	local nodes = { }
	for i, id in ipairs(nodeIds) do
		local node = type(id) == "number" and build.spec.nodes[id] or nil
		if not node then
			userError("Unknown node id: " .. tostring(id))
		end
		nodes[i] = node
	end
	return nodes
end

-- Run a batch mutation; if it fails part-way (something the checks could not
-- foresee), put the tree back as it was before the batch and re-raise. A
-- rollback that throws or does not reproduce the tree is an internal error.
local function withTreeRollback(fn)
	local before = encodeSpecState(captureSpecState(build.spec))
	local ok, err = pcall(function()
		fn()
		if TEST_FAULTS.batchFailsAfterChange then userError("test fault: batch failed after changing the tree") end
	end)
	if ok then return end
	local target = before
	if TEST_FAULTS.treeRollbackInexact then
		-- Roll back to the state minus one Normal node, so the result differs.
		target = shallowCopy(before)
		target.nodeIds = { }
		local dropped = false
		for _, id in ipairs(before.nodeIds) do
			local node = build.spec.nodes[id]
			if not dropped and node and node.type == "Normal" then dropped = true else target.nodeIds[#target.nodeIds + 1] = id end
		end
	end
	local restored, report = pcall(function()
		if TEST_FAULTS.treeRollbackThrows then error("test fault: tree rollback threw", 0) end
		restoreTreeState(target)
		return verifyTreeState(before)
	end)
	if not restored then
		failedRecoveryError(err, "rolling the passive tree back", report)
	end
	if not report.exact then
		failedRecoveryError(err, "rolling the passive tree back", "the tree is not as before: " .. encodeJSON(report))
	end
	error(err, 0)
end

-- Helpers of the node batches below, in one table (the main chunk is close
-- to LuaJIT's limit of 200 locals).
local nodeBatch = { }

-- `strict` (allocate_nodes / deallocate_nodes) also refuses a repeated id
-- and, when allocating, a mastery given without an effect (masteries are
-- allocated through `masteries`, nodeBatch.resolveMasteries) or a node that
-- is already allocated.
function nodeBatch.strictChecks(nodes, allocating)
	local seen = { }
	for _, node in ipairs(nodes) do
		if seen[node.id] then
			userError("Node " .. nodeLabel(node) .. " is listed more than once")
		end
		seen[node.id] = true
		if allocating and node.type == "Mastery" then
			userError(nodeBatch.masteryInNodes(node))
		end
		if allocating and node.alloc then
			userError("Node " .. nodeLabel(node) .. " is already allocated")
		end
	end
end

-- What a node batch reports about a node, captured while the node object is
-- current: rebuilding the cluster jewel graphs (allocating or deallocating a
-- socket holding a cluster jewel) drops subgraph nodes from spec.nodes and
-- replaces their objects. `pointCost` follows PassiveSpec:CountAllocNodes:
-- class starts and ascendancy choice options cost nothing.
function nodeBatch.describe(node)
	local cost = "passive"
	if node.type == "ClassStart" or node.type == "AscendClassStart" then
		cost = "none"
	elseif node.ascendancyName then
		cost = node.isMultipleChoiceOption and "none" or "ascendancy"
	end
	return { id = node.id, name = node.dn, type = node.type, ascendancyName = node.ascendancyName, pointCost = cost }
end

-- Descriptions of every allocated node, by id.
function nodeBatch.captureAllocated()
	local set = { }
	for id, node in pairs(build.spec.allocNodes) do set[id] = nodeBatch.describe(node) end
	return set
end

-- Nodes allocated before (`before`, from captureAllocated) and not now, by id.
function nodeBatch.lostSince(before)
	local ids = { }
	for id in pairs(before) do
		if not build.spec.allocNodes[id] then ids[#ids + 1] = id end
	end
	table.sort(ids)
	local lost = { }
	for i, id in ipairs(ids) do lost[i] = before[id] end
	return lost
end

-- ---------------------------------------------------------------------------
-- Masteries. A mastery is allocated together with the effect chosen on it
-- (PoB's TreeTab:SaveMasteryPopup: spec.masterySelections[id] = effect, then
-- AllocNode); PassiveSpec:BuildAllDependsAndPaths gives an allocated mastery
-- its effect's stats and drops a selection on a mastery that is not
-- allocated, so a selection is set right before its node is allocated
-- (allocNodesBatch). An allocated mastery changes effect by a new selection
-- and a rebuild. Each effect can be chosen on one mastery only (PoB's mastery
-- popup leaves out effects chosen elsewhere).
-- ---------------------------------------------------------------------------

nodeBatch.MAX_MASTERIES = 20
nodeBatch.MAX_LISTED = 12

function nodeBatch.masteryInNodes(node)
	return "Node " .. nodeLabel(node) .. " is a mastery; pass it in `masteries` as { node, effect } "
		.. "(get_passive_tree with `masteries` lists its effects)"
end

-- Passive points of the path that allocating `node` would add.
function nodeBatch.pathPoints(node)
	local n = 0
	for _, pathNode in ipairs(node.path or { }) do
		if not pathNode.ascendancyName and pathNode.type ~= "ClassStart" and pathNode.type ~= "AscendClassStart" then n = n + 1 end
	end
	return n
end

-- The mastery nodes named `name` (case-insensitive), allocated ones first,
-- then by path points, then by id.
function nodeBatch.masteriesNamed(name)
	local target, out = name:lower(), { }
	for _, node in pairs(build.spec.nodes) do
		if node.type == "Mastery" and node.dn and node.dn:lower() == target then out[#out + 1] = node end
	end
	table.sort(out, function(a, b)
		if (a.alloc and true or false) ~= (b.alloc and true or false) then return a.alloc and true or false end
		local pa, pb = nodeBatch.pathPoints(a), nodeBatch.pathPoints(b)
		if pa ~= pb then return pa < pb end
		return a.id < b.id
	end)
	return out
end

function nodeBatch.reachable(node)
	return node.alloc or (node.path ~= nil and #node.path > 0)
end

function nodeBatch.describeMasteryCandidate(node)
	if node.alloc then
		return tostring(node.id) .. " (allocated, effect " .. tostring(build.spec.masterySelections[node.id]) .. ")"
	end
	if not nodeBatch.reachable(node) then return tostring(node.id) .. " (unallocated, no path)" end
	local points = nodeBatch.pathPoints(node)
	return tostring(node.id) .. " (unallocated, " .. points .. " point" .. (points == 1 and "" or "s") .. " away)"
end

-- A mastery node by id or name. Masteries share names ("Life Mastery"), so a
-- name resolves in steps: among the allocated masteries of that name, the one
-- that has `effectRef` chosen already, else the only allocated one (an effect
-- switch); with none allocated, the only unallocated one a path reaches.
-- Anything else (several allocated ones, none with that effect; several
-- reachable unallocated ones) is refused with their ids. To allocate another
-- mastery of a name that is allocated already, pass its id.
function nodeBatch.masteryNode(ref, label, effectRef)
	local spec = build.spec
	if type(ref) == "number" then
		local node = spec.nodes[ref]
		if not node then userError(label .. ": unknown node id " .. tostring(ref)) end
		if node.type ~= "Mastery" then userError(label .. ": node " .. nodeLabel(node) .. " is not a mastery") end
		return node
	end
	if type(ref) ~= "string" or ref == "" then userError(label .. ": node must be a node id or a mastery name") end
	local all = nodeBatch.masteriesNamed(ref)
	if #all == 0 then userError(label .. ": no mastery named \"" .. ref .. "\"") end
	local allocated, usable = { }, { }
	for _, node in ipairs(all) do
		if node.alloc then allocated[#allocated + 1] = node end
		if nodeBatch.reachable(node) then usable[#usable + 1] = node end
	end
	if #allocated > 0 then
		if effectRef ~= nil then
			-- The effect, as the masteries of this name offer it (they share their options).
			local ok, effect = pcall(nodeBatch.masteryEffect, allocated[1], effectRef, label)
			for _, node in ipairs(ok and allocated or { }) do
				if spec.masterySelections[node.id] == effect then return node end
			end
		end
		if #allocated == 1 then return allocated[1] end
		usable = allocated
	end
	local pick = #usable > 0 and usable or all
	if #pick == 1 then return pick[1] end
	local listed = { }
	for i = 1, math.min(#pick, nodeBatch.MAX_LISTED) do listed[i] = nodeBatch.describeMasteryCandidate(pick[i]) end
	userError(label .. ": mastery name \"" .. ref .. "\" matches " .. #pick .. " nodes: " .. table.concat(listed, ", ")
		.. (#pick > #listed and (" and " .. (#pick - #listed) .. " more") or "") .. ". Pass the node id instead.")
end

-- The effects a mastery node offers, as { effect = id, stats = text }.
function nodeBatch.masteryEffectList(node)
	local out = { }
	for _, effect in ipairs(node.masteryEffects or { }) do
		out[#out + 1] = { effect = effect.effect, stats = masteryEffectText(build.spec, effect.effect)
			or table.concat(effect.stats or { }, " / ") }
	end
	return out
end

-- An effect of `node` by id or by text: the whole effect text or one of its
-- lines (case-insensitive), else a part of its text that only one effect has.
function nodeBatch.masteryEffect(node, ref, label)
	local effects = nodeBatch.masteryEffectList(node)
	local function options()
		local shown = { }
		for i, e in ipairs(effects) do shown[i] = tostring(e.effect) .. ": " .. e.stats end
		return " Its effects: " .. table.concat(shown, "; ")
	end
	if type(ref) == "number" then
		if not nodeOffersMasteryEffect(node, ref) then
			userError(label .. ": mastery " .. nodeLabel(node) .. " does not offer effect " .. tostring(ref) .. "." .. options())
		end
		return ref
	end
	if type(ref) ~= "string" or ref:match("^%s*$") then userError(label .. ": effect must be an effect id or its text") end
	local want = ref:lower():match("^%s*(.-)%s*$")
	local partial = { }
	for _, e in ipairs(effects) do
		local text = e.stats:lower()
		if text == want then return e.effect end
		for line in (text .. " / "):gmatch("(.-) / ") do
			if line == want then return e.effect end
		end
		if text:find(want, 1, true) then partial[#partial + 1] = e.effect end
	end
	if #partial == 1 then return partial[1] end
	userError(label .. ": " .. (#partial > 1 and ("effect text \"" .. ref .. "\" matches " .. #partial .. " effects of mastery ")
		or ("no effect of mastery ")) .. nodeLabel(node) .. (#partial > 1 and "; pass the effect id." or (" matches \"" .. ref .. "\".")) .. options())
end

-- Resolve and check a list of { node, effect } entries (user errors before
-- any change). Returns { { node, id, effect } ... } in order. `opts.replay`
-- (a crash replay of a committed change: node and effect are ids that were
-- checked when the change was made) only resolves the ids. `opts.skip` (ids)
-- are nodes the same change lists elsewhere, refused as listed twice;
-- `opts.removed` (ids) are allocated nodes the same change deallocates (a
-- deallocated node's dependents among them): a mastery among them is
-- refused, since the change would remove it and re-allocate it with a path.
-- Each entry carries `noop` when the mastery is allocated with that effect.
function nodeBatch.resolveMasteries(entries, opts)
	opts = opts or { }
	if entries == nil then return { } end
	if type(entries) ~= "table" then userError("masteries must be an array of { node, effect }") end
	if #entries > nodeBatch.MAX_MASTERIES then
		userError("masteries has " .. #entries .. " entries; at most " .. nodeBatch.MAX_MASTERIES .. " are allowed")
	end
	local spec = build.spec
	local out, seen, byEffect = { }, { }, { }
	for i, entry in ipairs(entries) do
		local label = "masteries[" .. i .. "]"
		if type(entry) ~= "table" or entry.node == nil or entry.effect == nil then
			userError(label .. " must be { node, effect }")
		end
		local node = nodeBatch.masteryNode(entry.node, label, not opts.replay and entry.effect or nil)
		local effect = opts.replay and tonumber(entry.effect) or nodeBatch.masteryEffect(node, entry.effect, label)
		if not opts.replay then
			if seen[node.id] or (opts.skip and opts.skip[node.id]) then userError("Node " .. nodeLabel(node) .. " is listed twice") end
			if opts.removed and opts.removed[node.id] then
				userError(label .. ": mastery " .. nodeLabel(node) .. " is removed by this change's deallocation (it depends on a "
					.. "deallocated node); deallocate it too, or keep the node it depends on")
			end
			if spec.hashOverrides and spec.hashOverrides[node.id] then
				userError(label .. ": mastery " .. nodeLabel(node) .. " carries a tattoo or runegraft; its effect cannot be chosen")
			end
			if not nodeBatch.reachable(node) then
				userError("Node " .. nodeLabel(node) .. " cannot be allocated: no path from the allocated tree reaches it")
			end
			if byEffect[effect] then
				userError(label .. ": effect " .. effect .. " is also chosen for mastery " .. nodeLabel(byEffect[effect])
					.. " in this change; each mastery effect can be chosen on one mastery only")
			end
		end
		seen[node.id] = true
		byEffect[effect] = node
		out[#out + 1] = { node = node, id = node.id, effect = effect,
			noop = (node.alloc and spec.masterySelections[node.id] == effect) and true or nil }
	end
	if not opts.replay then
		-- Taken on a mastery this change leaves alone (PoB's mastery popup
		-- does not offer an effect chosen on another mastery).
		for otherId, effect in pairs(spec.masterySelections or { }) do
			local mine = byEffect[effect]
			if mine and mine.id ~= otherId and not seen[otherId] then
				local other = spec.nodes[otherId]
				userError("Effect " .. effect .. " (" .. tostring(masteryEffectText(spec, effect)) .. ") is already chosen on mastery "
					.. (other and nodeLabel(other) or tostring(otherId)) .. "; each mastery effect can be chosen on one mastery only")
			end
		end
	end
	return out
end

-- What a committed mastery change reports: { id, name, effect, stats, previousEffect? }.
function nodeBatch.describeMastery(id, previous)
	local spec = build.spec
	local node = spec.nodes[id]
	local effect = spec.masterySelections[id]
	return { id = id, name = node and node.dn, effect = effect, stats = effect and masteryEffectText(spec, effect),
		previousEffect = previous }
end

-- True when every mastery entry is a no-op (allocated with that effect already).
function nodeBatch.allNoop(masteries)
	for _, m in ipairs(masteries) do
		if not m.noop then return false end
	end
	return true
end

-- A change that changes nothing (only no-op mastery entries): no rebuild, no
-- recalculation, and the caller pushes no undo entry or journal record.
function nodeBatch.unchanged(masteries)
	local out = { }
	for i, m in ipairs(masteries) do out[i] = nodeBatch.describeMastery(m.id, m.effect) end
	return { added = { }, removed = { }, masteries = out, unchanged = true }
end

-- get_passive_tree's `masteries`: each referenced mastery (a name lists
-- every mastery of that name, allocated ones first, at most MAX_LISTED) with
-- its effects; `takenBy` names another mastery that has an effect chosen.
function nodeBatch.masteryOptions(refs)
	if type(refs) ~= "table" then userError("masteries must be an array of node ids or mastery names") end
	if #refs > nodeBatch.MAX_MASTERIES then
		userError("masteries has " .. #refs .. " entries; at most " .. nodeBatch.MAX_MASTERIES .. " are allowed")
	end
	local spec = build.spec
	local takenBy = { }
	for id, effect in pairs(spec.masterySelections or { }) do takenBy[effect] = id end
	local out, listed = { }, { }
	for i, ref in ipairs(refs) do
		local label = "masteries[" .. i .. "]"
		local nodes, more = { }, 0
		if type(ref) == "number" then
			nodes[1] = nodeBatch.masteryNode(ref, label)
		elseif type(ref) == "string" and ref ~= "" then
			local all = nodeBatch.masteriesNamed(ref)
			if #all == 0 then userError(label .. ": no mastery named \"" .. ref .. "\"") end
			for j = 1, math.min(#all, nodeBatch.MAX_LISTED) do nodes[j] = all[j] end
			more = #all - #nodes
		else
			userError(label .. " must be a node id or a mastery name")
		end
		for _, node in ipairs(nodes) do
			if not listed[node.id] then
				listed[node.id] = true
				local options = { }
				for j, e in ipairs(nodeBatch.masteryEffectList(node)) do
					local owner = takenBy[e.effect]
					options[j] = { effect = e.effect, stats = e.stats, takenBy = owner ~= node.id and owner or nil }
				end
				local entry = { id = node.id, name = node.dn, allocated = node.alloc and true or false, options = options }
				if node.alloc then
					entry.effect = spec.masterySelections[node.id]
				elseif nodeBatch.reachable(node) then
					entry.points = nodeBatch.pathPoints(node)
				else
					entry.reachable = false
				end
				out[#out + 1] = entry
			end
		end
		if more > 0 then out[#out + 1] = { name = ref, more = more } end
	end
	return out
end

-- A strict batch (allocate_nodes / deallocate_nodes) records what it changed
-- as soon as the tree has changed, before PoB recalculates: when anything
-- after that fails (OnFrame, the stats, a PoB error popup), the command fails
-- but the change is in the build, and the caller reads the record
-- (treeEditApplied, its next command) to commit it. `record` is { } once a
-- strict batch has started and gets `applied` once the tree changed. Every
-- other command clears it when dispatched, so the record only ever describes
-- the command right before the read: a later batch that fails before its
-- handler runs is reported as not started, never credited with an earlier
-- batch's change.
nodeBatch.record = nil

function nodeBatch.recordApplied(strict, result)
	if not strict then return end
	nodeBatch.record.applied = result
	if TEST_FAULTS.treeEditFailsAfterChange then error("test fault: tree edit failed after changing the tree", 0) end
end

-- Committed build edits other than node batches (applyChanges in
-- lua/probe.lua, createSocketGroup / deleteSocketGroup / setMainSkill below),
-- in one table like nodeBatch. Each checks everything it can first, then
-- records (`record`, read with buildEditApplied right after a failure) that
-- it started changing the build and, once the whole change is in, what it
-- changed (before PoB recalculates): the caller rolls a started-but-unfinished
-- change back and commits an applied one even when the command then fails.
-- Every other command clears the record when dispatched, as for nodeBatch.
local buildEdit = { record = nil }

function buildEdit.started()
	buildEdit.record = buildEdit.record or { }
end

-- `replay`: the command is a crash replay of a committed edit (the test
-- faults below never fire for one).
function buildEdit.applied(result, replay)
	buildEdit.started()
	buildEdit.record.applied = result
	if replay then return end
	-- Test faults: the next getStats fails (PoB's recalculation after an
	-- applied change failing too) or ends the process (buildEditRecalcExits),
	-- and the command fails after the change.
	if TEST_FAULTS.buildEditRecalcFails or TEST_FAULTS.buildEditRecalcExits then buildEdit.failNextStats = true end
	if TEST_FAULTS.buildEditFailsAfterChange then error("test fault: build edit failed after changing the build", 0) end
end

-- applyChangesFailsMidway raises part-way through the change (the caller
-- rolls it back); with buildEditRollbackInexact it also arms the rollback's
-- committed-state fingerprint read (`probe` with `fingerprint` and
-- `rollbackCheck`) to come back with one extra line, so the caller's check
-- after the rollback sees a difference (the build itself is left as the
-- rollback put it). The next fingerprint read disarms it either way, so a
-- rollback that fails before its check leaves nothing armed.
function buildEdit.testFaultMidway(replay)
	if TEST_FAULTS.applyChangesFailsMidway and not replay then
		if TEST_FAULTS.buildEditRollbackInexact then buildEdit.rollbackInexact = true end
		error("test fault: apply_changes failed part-way", 0)
	end
end

-- The commands that start a build edit. Dispatching one disarms the test
-- faults an earlier edit armed but never reached (failNextStats when the
-- edit failed before its recalculation, rollbackInexact when no rollback
-- read the fingerprint), so they only ever hit the edit that armed them.
buildEdit.COMMANDS = { applyChanges = true, createSocketGroup = true, deleteSocketGroup = true, setMainSkill = true }

-- Returns { added, removed }: the nodes the batch added, in the order they
-- joined the tree (each one next to the tree as it was then: PoB's path runs
-- from the node back to the tree), and the nodes it removed (another option
-- of a choice node), as nodeBatch.describe tables. Allocating exactly the
-- added ids in that order reproduces the change whichever of several equally
-- short paths PoB picked (its choice depends on table order, which differs
-- between processes): what a crash replay needs. Nodes are looked up by id
-- at every step: an earlier node of the batch may have rebuilt the cluster
-- jewel graphs.
-- `masteries` (resolved by nodeBatch.resolveMasteries: { id, effect } each)
-- are masteries to allocate with that effect, or allocated ones to give that
-- effect. Unallocated ones not in nodeIds are allocated after nodeIds (a
-- crash replay lists them in nodeIds, in join order); each selection is set
-- right before its node is allocated, those of allocated masteries first.
-- `masteries` in the result: { id, name, effect, stats, previousEffect? } each.
local function allocNodesBatch(nodeIds, strict, masteries)
	if strict then nodeBatch.record = { } end
	masteries = masteries or { }
	local nodes = batchNodes(nodeIds)
	if strict then nodeBatch.strictChecks(nodes, true) end
	local effectOf, previous = { }, { }
	do
		local requested = { }
		for _, id in ipairs(nodeIds) do requested[id] = true end
		local extended = { }
		for i, id in ipairs(nodeIds) do extended[i] = id end
		for _, m in ipairs(masteries) do
			effectOf[m.id] = m.effect
			previous[m.id] = build.spec.masterySelections[m.id]
			local node = build.spec.nodes[m.id]
			if node and not node.alloc and not requested[m.id] then
				extended[#extended + 1] = m.id
				nodes[#nodes + 1] = node
			end
		end
		nodeIds = extended
	end
	for _, node in ipairs(nodes) do
		if node.type == "Mastery" and not node.alloc and not effectOf[node.id] then userError(nodeBatch.masteryInNodes(node)) end
	end
	local choiceParent = { }
	for _, node in ipairs(nodes) do
		-- PassiveSpec:AllocNode silently does nothing for a node no path
		-- reaches (another class's start, another ascendancy). Allocating a
		-- node never removes a path, so checking up front is exact.
		if not node.alloc and not node.path then
			userError("Node " .. nodeLabel(node) .. " cannot be allocated: no path from the allocated tree reaches it")
		end
		-- Two options of one multiple-choice node: the second would silently
		-- deallocate the first.
		if node.isMultipleChoiceOption and node.linked and node.linked[1] then
			local parent = node.linked[1]
			local other = choiceParent[parent]
			if other and other ~= node then
				userError("Nodes " .. nodeLabel(other) .. " and " .. nodeLabel(node) .. " are options of the same choice; only one can be allocated")
			end
			choiceParent[parent] = node
		end
	end
	local before = nodeBatch.captureAllocated()
	local order, listed = { }, { }
	withTreeRollback(function()
		local spec = build.spec
		for _, m in ipairs(masteries) do
			if spec.allocNodes[m.id] then spec.masterySelections[m.id] = m.effect end
		end
		for i, id in ipairs(nodeIds) do
			local node = spec.nodes[id]
			if not node then
				userError("Node " .. nodeLabel(nodes[i]) .. " no longer exists after an earlier node of the batch rebuilt the cluster jewel graphs")
			end
			local path = node.path or { }
			if #(node.intuitiveLeapLikesAffecting or { }) > 0 then path = { node } end
			for j = #path, 1, -1 do
				local pathNode = path[j]
				if not pathNode.alloc and not listed[pathNode.id] then
					listed[pathNode.id] = true
					order[#order + 1] = pathNode.id
				end
			end
			if effectOf[id] then spec.masterySelections[id] = effectOf[id] end
			spec:AllocNode(node)
		end
		-- Allocated masteries whose effect changed get it from the rebuild.
		if #masteries > 0 then spec:BuildAllDependsAndPaths() end
		for i, id in ipairs(nodeIds) do
			if not spec.allocNodes[id] then
				userError("Node " .. nodeLabel(nodes[i]) .. " could not be allocated")
			end
		end
		for _, m in ipairs(masteries) do
			if spec.masterySelections[m.id] ~= m.effect then
				userError("Mastery " .. nodeLabel(spec.nodes[m.id]) .. " could not be given effect " .. tostring(m.effect))
			end
		end
	end)
	local added = { }
	for _, id in ipairs(order) do
		local node = build.spec.allocNodes[id]
		if node then added[#added + 1] = nodeBatch.describe(node) end
	end
	-- Anything else that became allocated (not expected) follows, by id.
	local extra = { }
	for id in pairs(build.spec.allocNodes) do
		if not before[id] and not listed[id] then extra[#extra + 1] = id end
	end
	table.sort(extra)
	for _, id in ipairs(extra) do added[#added + 1] = nodeBatch.describe(build.spec.allocNodes[id]) end
	local result = { added = added, removed = nodeBatch.lostSince(before) }
	if #masteries > 0 then
		result.masteries = { }
		for i, m in ipairs(masteries) do result.masteries[i] = nodeBatch.describeMastery(m.id, previous[m.id]) end
	end
	build.buildFlag = true
	nodeBatch.recordApplied(strict, result)
	runCallback("OnFrame")
	return result
end

-- Returns { removed }: the nodes removed (the requested ones and every node
-- that depended on them), by id, as nodeBatch.describe tables. Nodes are
-- looked up by id at every step (see allocNodesBatch); one an earlier node
-- of the batch already removed (it depended on it) is skipped.
local function deallocNodesBatch(nodeIds, strict)
	if strict then nodeBatch.record = { } end
	local nodes = batchNodes(nodeIds)
	if strict then nodeBatch.strictChecks(nodes, false) end
	for _, node in ipairs(nodes) do
		if node.type == "ClassStart" or node.type == "AscendClassStart" then
			userError("Node " .. nodeLabel(node) .. " is a class start and cannot be deallocated")
		end
		-- Checked against the tree before the batch: a later node may lose its
		-- allocation to an earlier one in the same batch (it depends on it),
		-- which is the requested result anyway.
		if not node.alloc then
			userError("Node " .. nodeLabel(node) .. " is not allocated")
		end
	end
	local before = nodeBatch.captureAllocated()
	withTreeRollback(function()
		for _, id in ipairs(nodeIds) do
			local node = build.spec.nodes[id]
			if node and build.spec.allocNodes[id] then
				build.spec:DeallocNode(node)
			end
		end
	end)
	local result = { removed = nodeBatch.lostSince(before) }
	build.buildFlag = true
	nodeBatch.recordApplied(strict, result)
	runCallback("OnFrame")
	return result
end

-- plan_respec (BuildSession.planRespec, which runs it between a passive-tree
-- snapshot and its exact restore): change the tree so that exactly the
-- `target` nodes (ids or unique names) are allocated, plus class starts, the
-- allocated ascendancy nodes when `keepAscendancy` is not false, the `keep`
-- ids, and the nodes connecting them. The whole target is checked first
-- (unknown ids or names, names several nodes share, nodes no path reaches,
-- unallocated masteries, two options of one choice): a refusal changes
-- nothing. Then, on the tree as it is:
--   1. removals: while an allocated node can go without taking a kept node
--      with it (its PoB `depends`), the one taking the most nodes (lowest id
--      on ties) is deallocated as PoB does (with its dependents). Kept nodes
--      stay connected without every removed node, so deallocating `deallocate`
--      in order on the original tree removes the same nodes;
--   2. additions: the unallocated target node with the shortest PoB path
--      (lowest id on ties) is allocated with that path, until none is left.
--      `allocate` lists the nodes added in the order they joined the tree
--      (allocating them in that order reproduces the change exactly).
-- `readded`: nodes of `allocate` that were allocated before (a removal took
-- them, a path needed them again); the caller restores the tree and runs the
-- command again with them in `keep`. `removed` / `added`: the net change.
function nodeBatch.respec(cmd)
	local spec = build.spec
	local refs = cmd.target
	if type(refs) ~= "table" then userError("target must be an array of node ids or names") end
	local problems = { unknown = { }, ambiguous = { }, unreachable = { }, masteries = { } }
	local byName
	local target, targetIds = { }, { }
	local choiceOf = { }
	for _, ref in ipairs(refs) do
		local node
		if type(ref) == "number" then
			node = spec.nodes[ref]
			if not node then table.insert(problems.unknown, tostring(ref)) end
		elseif type(ref) == "string" and ref ~= "" then
			if not byName then
				byName = { }
				for _, n in pairs(spec.nodes) do
					if n.dn then
						local key = n.dn:lower()
						byName[key] = byName[key] or { }
						table.insert(byName[key], n)
					end
				end
			end
			local all = byName[ref:lower()] or { }
			if #all == 1 then
				node = all[1]
			elseif #all == 0 then
				table.insert(problems.unknown, "\"" .. ref .. "\"")
			else
				table.sort(all, function(a, b) return a.id < b.id end)
				local ids = { }
				for i = 1, math.min(#all, 8) do ids[i] = tostring(all[i].id) end
				table.insert(problems.ambiguous, "\"" .. ref .. "\" (" .. #all .. " nodes: " .. table.concat(ids, ", ")
					.. (#all > 8 and ", ..." or "") .. ")")
			end
		else
			userError("target entries must be node ids or non-empty names")
		end
		if node and not target[node.id] and node.type ~= "ClassStart" and node.type ~= "AscendClassStart" then
			if node.type == "Mastery" and not node.alloc then
				table.insert(problems.masteries, nodeLabel(node))
			elseif not node.alloc and not (node.path and #node.path > 0) then
				table.insert(problems.unreachable, nodeLabel(node))
			else
				if node.isMultipleChoiceOption and node.linked and node.linked[1] then
					local other = choiceOf[node.linked[1]]
					if other then
						userError("target: nodes " .. nodeLabel(other) .. " and " .. nodeLabel(node) .. " are options of the same choice; only one can be allocated")
					end
					choiceOf[node.linked[1]] = node
				end
				target[node.id] = true
				targetIds[#targetIds + 1] = node.id
			end
		end
	end
	local parts = { }
	if #problems.unknown > 0 then parts[#parts + 1] = "unknown nodes: " .. table.concat(problems.unknown, ", ") end
	if #problems.ambiguous > 0 then parts[#parts + 1] = "names several nodes share (pass the id): " .. table.concat(problems.ambiguous, "; ") end
	if #problems.unreachable > 0 then parts[#parts + 1] = "no path from the class start reaches: " .. table.concat(problems.unreachable, ", ") end
	if #problems.masteries > 0 then
		parts[#parts + 1] = "unallocated masteries need an effect (leave them out, then allocate them with allocate_nodes `masteries`): "
			.. table.concat(problems.masteries, ", ")
	end
	if #parts > 0 then userError("target: " .. table.concat(parts, "; ")) end
	table.sort(targetIds)

	local required = { }
	for id in pairs(target) do required[id] = true end
	for _, id in ipairs(type(cmd.keep) == "table" and cmd.keep or { }) do
		if spec.allocNodes[id] then required[id] = true end
	end
	if cmd.keepAscendancy ~= false then
		for id, node in pairs(spec.allocNodes) do
			if node.ascendancyName then required[id] = true end
		end
	end
	local before = nodeBatch.captureAllocated()

	-- 1. Removals.
	local roots = { }
	for _ = 1, 10000 do
		local best, bestSize = nil, 0
		for id, node in pairs(spec.allocNodes) do
			if not required[id] and node.type ~= "ClassStart" and node.type ~= "AscendClassStart" then
				local size, ok = 0, true
				for _, dep in ipairs(node.depends or { node }) do
					if required[dep.id] or dep.type == "ClassStart" or dep.type == "AscendClassStart" then
						ok = false
						break
					end
					size = size + 1
				end
				if ok and (best == nil or size > bestSize or (size == bestSize and id < best.id)) then best, bestSize = node, size end
			end
		end
		if not best then break end
		roots[#roots + 1] = best.id
		spec:DeallocNode(best)
	end

	-- 2. Additions.
	local order, listed = { }, { }
	for _ = 1, 10000 do
		local pick, pickLen = nil, 0
		for _, id in ipairs(targetIds) do
			local node = spec.nodes[id]
			if not node then error("target node " .. id .. " no longer exists after the removals rebuilt the cluster jewel graphs", 0) end
			if not node.alloc then
				if not (node.path and #node.path > 0) then error("no path reaches target node " .. nodeLabel(node) .. " after the removals", 0) end
				if pick == nil or #node.path < pickLen or (#node.path == pickLen and id < pick.id) then pick, pickLen = node, #node.path end
			end
		end
		if not pick then break end
		local path = pick.path
		if #(pick.intuitiveLeapLikesAffecting or { }) > 0 then path = { pick } end
		for j = #path, 1, -1 do
			local pathNode = path[j]
			if not pathNode.alloc and not listed[pathNode.id] then
				listed[pathNode.id] = true
				order[#order + 1] = pathNode.id
			end
		end
		spec:AllocNode(pick)
		if not spec.allocNodes[pick.id] then error("target node " .. nodeLabel(pick) .. " could not be allocated", 0) end
	end
	for id in pairs(required) do
		if not spec.allocNodes[id] then error("node " .. id .. " was to be kept but is no longer allocated", 0) end
	end

	-- `added` in join order; anything else that became allocated (not expected) follows, by id.
	local added, readded, inAdded = { }, { }, { }
	for _, id in ipairs(order) do
		if before[id] then
			readded[#readded + 1] = id
		elseif spec.allocNodes[id] then
			added[#added + 1] = nodeBatch.describe(spec.allocNodes[id])
			inAdded[id] = true
		end
	end
	local extra = { }
	for id in pairs(spec.allocNodes) do
		if not before[id] and not inAdded[id] then extra[#extra + 1] = id end
	end
	table.sort(extra)
	for _, id in ipairs(extra) do added[#added + 1] = nodeBatch.describe(spec.allocNodes[id]) end
	build.buildFlag = true
	runCallback("OnFrame")
	return {
		removed = nodeBatch.lostSince(before), added = added, deallocate = roots, allocate = order,
		readded = readded, target = targetIds,
	}
end

local function isTreeConnected()
	-- All allocated non-start nodes must reach a class/ascend start through other allocated nodes.
	if not (build and build.spec and build.spec.allocNodes) then
		return { connected = true, orphanedNodes = { } }
	end
	local startIds = { }
	for id, node in pairs(build.spec.allocNodes) do
		if node.type == "ClassStart" or node.type == "AscendClassStart" then
			startIds[id] = true
		end
	end
	local visited = { }
	local stack = { }
	for id, _ in pairs(startIds) do
		visited[id] = true
		table.insert(stack, id)
	end
	while #stack > 0 do
		local cur = table.remove(stack)
		local node = build.spec.nodes[cur]
		if node and node.linked then
			for _, other in ipairs(node.linked) do
				if other.alloc and not visited[other.id] then
					visited[other.id] = true
					table.insert(stack, other.id)
				end
			end
		end
	end
	local orphaned = { }
	for id, node in pairs(build.spec.allocNodes) do
		-- Skip jewel-socket-supported nodes (intuitive leap etc.)
		if not visited[id] and #(node.intuitiveLeapLikesAffecting or { }) == 0 then
			table.insert(orphaned, id)
		end
	end
	return { connected = #orphaned == 0, orphanedNodes = orphaned }
end

local function getPassiveTreeSummary()
	local pointsUsed, ascUsed, secondaryAscUsed = 0, 0, 0
	if build and build.spec and build.spec.CountAllocNodes then
		pointsUsed, ascUsed, secondaryAscUsed = build.spec:CountAllocNodes()
	end
	pumpAndRead()
	local extra = (build.calcsTab and build.calcsTab.mainOutput and build.calcsTab.mainOutput.ExtraPoints) or 0
	local maxNormal = 99 + 23 + extra
	local maxAscendancy = 8

	local counts = { Normal = 0, Notable = 0, Keystone = 0, Socket = 0, Mastery = 0, Ascendancy = 0 }
	local keystones = { }
	if build and build.spec and build.spec.allocNodes then
		for id, node in pairs(build.spec.allocNodes) do
			if node.ascendancyName then
				counts.Ascendancy = counts.Ascendancy + 1
			end
			if node.type == "Keystone" then
				counts.Keystone = counts.Keystone + 1
				table.insert(keystones, { id = node.id, name = node.dn, ascendancy = node.ascendancyName })
			elseif node.type == "Notable" then
				counts.Notable = counts.Notable + 1
			elseif node.type == "Socket" then
				counts.Socket = counts.Socket + 1
			elseif node.type == "Mastery" then
				counts.Mastery = counts.Mastery + 1
			elseif node.type == "Normal" then
				counts.Normal = counts.Normal + 1
			end
		end
	end

	return {
		totalPoints = pointsUsed,
		ascendancyPoints = ascUsed,
		secondaryAscendancyPoints = secondaryAscUsed,
		maxNormalPoints = maxNormal,
		maxAscendancyPoints = maxAscendancy,
		extraPoints = extra,
		counts = counts,
		keystones = keystones,
		className = build.spec and build.spec.curClassName,
		ascendClassName = build.spec and build.spec.curAscendClassName,
	}
end

local function getValidSlots()
	local result = { }
	if not (build.itemsTab and build.itemsTab.orderedSlots) then
		return result
	end
	-- Abyssal sockets are listed only where the parent's item has them (with
	-- `parentSlot`); passive-tree jewel sockets say whether they are allocated.
	for _, slot in ipairs(build.itemsTab.orderedSlots) do
		local index, count, parent = slotChecks.abyssalSocket(slot)
		if slot.slotName and not slotChecks.hiddenReason(slot) and not (parent and index > count) then
			local itemId = slot.selItemId or 0
			local item = (itemId ~= 0) and build.itemsTab.items[itemId] or nil
			local allocated, clusterParent, active = nil, nil, nil
			if slot.nodeId then
				allocated = slotChecks.unallocatedSocket(slot) == nil
				clusterParent = slotChecks.clusterParent(slot.nodeId)
			end
			-- Flask slots: PoB's activate check box (also kept for an empty slot,
			-- where it applies to the next flask equipped).
			if slotChecks.isFlaskSlot(slot) then active = slot.active == true end
			table.insert(result, {
				slot = slot.slotName,
				occupied = itemId ~= 0,
				active = active,
				itemName = item and (item.title or item.name) or nil,
				baseName = item and item.baseName or nil,
				parentSlot = parent and parent.slotName or nil,
				allocated = allocated,
				-- A socket a cluster jewel in that socket would add; not on the tree yet.
				requiresClusterIn = clusterParent and ("Jewel " .. clusterParent) or nil,
			})
		end
	end
	return result
end

local function describeModLines(lines)
	local out = { }
	if not lines then return out end
	for _, modLine in ipairs(lines) do
		if modLine and modLine.line then
			table.insert(out, {
				line = modLine.line,
				crafted = modLine.crafted or false,
				fractured = modLine.fractured or false,
				enchant = modLine.enchant or false,
				implicit = modLine.implicit or false,
			})
		end
	end
	return out
end

local function listEquippedItems()
	local result = { }
	if not (build.itemsTab and build.itemsTab.orderedSlots) then
		return result
	end
	for _, slot in ipairs(build.itemsTab.orderedSlots) do
		-- A slot PoB hides on this tree (Wickerman, grafts) is listed only when
		-- it holds an item, marked hidden. An abyssal socket carries its
		-- `parentSlot`; a jewel in an unallocated tree socket is marked.
		if slot.slotName then
			local itemId = slot.selItemId or 0
			if itemId ~= 0 then
				local item = build.itemsTab.items[itemId]
				if item then
					local gate = slotChecks.hiddenGate(slot)
					local note
					if gate then
						note = slotChecks.hiddenReason(slot) .. (gate.counted
							and "; Path of Building still counts this item in its calculations. unequip_item removes it"
							or "; Path of Building ignores this item in its calculations on this tree. unequip_item removes it")
					end
					local _, _, parent = slotChecks.abyssalSocket(slot)
					local unallocated = slotChecks.unallocatedSocket(slot)
					local allocated = nil
					if unallocated then
						allocated = false
						note = "The socket is not allocated, so Path of Building ignores this jewel. "
							.. slotChecks.socketRemedy(unallocated)
					end
					local active = nil
					if slotChecks.isFlaskSlot(slot) then
						active = slot.active == true
						if not active then
							note = "The flask slot is not active, so Path of Building does not apply this "
								.. (item.type == "Tincture" and "tincture" or "flask") .. ". set_flask_active turns it on"
						end
					end
					table.insert(result, {
						hidden = gate and true or nil,
						note = note,
						slot = slot.slotName,
						parentSlot = parent and parent.slotName or nil,
						allocated = allocated,
						active = active,
						itemId = itemId,
						rarity = item.rarity,
						name = item.name,
						title = item.title,
						baseName = item.baseName,
						quality = item.quality,
						itemLevel = item.itemLevel,
						requirements = item.requirements and {
							level = item.requirements.level,
						} or nil,
						sockets = item.sockets and #item.sockets or 0,
						corrupted = item.corrupted or false,
						shaper = item.shaper or false,
						elder = item.elder or false,
						implicits = describeModLines(item.implicitModLines),
						explicits = describeModLines(item.explicitModLines),
						enchants = describeModLines(item.enchantModLines),
						raw = item.raw,
					})
				end
			end
		end
	end
	return result
end

local function findGemByName(name)
	if type(name) ~= "string" or not (build and build.skillsTab) then
		return nil, "No skills tab"
	end
	-- FindSkillGem returns errMsg, gemData
	local errMsg, gemData = build.skillsTab:FindSkillGem(name)
	if errMsg then return nil, errMsg end
	return gemData, nil
end

local function tagsToList(tags)
	local out = { }
	if type(tags) == "table" then
		for k, v in pairs(tags) do
			if v == true then table.insert(out, k) end
		end
	end
	table.sort(out)
	return out
end

local function describeGemData(gemData)
	if not gemData then return nil end
	local ge = gemData.grantedEffect
	return {
		gemId = gemData.id or gemData.gameId,
		name = gemData.name,
		baseTypeName = gemData.baseTypeName,
		variantId = gemData.variantId,
		grantedEffectId = gemData.grantedEffectId,
		isSupport = (ge and ge.support) and true or false,
		isVaal = gemData.vaalGem and true or false,
		isAwakened = gemData.awakenedVariantOf ~= nil or (gemData.name and gemData.name:find("Awakened ") == 1) or false,
		naturalMaxLevel = gemData.naturalMaxLevel,
		reqStr = gemData.reqStr,
		reqDex = gemData.reqDex,
		reqInt = gemData.reqInt,
		tags = tagsToList(gemData.tags),
		tagString = gemData.tagString,
		color = ge and ge.color,
	}
end

local function getSocketGroups()
	local groups = { }
	if not (build and build.skillsTab and build.skillsTab.socketGroupList) then
		return groups
	end
	for i, group in ipairs(build.skillsTab.socketGroupList) do
		local gems = { }
		for j, gemInstance in ipairs(group.gemList or { }) do
			local gd = gemInstance.gemData
			local ge = (gd and gd.grantedEffect) or gemInstance.grantedEffect
			local mainName = (gd and gd.name) or gemInstance.nameSpec or ""
			gems[j] = {
				index = j,
				name = mainName,
				nameSpec = gemInstance.nameSpec,
				gemId = gemInstance.gemId,
				skillId = gemInstance.skillId,
				level = gemInstance.level,
				quality = gemInstance.quality,
				enabled = gemInstance.enabled ~= false,
				count = gemInstance.count or 1,
				isSupport = (ge and ge.support) and true or false,
				color = ge and ge.color,
				errMsg = gemInstance.errMsg,
			}
		end
		groups[i] = {
			index = i,
			label = group.label or "",
			slotName = group.slot or "",
			enabled = group.enabled ~= false,
			isMainGroup = (build.mainSocketGroup == i),
			source = group.source,
			mainActiveSkill = group.mainActiveSkill,
			gems = gems,
		}
	end
	return groups
end

local function getGroupAndGem(groupIndex, gemIndex)
	if not (build and build.skillsTab and build.skillsTab.socketGroupList) then
		error("Skills tab not available")
	end
	local group = build.skillsTab.socketGroupList[groupIndex]
	if not group then
		userError("Skill group not found at index " .. tostring(groupIndex))
	end
	local gem = nil
	if gemIndex then
		gem = group.gemList and group.gemList[gemIndex]
		if not gem then
			userError("Gem not found at index " .. tostring(gemIndex) .. " in group " .. tostring(groupIndex))
		end
	end
	return group, gem
end

local function setGemImpl(groupIndex, gemIndex, gemName, level, quality)
	local group, gem = getGroupAndGem(groupIndex, gemIndex)
	local gemData, errMsg = findGemByName(gemName)
	if not gemData then
		userError("Gem lookup failed: " .. tostring(errMsg))
	end
	gem.gemId = gemData.id
	gem.skillId = gemData.grantedEffectId
	gem.nameSpec = gemData.name
	gem.gemData = nil
	gem.grantedEffect = nil
	if level ~= nil then gem.level = level end
	if quality ~= nil then gem.quality = quality end
	gem.enabled = true
	gem.new = nil
	build.skillsTab:ProcessSocketGroup(group)
	build.buildFlag = true
	runCallback("OnFrame")
end

local function setGemLevelImpl(groupIndex, gemIndex, level, quality)
	local group, gem = getGroupAndGem(groupIndex, gemIndex)
	if level ~= nil then gem.level = level end
	if quality ~= nil then gem.quality = quality end
	build.skillsTab:ProcessSocketGroup(group)
	build.buildFlag = true
	runCallback("OnFrame")
end

local function removeGemImpl(groupIndex, gemIndex)
	local group, _ = getGroupAndGem(groupIndex, gemIndex)
	table.remove(group.gemList, gemIndex)
	build.skillsTab:ProcessSocketGroup(group)
	build.buildFlag = true
	runCallback("OnFrame")
end

local function addGemImpl(groupIndex, gemName, level, quality, position)
	local group, _ = getGroupAndGem(groupIndex, nil)
	local gemData, errMsg = findGemByName(gemName)
	if not gemData then
		userError("Gem lookup failed: " .. tostring(errMsg))
	end
	local newGem = {
		nameSpec = gemData.name,
		gemId = gemData.id,
		skillId = gemData.grantedEffectId,
		level = level or 20,
		quality = quality or 0,
		enabled = true,
		enableGlobal1 = true,
		enableGlobal2 = true,
		count = 1,
	}
	if position and position >= 1 and position <= #group.gemList + 1 then
		table.insert(group.gemList, position, newGem)
	else
		table.insert(group.gemList, newGem)
	end
	build.skillsTab:ProcessSocketGroup(group)
	build.buildFlag = true
	runCallback("OnFrame")
	return #group.gemList
end

-- Replace all gems in a socket group atomically: wipes the existing gem list,
-- inserts the new gems without triggering a per-gem recalc, then calls
-- ProcessSocketGroup + OnFrame once. Used by testSupportCombinationLocked to
-- avoid N_remove + N_add individual OnFrame calls (each ~55–65ms).
-- cmd.gems is an array of { name, level, quality }.
-- All-or-nothing: the group index and every gem are checked before the gem
-- list changes, so a user error leaves the group untouched. Should the
-- recalculation itself fail, the old gem list is put back.
local function replaceSocketGroupImpl(groupIndex, gems)
	local group, _ = getGroupAndGem(groupIndex, nil)
	if type(gems) ~= "table" then
		userError("gems must be an array of { name, level, quality }")
	end
	local newGems = { }
	for i, gemSpec in ipairs(gems) do
		if type(gemSpec) ~= "table" then
			userError("Gem " .. i .. " must be an object with a name")
		end
		local gemData, errMsg = findGemByName(gemSpec.name)
		if not gemData then
			userError("Gem lookup failed for '" .. tostring(gemSpec.name) .. "': " .. tostring(errMsg))
		end
		for _, key in ipairs({ "level", "quality" }) do
			local v = gemSpec[key]
			if v ~= nil and (type(v) ~= "number" or v ~= v or v < 0 or v % 1 ~= 0) then
				userError("Gem " .. i .. " (" .. gemData.name .. "): " .. key .. " must be a non-negative integer")
			end
		end
		newGems[i] = {
			nameSpec = gemData.name,
			gemId = gemData.id,
			skillId = gemData.grantedEffectId,
			level = gemSpec.level or 20,
			quality = gemSpec.quality or 0,
			enabled = true,
			enableGlobal1 = true,
			enableGlobal2 = true,
			count = 1,
		}
	end
	local oldGems = { }
	for i, gem in ipairs(group.gemList) do oldGems[i] = gem end
	local function setGemList(list)
		for i = #group.gemList, 1, -1 do group.gemList[i] = nil end
		for i, gem in ipairs(list) do group.gemList[i] = gem end
		build.skillsTab:ProcessSocketGroup(group)
		build.buildFlag = true
		runCallback("OnFrame")
	end
	-- Single recalc for the whole group
	local ok, err = pcall(function()
		setGemList(newGems)
		if TEST_FAULTS.replaceFailsAfterChange then userError("test fault: replaceSocketGroup failed after changing the group") end
	end)
	if not ok then
		local restored, restoreErr = pcall(function()
			if TEST_FAULTS.replaceRollbackThrows then error("test fault: putting the old gems back threw", 0) end
			setGemList(oldGems)
		end)
		if not restored then
			failedRecoveryError(err, "putting the old gems back", restoreErr)
		end
		error(err, 0)
	end
end

local function getGemByNameImpl(name)
	local gemData, errMsg = findGemByName(name)
	if not gemData then
		return nil, errMsg
	end
	return describeGemData(gemData), nil
end

local function getAvailableSupports(activeSkillTags, includeAwakened)
	local result = { }
	if not (data and data.gems) then return result end
	local needTags = { }
	if type(activeSkillTags) == "table" then
		for _, tag in ipairs(activeSkillTags) do
			needTags[tag] = true
		end
	end
	for gemId, gemData in pairs(data.gems) do
		local ge = gemData.grantedEffect
		if ge and ge.support then
			-- Skip awakened variants unless requested (reduces noise)
			local isAwakened = gemData.name and gemData.name:find("Awakened ") == 1
			if includeAwakened or not isAwakened then
				-- Optional tag filter: support gem must have at least one matching tag
				-- (a coarse heuristic — PoB has full CanSupport logic too complex to mirror)
				local include = true
				if next(needTags) ~= nil then
					include = false
					if type(gemData.tags) == "table" then
						for tag, _ in pairs(gemData.tags) do
							if needTags[tag] then include = true break end
						end
					end
				end
				if include then
					table.insert(result, describeGemData(gemData))
				end
			end
		end
	end
	-- Sort by name for stable output
	table.sort(result, function(a, b) return (a.name or "") < (b.name or "") end)
	return result
end

function buildEdit.setMainSocketGroup(groupIndex)
	if not (build and build.skillsTab and build.skillsTab.socketGroupList) then
		error("Skills tab not available")
	end
	if not build.skillsTab.socketGroupList[groupIndex] then
		userError("Skill group not found at index " .. tostring(groupIndex))
	end
	build.mainSocketGroup = groupIndex
	build.buildFlag = true
	runCallback("OnFrame")
end

-- ---------------------------------------------------------------------------
-- Exact skills snapshot/restore for what-if probes and undo
-- ---------------------------------------------------------------------------
--
-- A snapshot holds every skill set (id, title, order, the active one), the
-- skills tab settings PoB saves (default gem level/quality, gem sorting and
-- filters), the main socket group (and the Calcs tab's copy of it, which
-- PoB clamps when groups disappear), and for every socket group and gem
-- instance every field with a plain value (string, number, boolean). That
-- is a superset of what SkillsTab:Save writes (label, slot, source, enabled,
-- includeInFullDPS, groupCount, imbuedSupport, mainActiveSkill*, and per gem
-- nameSpec, gemId, skillId, level, quality, enabled, enableGlobal1/2, count,
-- skillPart*, skillStageCount*, skillMineCount*, skillMinion*,
-- skillMinionItemSet*, skillMinionSkill*), so plain fields PoB adds later are
-- carried without a change here. Table-valued fields are derived (gemData,
-- grantedEffect, display lists, sourceItem) and are rebuilt by
-- ProcessSocketGroup and the recalculation. The one exception is a
-- monster-explosion gem's explodeSource, which CalcSetup uses to keep that
-- gem's settings (and which the explosion calculation reads); it is relinked
-- by its key (the source's modSource or id) to the live source with that key.
-- When the active set has an explosion gem whose source no longer exists,
-- PoB would recreate that gem with default settings, so the restore reports
-- itself inexact instead of differing silently. Fields are stored as sorted
-- [key, value] pairs so equal states encode to equal JSON.

local SKILLS_SNAPSHOT_VERSION = 2
local EXPLODE_SOURCE_KEY = "__explodeSourceKey"

local function isPlainValue(v)
	local t = type(v)
	return t == "string" or t == "boolean" or (t == "number" and v == v and v ~= math.huge and v ~= -math.huge)
end

local function plainFields(tbl)
	local keys = { }
	for k, v in pairs(tbl) do
		if type(k) == "string" and isPlainValue(v) then keys[#keys + 1] = k end
	end
	table.sort(keys)
	local out = { }
	for i, k in ipairs(keys) do out[i] = { k, tbl[k] } end
	return out
end

local function explodeSourceKey(source)
	if type(source) ~= "table" then return nil end
	local key = source.modSource or source.id
	if isPlainValue(key) then return key end
	return nil
end

local function snapshotSocketGroup(group)
	local gems = { }
	for j, gem in ipairs(group.gemList or { }) do
		local fields = plainFields(gem)
		local key = explodeSourceKey(gem.explodeSource)
		if key then fields[#fields + 1] = { EXPLODE_SOURCE_KEY, key } end
		gems[j] = fields
	end
	return { fields = plainFields(group), gems = gems }
end

local SKILLS_TAB_SETTINGS = {
	"defaultGemLevel", "defaultGemQuality", "sortGemsByDPS", "sortGemsByDPSField",
	"showSupportGemTypes", "showLegacyGems",
}

local function skillsTabOrError()
	local tab = build and build.skillsTab
	if not (tab and tab.socketGroupList and tab.skillSets and tab.skillSetOrderList) then
		error("Skills tab not available (PoB SkillsTab changed?)")
	end
	return tab
end

local function snapshotSkills()
	local tab = skillsTabOrError()
	local settings = { }
	for _, key in ipairs(SKILLS_TAB_SETTINGS) do
		if isPlainValue(tab[key]) then settings[#settings + 1] = { key, tab[key] } end
	end
	local setIds = { }
	for id in pairs(tab.skillSets) do setIds[#setIds + 1] = id end
	table.sort(setIds)
	local sets = { }
	for i, id in ipairs(setIds) do
		local set = tab.skillSets[id]
		local groups = { }
		for j, group in ipairs(set.socketGroupList) do groups[j] = snapshotSocketGroup(group) end
		sets[i] = { id = id, title = set.title, groups = groups }
	end
	local order = { }
	for i, id in ipairs(tab.skillSetOrderList) do order[i] = id end
	local calcsInput = build.calcsTab and build.calcsTab.input
	return {
		version = SKILLS_SNAPSHOT_VERSION,
		activeSkillSetId = tab.activeSkillSetId,
		mainSocketGroup = build.mainSocketGroup,
		calcsSkillNumber = calcsInput and calcsInput.skill_number,
		settings = settings,
		order = order,
		sets = sets,
	}
end

-- Shape check of a whole snapshot before anything is changed, so a bad
-- snapshot never leaves the skills half restored.
local function checkSkillsSnapshot(snap)
	local function bad(what)
		error("Invalid skills snapshot: " .. what, 0)
	end
	local function checkFields(fields, where)
		if type(fields) ~= "table" then bad(where .. " has no field list") end
		for _, pair in ipairs(fields) do
			if type(pair) ~= "table" or type(pair[1]) ~= "string" or not isPlainValue(pair[2]) then
				bad(where .. " has a malformed field")
			end
		end
	end
	if type(snap) ~= "table" or snap.version ~= SKILLS_SNAPSHOT_VERSION then bad("unknown version") end
	if type(snap.sets) ~= "table" or type(snap.order) ~= "table" then bad("no skill sets") end
	checkFields(snap.settings, "settings")
	local ids = { }
	for i, set in ipairs(snap.sets) do
		if type(set) ~= "table" or type(set.id) ~= "number" or type(set.groups) ~= "table" then
			bad("skill set " .. i .. " is malformed")
		end
		ids[set.id] = true
		for j, group in ipairs(set.groups) do
			local where = "skill set " .. set.id .. " group " .. j
			if type(group) ~= "table" or type(group.gems) ~= "table" then bad(where .. " is malformed") end
			checkFields(group.fields, where)
			for k, gem in ipairs(group.gems) do checkFields(gem, where .. " gem " .. k) end
		end
	end
	for _, id in ipairs(snap.order) do
		if not ids[id] then bad("the skill set order names an unknown set") end
	end
	if not ids[snap.activeSkillSetId] then bad("the active skill set is missing") end
end

local function fromFields(fields, target)
	for _, pair in ipairs(fields) do target[pair[1]] = pair[2] end
	return target
end

local function restoreSkillsTabSettings(tab, settings)
	local controls = tab.controls or { }
	for _, pair in ipairs(settings) do
		local key, value = pair[1], pair[2]
		if tab[key] ~= value then
			tab[key] = value
			-- Keep the (headless) controls in step, as SkillsTab:Load does.
			if key == "defaultGemLevel" and controls.defaultLevel then
				controls.defaultLevel:SelByValue(value, "gemLevel")
			elseif key == "defaultGemQuality" and controls.defaultQuality then
				controls.defaultQuality:SetText(value)
			elseif key == "sortGemsByDPS" and controls.sortGemsByDPS then
				controls.sortGemsByDPS.state = value
			elseif key == "showLegacyGems" and controls.showLegacyGems then
				controls.showLegacyGems.state = value
			elseif key == "showSupportGemTypes" and controls.showSupportGemTypes then
				controls.showSupportGemTypes:SelByValue(value, "show")
			elseif key == "sortGemsByDPSField" and controls.sortGemsByDPSFieldControl then
				controls.sortGemsByDPSFieldControl:SelByValue(value, "type")
			end
		end
	end
end

local function restoreSkills(snap)
	local tab = skillsTabOrError()
	checkSkillsSnapshot(snap)

	-- Live explosion sources, to relink restored explosion gems.
	local explodeSources = { }
	for _, set in pairs(tab.skillSets) do
		for _, group in ipairs(set.socketGroupList) do
			for _, source in ipairs(type(group.explodeSources) == "table" and group.explodeSources or { }) do
				local key = explodeSourceKey(source)
				if key then explodeSources[key] = source end
			end
			for _, gem in ipairs(group.gemList or { }) do
				local key = explodeSourceKey(gem.explodeSource)
				if key and not explodeSources[key] then explodeSources[key] = gem.explodeSource end
			end
		end
	end
	local displayIndex
	for i, group in ipairs(tab.socketGroupList) do
		if group == tab.displayGroup then displayIndex = i end
	end

	-- Every set is rebuilt in place (the active set's socketGroupList table is
	-- shared with the tab and its group list control); sets the probe added
	-- are dropped.
	local keep = { }
	local unlinked = { }
	for _, snapSet in ipairs(snap.sets) do
		keep[snapSet.id] = true
		local set = tab.skillSets[snapSet.id] or tab:NewSkillSet(snapSet.id)
		set.title = snapSet.title
		local list = set.socketGroupList
		for i = #list, 1, -1 do list[i] = nil end
		for i, snapGroup in ipairs(snapSet.groups) do
			local group = fromFields(snapGroup.fields, { })
			group.gemList = { }
			for j, snapGem in ipairs(snapGroup.gems) do
				local gem = fromFields(snapGem, { })
				local key = gem[EXPLODE_SOURCE_KEY]
				gem[EXPLODE_SOURCE_KEY] = nil
				if key ~= nil then
					gem.explodeSource = explodeSources[key]
					if not gem.explodeSource and snapSet.id == snap.activeSkillSetId then
						unlinked[#unlinked + 1] = "group " .. i .. " gem " .. j .. " (source " .. tostring(key) .. ")"
					end
				end
				group.gemList[j] = gem
			end
			list[i] = group
			tab:ProcessSocketGroup(group)
		end
	end
	for id in pairs(tab.skillSets) do
		if not keep[id] then tab.skillSets[id] = nil end
	end
	for i = #tab.skillSetOrderList, 1, -1 do tab.skillSetOrderList[i] = nil end
	for i, id in ipairs(snap.order) do tab.skillSetOrderList[i] = id end

	local activeSet = tab.skillSets[snap.activeSkillSetId]
	if tab.activeSkillSetId ~= snap.activeSkillSetId or tab.socketGroupList ~= activeSet.socketGroupList then
		tab:SetActiveSkillSet(snap.activeSkillSetId)
	else
		-- Added to PoB with imbued supports; older versions have no such map.
		if type(tab.RebuildImbuedSupportBySlot) == "function" then
			tab:RebuildImbuedSupportBySlot()
		end
		tab.displayGroup = tab.socketGroupList[displayIndex or 1]
	end
	restoreSkillsTabSettings(tab, snap.settings)

	build.mainSocketGroup = snap.mainSocketGroup or 1
	if build.calcsTab and build.calcsTab.input then
		build.calcsTab.input.skill_number = snap.calcsSkillNumber
	end
	build.buildFlag = true
	runCallback("OnFrame")
	if #unlinked > 0 then
		error("Skills restore was not exact (monster-explosion gem settings lost because their explosion source is gone: "
			.. table.concat(unlinked, ", ") .. "); call reset_build to return to the loaded build", 0)
	end
end

-- ---------------------------------------------------------------------------
-- Committed socket group edits (create_socket_group / delete_socket_group /
-- set_main_skill): everything is checked before the skills change; see
-- buildEdit above for the record.
-- ---------------------------------------------------------------------------

-- The slots PoB's socket group "Socketed in" list offers (SkillsTab's groupSlotDropList).
buildEdit.GROUP_SLOTS = {
	["Weapon 1"] = true, ["Weapon 2"] = true, ["Weapon 1 Swap"] = true, ["Weapon 2 Swap"] = true,
	["Helmet"] = true, ["Body Armour"] = true, ["Gloves"] = true, ["Boots"] = true, ["Amulet"] = true,
	["Ring 1"] = true, ["Ring 2"] = true, ["Ring 3"] = true, ["Belt"] = true,
}
buildEdit.MAX_GROUP_GEMS = 20

function buildEdit.isInt(v, min)
	return type(v) == "number" and v == v and v % 1 == 0 and v >= min and v < 2 ^ 31
end

function buildEdit.groupAt(index)
	local list = skillsTabOrError().socketGroupList
	if not buildEdit.isInt(index, 1) then userError("group must be a 1-based integer") end
	local group = list[index]
	if not group then
		userError("Skill group not found at index " .. tostring(index) .. " (the build has " .. #list .. " socket groups)")
	end
	return group, list
end

-- How many active skills PoB makes from the group when it is the main group
-- (CalcSetup's "Create active skills" loop): every granted effect of every
-- enabled gem (a Vaal gem grants two) that is not a support, is supported,
-- and, for an effect with a global part, has that part enabled. PoB builds a
-- group's display skill list only for enabled or main groups, so it is
-- counted here rather than read.
function buildEdit.activeSkillCount(group)
	local n = 0
	for _, gem in ipairs(group.gemList or { }) do
		if gem.enabled and (gem.gemData or gem.grantedEffect) then
			local effects = gem.gemData and gem.gemData.grantedEffectList or { gem.grantedEffect }
			for index, effect in ipairs(effects) do
				if not effect.support and not effect.unsupported and (not effect.hasGlobalEffect or gem["enableGlobal" .. index]) then
					n = n + 1
				end
			end
		end
	end
	return n
end

function buildEdit.describeGroup(index, group)
	local gems = { }
	for i, gem in ipairs(group.gemList or { }) do
		gems[i] = { name = (gem.gemData and gem.gemData.name) or gem.nameSpec or "", level = gem.level, quality = gem.quality, enabled = gem.enabled ~= false }
	end
	return { index = index, label = group.displayLabel or group.label or "", slot = group.slot, enabled = group.enabled ~= false, gems = gems }
end

-- Keep the main socket group (and the Calcs tab's copy) on a valid group
-- after group `removed` was deleted, as PoB's own delete does for indices
-- past it; the main group itself moves to the group that took its place
-- (the last group when it was last).
function buildEdit.shiftMainAfterDelete(removed)
	local count = #build.skillsTab.socketGroupList
	local function shifted(index)
		index = tonumber(index) or 1
		if index > removed then index = index - 1 end
		return math.max(1, math.min(index, count))
	end
	build.mainSocketGroup = shifted(build.mainSocketGroup)
	if build.calcsTab and build.calcsTab.input and build.calcsTab.input.skill_number then
		build.calcsTab.input.skill_number = shifted(build.calcsTab.input.skill_number)
	end
end

-- cmd: { gems = [{ name, level?, quality?, enabled? }], slot?, label?,
-- enabled?, setAsMain? }. The new group goes last, as PoB's "New" button
-- puts it. Returns its index and its gems (names as PoB knows them).
function buildEdit.createSocketGroup(cmd)
	local tab = skillsTabOrError()
	local specs = cmd.gems
	if type(specs) ~= "table" or #specs == 0 then userError("gems must list at least one gem") end
	if #specs > buildEdit.MAX_GROUP_GEMS then
		userError("gems has " .. #specs .. " entries; at most " .. buildEdit.MAX_GROUP_GEMS .. " are allowed")
	end
	local gems = { }
	for i, spec in ipairs(specs) do
		local label = "gems[" .. i .. "]"
		if type(spec) ~= "table" or type(spec.name) ~= "string" then userError(label .. " must be { name, level?, quality?, enabled? }") end
		local gemData, errMsg = findGemByName(spec.name)
		if not gemData then userError(label .. ": gem lookup failed for '" .. spec.name .. "': " .. tostring(errMsg)) end
		if spec.level ~= nil and not buildEdit.isInt(spec.level, 1) then userError(label .. ": level must be a positive integer") end
		if spec.quality ~= nil and not buildEdit.isInt(spec.quality, 0) then userError(label .. ": quality must be a non-negative integer") end
		if spec.enabled ~= nil and type(spec.enabled) ~= "boolean" then userError(label .. ": enabled must be a boolean") end
		-- As addGem / replaceSocketGroup create gems.
		gems[i] = {
			nameSpec = gemData.name, gemId = gemData.id, skillId = gemData.grantedEffectId,
			level = spec.level or 20, quality = spec.quality or 0, enabled = spec.enabled ~= false,
			enableGlobal1 = true, enableGlobal2 = true, count = 1,
		}
	end
	if cmd.slot ~= nil and not buildEdit.GROUP_SLOTS[cmd.slot] then
		userError("slot must be one of the slots a socket group can be socketed in (Weapon 1, Weapon 2, Helmet, Body Armour, Gloves, Boots, Amulet, Ring 1-3, Belt, or a weapon swap slot), got " .. tostring(cmd.slot))
	end
	if cmd.label ~= nil and type(cmd.label) ~= "string" then userError("label must be a string") end
	if cmd.enabled ~= nil and type(cmd.enabled) ~= "boolean" then userError("enabled must be a boolean") end
	if cmd.setAsMain ~= nil and type(cmd.setAsMain) ~= "boolean" then userError("setAsMain must be a boolean") end
	-- mainActiveSkill / mainActiveSkillCalcs as SkillsTab:LoadSkill defaults them.
	local group = {
		label = cmd.label or "", enabled = cmd.enabled ~= false, slot = cmd.slot, gemList = gems,
		mainActiveSkill = 1, mainActiveSkillCalcs = 1,
	}
	buildEdit.started()
	tab.socketGroupList[#tab.socketGroupList + 1] = group
	local index = #tab.socketGroupList
	tab:ProcessSocketGroup(group)
	tab:UpdateSocketGroups()
	if cmd.setAsMain then build.mainSocketGroup = index end
	build.buildFlag = true
	local result = { index = index, group = buildEdit.describeGroup(index, group) }
	buildEdit.applied(result, cmd.replay == true)
	runCallback("OnFrame")
	result.group = buildEdit.describeGroup(index, group)
	return result
end

-- cmd: { group }. A group granted by an item or the passive tree is refused.
-- Later groups move up by one.
function buildEdit.deleteSocketGroup(cmd)
	local tab = skillsTabOrError()
	local group = buildEdit.groupAt(cmd.group)
	if group.source then
		userError("Skill group " .. cmd.group .. " is granted by " .. tostring(group.source)
			.. " and cannot be deleted; remove the item or passive node that grants it instead")
	end
	local deleted = buildEdit.describeGroup(cmd.group, group)
	buildEdit.started()
	table.remove(tab.socketGroupList, cmd.group)
	if type(tab.RebuildImbuedSupportBySlot) == "function" then tab:RebuildImbuedSupportBySlot() end
	if tab.displayGroup == group then tab.displayGroup = tab.socketGroupList[1] end
	buildEdit.shiftMainAfterDelete(cmd.group)
	build.buildFlag = true
	local result = { deleted = deleted, mainSocketGroup = build.mainSocketGroup }
	buildEdit.applied(result, cmd.replay == true)
	runCallback("OnFrame")
	return result
end

-- cmd: { group, activeSkill? }: make the group the main skill group and,
-- with activeSkill, pick which of its active skills is the main skill.
function buildEdit.setMainSkill(cmd)
	pumpAndRead() -- display skill lists as of the last recalculation
	local group = buildEdit.groupAt(cmd.group)
	local count = buildEdit.activeSkillCount(group)
	if count == 0 then
		userError("Skill group " .. cmd.group .. " has no enabled active skill gem to use as the main skill")
	end
	if cmd.activeSkill ~= nil then
		if not buildEdit.isInt(cmd.activeSkill, 1) then userError("activeSkill must be a 1-based integer") end
		if cmd.activeSkill > count then
			userError("activeSkill " .. cmd.activeSkill .. " is out of range: skill group " .. cmd.group .. " has " .. count .. " active skill(s)")
		end
	end
	buildEdit.started()
	build.mainSocketGroup = cmd.group
	if cmd.activeSkill ~= nil then group.mainActiveSkill = cmd.activeSkill end
	build.buildFlag = true
	buildEdit.applied({ mainSocketGroup = cmd.group }, cmd.replay == true)
	runCallback("OnFrame")
	return { mainSocketGroup = build.mainSocketGroup, activeSkill = group.mainActiveSkill or 1 }
end

-- ---------------------------------------------------------------------------
-- Weighted trade searches: PoB's own TradeQueryGenerator, run headless.
-- StartQuery normally opens a progress popup and lets OnFrame drive the weight
-- coroutine; here the popup calls are neutralised for the duration of the
-- command and the coroutine is driven to completion synchronously (GetTime is
-- stubbed to 0, so it never yields early). Nothing is downloaded or written:
-- the generator's mod data (Data/QueryMods.lua) and the trade stat list
-- (Data/TradeSiteStats.lua) must already be in the install.
-- ---------------------------------------------------------------------------
local TRADE_TYPES = { "securable", "available", "onlineleague", "online", "any" }
local ELDRITCH_SLOTS = { ["Body Armour"] = true, ["Helmet"] = true, ["Gloves"] = true, ["Boots"] = true }
local ELDRITCH_OPTIONS = { "Copy Current", "Keep regular", "Keep regular+presence", "Remove" }
local PSEUDO_IGNORED = { "^pseudo%.lake", "^pseudo%.pseudo_lake", "^pseudo%.pseudo_logbook", "^pseudo%.pseudo_temple",
	"^pseudo%.pseudo_map", "^pseudo%.pseudo_ritual" }
-- Copy of the pseudoMap in PoB's FinishQuery (a local there): weights for
-- these single-resistance / single-attribute stats are merged into the
-- pseudo "total" filter, so adjustments must target the pseudo id too.
local TRADE_PSEUDO_MAP = {
	["3372524247"] = "pseudo.pseudo_total_fire_resistance",
	["4220027924"] = "pseudo.pseudo_total_cold_resistance",
	["1671376347"] = "pseudo.pseudo_total_lightning_resistance",
	["2923486259"] = "pseudo.pseudo_total_chaos_resistance",
	["4080418644"] = "pseudo.pseudo_total_strength",
	["3261801346"] = "pseudo.pseudo_total_dexterity",
	["328541901"] = "pseudo.pseudo_total_intelligence",
}
-- The stat hash PoB's FinishQuery keys pseudoMap / ignoredStats by.
local function tradeStatHash(id)
	return type(id) == "string" and not id:find("^pseudo%.") and id:match("^[a-z]+%.stat_(%d+)$") or nil
end
local function tradePseudoFor(id)
	local hash = tradeStatHash(id)
	return hash and TRADE_PSEUDO_MAP[hash] or nil
end
-- PoB's FinishQuery also drops these stats from the weights (their value is
-- already in the pseudo totals above): all elemental resistances, all
-- attributes (literal hashes there) and every hybrid resistance / attribute
-- (hashed there with HashStats from these name patterns). Built the same way,
-- keyed by hash, valued by the pseudo totals that count the stat.
local TRADE_IGNORED_LITERAL = {
	["2901986750"] = { "fire", "cold", "lightning" }, -- % all elemental resistances
	["1379411836"] = { "strength", "dexterity", "intelligence" }, -- all attributes
	["2897413282"] = { "strength", "dexterity", "intelligence" },
}
local tradeIgnored = nil
local function tradeIgnoredFor(id)
	if not tradeIgnored then
		local attributes = { strength = true, dexterity = true, intelligence = true }
		local pseudoOf = function(name)
			return "pseudo.pseudo_total_" .. name .. (attributes[name] and "" or "_resistance")
		end
		tradeIgnored = { }
		local function add(hash, names)
			local list, seen = { }, { }
			for _, name in ipairs(names) do
				local pseudo = pseudoOf(name)
				if not seen[pseudo] then seen[pseudo] = true list[#list + 1] = pseudo end
			end
			tradeIgnored[tostring(hash)] = list
		end
		for hash, names in pairs(TRADE_IGNORED_LITERAL) do add(hash, names) end
		local resElements = { "fire", "cold", "lightning", "chaos" }
		for _, elem1 in ipairs(resElements) do
			for _, elem2 in ipairs(resElements) do
				add(HashStats({ string.format("%s_and_%s_damage_resistance_%%", elem1, elem2) }), { elem1, elem2 })
			end
		end
		local attributeElements = { "dexterity", "strength", "intelligence" }
		for _, elem1 in ipairs(attributeElements) do
			for _, elem2 in ipairs(attributeElements) do
				add(HashStats({ string.format("base_%s_and_%s", elem1, elem2) }), { elem1, elem2 })
				add(HashStats({ string.format("additional_%s_and_%s", elem1, elem2) }), { elem1, elem2 })
			end
		end
	end
	local hash = tradeStatHash(id)
	return hash and tradeIgnored[hash] or nil
end
local tradeState = nil

local function findUpvalue(fn, name)
	for i = 1, 255 do
		local n, v = debug.getupvalue(fn, i)
		if n == nil then return nil end
		if n == name then return i, v end
	end
end

local function tradeStateOrError()
	if tradeState then return tradeState end
	-- InitMods would download the stat list and save QueryMods.lua into the
	-- install when the file is missing: refuse before it gets the chance.
	for _, file in ipairs({ "Data/QueryMods.lua", "Data/TradeSiteStats.lua" }) do
		local h = raw_io_open(file, "rb")
		if not h then
			userError("This Path of Building install has no " .. file
				.. ", which trade searches need; update or reinstall Path of Building")
		end
		h:close()
	end
	local gen = construct("TradeQueryGenerator", { itemsTab = build.itemsTab })
	-- The generator's own copy (PoB 2.68+ `require`s it; loading it again
	-- would make a second instance), else the module as PoB loads it.
	local _, helpers = findUpvalue(gen.StartQuery, "tradeHelpers")
	if not helpers then
		local okRequire, mod = pcall(require, "Classes.TradeHelpers")
		helpers = okRequire and type(mod) == "table" and mod or LoadModule("Classes/TradeHelpers")
	end
	local texts, pseudo = { }, { }
	for _, cat in ipairs(helpers.getTradeStats() or { }) do
		for _, entry in ipairs(cat.entries or { }) do
			if type(entry.id) == "string" and type(entry.text) == "string" then
				if texts[entry.id] == nil then texts[entry.id] = entry.text end
				if cat.id == "pseudo" then pseudo[#pseudo + 1] = entry end
			end
		end
	end
	tradeState = { gen = gen, helpers = helpers, texts = texts, pseudo = pseudo }
	return tradeState
end

-- Slots PoB can build a weighted search for: gear and flask slots, abyssal
-- sockets the parent's item has, and allocated passive-tree jewel sockets
-- (PoB's trade tab lists the same). Returns the slot, the trade category
-- query string and PoB's item category (the mod lists' key), and for a jewel
-- slot PoB's jewel type ("Base" / "Abyss" / "Any", TradeQueryGenerator's
-- options.jewelType). `jewelType` ("base" / "abyss" / "any" or nil) applies
-- to passive-tree sockets (default: "abyss" when an abyss jewel is socketed
-- there, else "base"); abyssal sockets take only "abyss"; other slots none.
-- `flaskType` applies to flask slots only (slotChecks.tradeFlask; its result
-- is returned last as { kind, standIn }). A weapon slot of the weapon set
-- the build does not use, or an abyssal socket on one, is refused (PoB weighs
-- every mod there at 0), except with `forMods` (search_trade_mods lists mods).
local function tradeSlotOrError(slotName, helpers, jewelType, flaskType, forMods)
	local slot = type(slotName) == "string" and build.itemsTab.slots[slotName] or nil
	local index, count, parent = nil, 0, nil
	if slot then index, count, parent = slotChecks.abyssalSocket(slot) end
	local item = slot and build.itemsTab.items[slot.selItemId or 0]
	local what = "Cannot build a trade search for " .. tostring(slotName) .. ": "
	if flaskType ~= nil and not (slot and slotChecks.isFlaskSlot(slot)) then
		userError("flaskType only applies to flask slots (Flask 1 to Flask 5), not " .. tostring(slotName))
	end
	local weaponSet = slot and not forMods and slotChecks.inactiveWeaponSet(slot)
	if weaponSet then
		userError(what .. slotChecks.inactiveWeaponSetText(slotName, weaponSet) .. " and weighs every mod at 0. "
			.. "Search the slot of the weapon set in use instead")
	end
	if slot and slotChecks.isFlaskSlot(slot) then
		if jewelType ~= nil then userError("jewelType only applies to jewel sockets, not " .. slotName) end
		local kind, standIn = slotChecks.tradeFlask(slot, item, flaskType, forMods)
		-- Tinctures: PoB's tincture mods under a "Tincture" category of the bridge's own (no trade category).
		if kind == "tincture" then return slot, nil, "Tincture", nil, { kind = kind } end
		local queryStr, category = helpers.getTradeCategory(slotName, item)
		return slot, queryStr, category, nil, { kind = kind, standIn = standIn }
	end
	-- Tree-gated slots: grafts are weighed from PoB's graft mods under a
	-- "Graft" category of the bridge's own (tradeCompat.customModData);
	-- Wickerman parts have no mods (generate_trade_search ranks Viscera).
	local gate = slot and slotChecks.treeGated[slotName]
	if gate then
		local hidden = slotChecks.hiddenReason(slot)
		if hidden then userError(what .. hidden .. "; " .. gate.remedy) end
		if not slotName:match("^Graft %d$") then userError(what .. slotChecks.VISCERA_TRADE_TEXT) end
		if jewelType ~= nil then userError("jewelType only applies to jewel sockets, not " .. slotName) end
		if not item and not forMods then
			userError(what .. "the slot is empty. A graft search weighs the mods the graft in the slot can roll (its base "
				.. "decides its skill and which mods it can have, and the trade search is filtered by that base type, as Path "
				.. "of Building's trade data has no graft category), so equip the graft you want to improve first")
		end
		return slot, nil, "Graft", nil
	end
	if slot and slot.nodeId then
		local nodeId = slotChecks.unallocatedSocket(slot)
		if nodeId then
			userError(what .. "the passive tree jewel socket is not allocated, so Path of Building weighs every mod at 0. "
				.. slotChecks.socketRemedy(nodeId))
		end
		local kind = jewelType or ((item and item.base and item.base.subType == "Abyss") and "abyss" or "base")
		local pobType = ({ base = "Base", abyss = "Abyss", any = "Any" })[kind]
		if not pobType then userError("jewelType must be \"base\", \"abyss\" or \"any\"") end
		-- As TradeQueryGenerator:StartQuery maps options.jewelType.
		local queries = { Base = "jewel.base", Abyss = "jewel.abyss", Any = "jewel" }
		return slot, queries[pobType], pobType .. "Jewel", pobType
	end
	if parent then
		if index > count then
			userError(what .. "the item in " .. parent.slotName .. " has " .. count .. " abyssal socket(s)")
		end
		if jewelType ~= nil and jewelType ~= "abyss" then
			userError("jewelType \"" .. tostring(jewelType) .. "\" does not apply to " .. slotName
				.. ": abyssal sockets hold only abyss jewels (\"abyss\" is accepted)")
		end
		local queryStr, category = helpers.getTradeCategory(slotName, item)
		return slot, queryStr, category, "Abyss"
	end
	local supported = { }
	for _, s in ipairs(build.itemsTab.orderedSlots or { }) do
		local name = s.slotName
		if name and not s.nodeId and not s.parentSlot and helpers.getTradeCategory(name, nil) then
			supported[#supported + 1] = name
		end
	end
	if not slot or not listContains(supported, slotName) then
		userError("Unsupported slot for a trade search: " .. tostring(slotName)
			.. ". Supported slots: " .. table.concat(supported, ", ")
			.. ", abyssal sockets the item in their slot has, allocated passive tree jewel sockets and, on the passive trees "
			.. "that show them, Graft 1/2 and the Wickerman slots (see list_valid_slots)")
	end
	if jewelType ~= nil then
		userError("jewelType only applies to jewel sockets, not " .. slotName)
	end
	local queryStr, category = helpers.getTradeCategory(slotName, item)
	return slot, queryStr, category, nil
end

local function tradeStatWeights(requested)
	local valid, names = { }, { }
	for _, entry in ipairs(data.powerStatList) do
		if entry.stat and not entry.ignoreForItems and entry.label ~= "Name" and not valid[entry.stat] then
			valid[entry.stat] = entry
			names[#names + 1] = entry.stat
		end
	end
	local out = { }
	for _, w in ipairs(requested or { }) do
		local entry = valid[w.stat]
		if not entry then
			userError("Unknown stat weight '" .. tostring(w.stat) .. "'. Valid stats: " .. table.concat(names, ", "))
		end
		out[#out + 1] = { stat = entry.stat, label = entry.label, transform = entry.transform, weightMult = tonumber(w.weight) }
	end
	if #out == 0 then userError("statWeights must name at least one stat") end
	return out
end

local function tradeIdTexts(st, ids)
	local out = { }
	for _, id in ipairs(ids or { }) do
		local text = st.texts[id]
		if not text then
			userError("Unknown trade stat id '" .. tostring(id) .. "'; use search_trade_mods to find valid ids")
		end
		out[#out + 1] = { id = id, text = text }
		local pseudo = tradePseudoFor(id)
		if pseudo and st.texts[pseudo] then out[#out + 1] = { id = pseudo, text = st.texts[pseudo] } end
	end
	return out
end

local function influenceIndex(name)
	if name == nil then return 1 end
	for i, info in ipairs(itemLib.influenceInfo.default) do
		if info.display:lower() == tostring(name):lower() then return i + 1 end
	end
	userError("Unknown influence '" .. tostring(name) .. "'")
end

-- PoB 2.67 and older cap the weight group with an upvalue (MAX_FILTERS);
-- 2.68 counts a trade-site complexity budget in a FinishQuery local instead,
-- reachable only from a debug hook. Both are lifted for the call so every
-- weight comes back; returns a function that undoes the lift and reports
-- whether it took effect. The line hook (which turns the JIT off while it is
-- set) is installed only once FinishQuery has run its item calculation (at
-- its WeightedRatioOutputs call; from the start when that is missing) and
-- removed as soon as the local is set.
local tradeCompat = { }
function tradeCompat.fingerprintDiff(a, b)
	for i = 1, math.max(#a, #b) do
		if a[i] ~= b[i] then return tostring(a[i]) .. " -> " .. tostring(b[i]) end
	end
	return nil
end

function tradeCompat.liftFilterCap(finishQuery)
	local maxIdx, maxOrig = findUpvalue(finishQuery, "MAX_FILTERS")
	if maxIdx then
		debug.setupvalue(finishQuery, maxIdx, 100000)
		return function() debug.setupvalue(finishQuery, maxIdx, maxOrig) return true end
	end
	local hook, mask, count = debug.gethook()
	local lifted, hooked = false, false
	local function unhook()
		if not hooked then return end
		hooked = false
		if hook then debug.sethook(hook, mask, count) else debug.sethook() end
	end
	local function onLine()
		local info = debug.getinfo(2, "f")
		if not (info and info.func == finishQuery) then return end
		for i = 1, 250 do
			local name = debug.getlocal(2, i)
			if name == nil then return end
			if name == "complexityBudget" then
				debug.setlocal(2, i, 1e9)
				lifted = true
				unhook()
				return
			end
		end
	end
	local function hookNow()
		if hooked or lifted then return end
		hooked = true
		debug.sethook(onLine, "l")
	end
	local _, class = findUpvalue(finishQuery, "TradeQueryGeneratorClass")
	local ratio = type(class) == "table" and rawget(class, "WeightedRatioOutputs")
	if type(ratio) ~= "function" then ratio = nil end
	local undo = function()
		if ratio then class.WeightedRatioOutputs = ratio end
		unhook()
		return lifted
	end
	if ratio then
		class.WeightedRatioOutputs = function(...) hookNow() return ratio(...) end
	else
		hookNow()
	end
	return undo
end

-- PoB 2.68 hands the callback the query table (no sort/engine wrapper, empty
-- "and"/"not" groups always present) and no longer applies influences. Bring
-- it to the 2.67 shape: { query, sort, engine } JSON, no empty groups, and
-- the influence requirements 2.67 put in an "and" group.
function tradeCompat.normaliseQuery(query, influenceIds)
	if type(query) ~= "table" then return query end
	local stats, kept = query.stats or { }, { }
	for i, group in ipairs(stats) do
		if i == 1 or #(group.filters or { }) > 0 then kept[#kept + 1] = group end
	end
	if #influenceIds > 0 then
		local filters = { }
		for _, id in ipairs(influenceIds) do filters[#filters + 1] = { id = id } end
		kept[#kept + 1] = { type = "and", filters = filters }
	end
	query.stats = kept
	return dkjson.encode({ query = query, sort = { ["statgroup.0"] = "desc" }, engine = "new" })
end

-- The special uniques of PoB's trade tab ("Other trades" rows), searched with
-- options.special = { itemName = <name> }: StartQuery sets `flag` on
-- calcContext.special when it knows the name; `modData` is the generator's
-- mod list the search weighs (Pearl of Tsoatha's list is built per search
-- from Data/PearlSupports.lua). PoB's popup offers neither a jewel type nor
-- a mirrored option for them (FinishQuery then always excludes mirrored items).
tradeCompat.UNIQUES = {
	["Megalomaniac"] = { flag = "calcNodesInsteadOfMods", modData = "PassiveNode" },
	["Watcher's Eye"] = { flag = "watchersEye", modData = "WatchersEye" },
	["Pearl of Tsoatha"] = { flag = "pearl" },
}

-- Refused unless this PoB's generator has the search (feature detection).
function tradeCompat.checkUniqueSupported(gen, unique)
	local info = tradeCompat.UNIQUES[unique]
	if not info then
		userError("unique must be \"Megalomaniac\", \"Watcher's Eye\" or \"Pearl of Tsoatha\", not " .. tostring(unique))
	end
	local supported = true
	if info.modData then
		local list = type(gen.modData) == "table" and gen.modData[info.modData]
		supported = type(list) == "table" and next(list) ~= nil
	end
	if unique == "Megalomaniac" and type(gen.GeneratePassiveNodeWeights) ~= "function" then supported = false end
	if unique == "Pearl of Tsoatha" then
		local okList, list = pcall(require, "Data.PearlSupports")
		supported = okList and type(list) == "table" and #list > 0
	end
	if not supported then
		userError("This Path of Building version's trade query generator has no " .. unique .. " search; update Path of Building")
	end
	return info
end

-- The jewel sockets PoB's unique jewel rows use (TradeQuery's
-- activeUniqueJewelSocket, the Watcher's Eye popup's socket list): allocated
-- passive-tree sockets without containJewelSocket, a field PoB 1 never sets
-- (so every allocated socket passes there). PoB's `not socket.inactive`
-- mirrors spec.allocNodes (ItemsTab:UpdateSockets), but only refreshes when
-- its UI draws, so the allocation is read directly.
function tradeCompat.uniqueSocketOk(nodeId, socket)
	local node = build.spec.nodes[nodeId]
	return socket ~= nil and build.spec.allocNodes[nodeId] ~= nil and node ~= nil and not node.containJewelSocket
end

-- The slot a special unique search runs against, its item category and
-- trade category: Watcher's Eye an allocated tree socket (as PoB's popup
-- lists them; "AnyJewel" / "jewel"), Pearl of Tsoatha a ring slot PoB shows
-- ("Ring", tried on a Prismatic Ring), Megalomaniac such a socket too, by
-- default PoB's own pick (the lowest node id; none when there is none: the
-- notables are then weighed against the whole build). A socket holding a
-- cluster jewel is refused (the default skips it).
-- The options PoB's unique rows have no control for (feature check first).
function tradeCompat.uniqueOptions(gen, unique, jewelType, flaskType)
	tradeCompat.checkUniqueSupported(gen, unique)
	if flaskType ~= nil then userError("flaskType does not apply to " .. unique .. " searches") end
	if jewelType ~= nil and not (unique == "Watcher's Eye" and jewelType == "any") then
		userError("jewelType does not apply to " .. unique .. " searches"
			.. (unique == "Watcher's Eye" and " (they search every jewel: \"any\" is accepted and changes nothing)" or ""))
	end
end

function tradeCompat.uniqueSlot(gen, unique, slotName, jewelType, flaskType)
	tradeCompat.uniqueOptions(gen, unique, jewelType, flaskType)
	local slot = slotName ~= nil and build.itemsTab.slots[slotName] or nil
	if unique == "Pearl of Tsoatha" then
		local rings = { }
		for i = 1, 3 do
			local ring = build.itemsTab.slots["Ring " .. i]
			local okShown, shown = pcall(function() return ring and (ring.shown == nil or ring.shown()) end)
			if okShown and shown then rings[#rings + 1] = "Ring " .. i end
		end
		if not listContains(rings, slotName) then
			userError("Pearl of Tsoatha searches need slot = a ring slot Path of Building shows (" .. table.concat(rings, ", ")
				.. "), not " .. tostring(slotName)
				.. ((slotName == "Ring 3" and slot) and ": Ring 3 is hidden on this build" or ""))
		end
		return slot, "Ring", "ring"
	end
	local category, queryStr = nil, nil
	if unique == "Watcher's Eye" then category, queryStr = "AnyJewel", "jewel" end
	-- A socket holding a cluster jewel: PoB measures from the build without
	-- the jewel in the socket, so every weight would carry the loss of the
	-- passives that jewel adds.
	local function heldCluster(socketSlot)
		local held = build.itemsTab.items[socketSlot.selItemId or 0]
		if held and (held.clusterJewel or tostring(held.baseName or ""):find("Cluster Jewel", 1, true)) then return held end
		return nil
	end
	if slotName == nil then
		-- Megalomaniac only (the others need a slot): PoB's own pick, the
		-- lowest node id passing its check, skipping sockets that hold a
		-- cluster jewel; none at all (no allocated socket) is PoB's nil slot.
		local ids, skipped = { }, 0
		for nodeId, socket in pairs(build.itemsTab.sockets) do
			if tradeCompat.uniqueSocketOk(nodeId, socket) then
				if heldCluster(socket) then skipped = skipped + 1 else ids[#ids + 1] = nodeId end
			end
		end
		if #ids == 0 and skipped > 0 then
			userError(unique .. ": every allocated passive-tree jewel socket holds a cluster jewel, and Path of Building would weigh "
				.. "every notable against the build without it and its passives. Allocate a free jewel socket (allocate_nodes) "
				.. "and pass it as slot")
		end
		table.sort(ids)
		return ids[1] and build.itemsTab.sockets[ids[1]] or nil, category, queryStr
	end
	local nodeId = slot and slot.nodeId
	local what = unique .. " searches need slot = an allocated passive-tree jewel socket not holding a cluster jewel"
	if not nodeId then
		userError(what .. " (\"Jewel <nodeId>\", see list_valid_slots), not " .. tostring(slotName))
	end
	if slotChecks.unallocatedSocket(slot) then
		userError(what .. ": " .. slotName .. " is not allocated. " .. slotChecks.socketRemedy(nodeId))
	end
	-- PoB's own check (its containJewelSocket test): PoB 1 never sets that
	-- field, so this never refuses there; kept so a PoB that sets it is followed.
	if not tradeCompat.uniqueSocketOk(nodeId, build.itemsTab.sockets[nodeId] or slot) then
		userError(what .. ": Path of Building's " .. unique .. " search does not use " .. slotName)
	end
	local held = heldCluster(slot)
	if held then
		userError(what .. ": " .. slotName .. " holds a cluster jewel (" .. tostring(held.title or held.name or held.baseName)
			.. "); Path of Building would weigh every " .. unique .. (unique == "Megalomaniac" and " notable" or " mod")
			.. " against the build without it and its passives. Choose another socket")
	end
	return slot, category, queryStr
end

-- Pearl of Tsoatha's filters as ExecuteQuery builds them (stat hash
-- 4089743927 | skill-group slot 1-4 | support index into
-- Data/PearlSupports.lua), with their texts from PoB's trade stat list.
function tradeCompat.pearlPool(texts)
	local okList, list = pcall(require, "Data.PearlSupports")
	local pool = { }
	for slotIndex = 1, 4 do
		for support = 1, (okList and type(list) == "table") and #list or 0 do
			local id = string.format("explicit.stat_4089743927|%d|%d", slotIndex, support)
			if texts[id] then pool[#pool + 1] = { id = id, text = texts[id] } end
		end
	end
	return pool
end

-- PoB's GeneratePassiveNodeWeights looks every Megalomaniac notable of its
-- trade data up on the build's tree (clusterNodeMap, then notableMap) and
-- fails on one the tree does not have (older trees): the names it would miss.
function tradeCompat.megalomaniacMissing(gen)
	local tree = build.spec.tree
	local missing = { }
	for _, entry in pairs(gen.modData.PassiveNode) do
		local text = entry.tradeMod and tostring(entry.tradeMod.text) or ""
		local name = text:match("1 Added Passive Skill is (.*)") or text:match("Allocates (.*)")
		if name and not ((tree.clusterNodeMap or { })[name] or (tree.notableMap or { })[name]) then
			missing[#missing + 1] = name
		end
	end
	table.sort(missing)
	return missing
end

-- Grafts and tinctures: PoB's generator has no category for them (TradeHelpers
-- maps none, and its InitMods skips graft bases, whose implicits have no mod
-- data). Their affixes (data.itemMods.Graft / .Tincture, only those PoB's
-- spawn weights let roll on `item`'s base when one is given) and the base's
-- implicits that have mod data go through the generator's own ProcessMod under
-- a category of that name, into a separate mod list (the generator's own list
-- is never changed); lines the trade stat list lacks are skipped by ProcessMod
-- as for every other slot. The trade search filters by the base type instead
-- of a trade category (runTradeQuery). Cached per base.
tradeCompat.customCache = { }
function tradeCompat.customModData(gen, category, item)
	local mods = data.itemMods[category]
	if type(gen.ProcessMod) ~= "function" or type(mods) ~= "table" then
		userError("This Path of Building version cannot weigh " .. category:lower() .. " mods (its trade query generator has no "
			.. "ProcessMod, or it has no " .. category:lower() .. " mod data); update Path of Building")
	end
	local base = item and item.base
	local key = category .. "|" .. (base and item.baseName or "")
	if tradeCompat.customCache[key] then return tradeCompat.customCache[key] end
	local md = { Explicit = { }, Implicit = { }, Corrupted = { }, Enchant = { }, Scourge = { }, Eater = { }, Exarch = { } }
	local tester = base and construct("Item", "Rarity: RARE\nStat Tester\n" .. item.baseName)
	local saved = gen.modData
	gen.modData = md
	local ok, err = pcall(function()
		local mask = { [category] = true }
		for modId, mod in pairsSortByKey(mods) do
			if not tester or tester:GetModSpawnWeight(mod) > 0 then gen:ProcessMod(modId, mod, nil, nil, mask) end
		end
		for _, id in ipairs(base and base.implicitIds or { }) do
			local mod = data.itemMods.ItemExclusive[id]
			if mod and mod.group and mod.statOrder then
				local implicit = copyTable(mod)
				implicit.type = "Implicit"
				gen:ProcessMod("", implicit, nil, nil, mask)
			end
		end
	end)
	gen.modData = saved
	if not ok then error(err, 0) end
	tradeCompat.customCache[key] = md
	return md
end

local function runTradeQuery(cmd)
	local st = tradeStateOrError()
	local unique = cmd.unique
	local slot, queryStr, category, jewelType, flask
	if unique ~= nil then
		-- slot is nil only for a Megalomaniac search on a build without a usable socket.
		if cmd.slot == nil and unique ~= "Megalomaniac" then userError(tostring(unique) .. " searches need a slot") end
		slot, category, queryStr = tradeCompat.uniqueSlot(st.gen, unique, cmd.slot, cmd.jewelType, cmd.flaskType)
		local missing = unique == "Megalomaniac" and tradeCompat.megalomaniacMissing(st.gen) or { }
		if #missing > 0 then
			local shown = { }
			for i = 1, math.min(#missing, 5) do shown[i] = missing[i] end
			userError("Path of Building cannot weigh Megalomaniac on this build's passive tree (version "
				.. tostring(build.spec.treeVersion):gsub("_", ".") .. "): " .. #missing .. " cluster notable(s) of its trade data are not on "
				.. "that tree (" .. table.concat(shown, ", ") .. (#missing > 5 and ", ..." or "") .. "), and its search fails on them. "
				.. "convert_tree_to_latest moves the build to the latest tree, which has them")
		end
	else
		slot, queryStr, category, jewelType, flask = tradeSlotOrError(cmd.slot, st.helpers, cmd.jewelType, cmd.flaskType)
	end
	local statWeights = tradeStatWeights(cmd.statWeights)
	local idTexts = tradeIdTexts(st, cmd.tradeIds)
	-- A weight on a stat PoB leaves out of the weights would count it twice
	-- (the pseudo totals already include it): name the totals to adjust.
	for _, id in ipairs(cmd.adjustmentIds or { }) do
		local totals = tradeIgnoredFor(id)
		if totals then
			userError("weightAdjustments cannot weigh " .. id .. " (" .. tostring(st.texts[id])
				.. "): Path of Building leaves it out of weighted searches because "
				.. table.concat(totals, ", ") .. " already count it; adjust "
				.. (#totals > 1 and "those" or "that") .. " instead (it is still valid in requiredMods)")
		end
	end
	-- Grafts and tinctures: the mods of the item in the slot, filtered by its base type.
	local custom = (category == "Graft" or category == "Tincture") and slot and build.itemsTab.items[slot.selItemId or 0]
	local customMd = custom and tradeCompat.customModData(st.gen, category, custom) or nil
	local o = cmd.options or { }
	local tradeTypeIndex = nil
	for i, t in ipairs(TRADE_TYPES) do if t == o.tradeType then tradeTypeIndex = i end end
	if not tradeTypeIndex then userError("Unknown tradeType '" .. tostring(o.tradeType) .. "'") end
	local item = slot and build.itemsTab.items[slot.selItemId]
	local committedItem = item
	-- A flask search for a kind the slot does not hold tries the mods on a
	-- blank flask of that kind: the generator reads the slot's item through
	-- itemsTab.items[slot.selItemId], so it gets read-only views holding the
	-- stand-in (nothing is added to the build).
	local querySlot, queryItemsTab = slot, build.itemsTab
	if flask and flask.standIn then
		item = construct("Item", "Rarity: RARE\nStat Tester\n" .. flask.standIn)
		local standInId = -1
		querySlot = setmetatable({ selItemId = standInId }, { __index = slot })
		queryItemsTab = setmetatable({ items = setmetatable({ [standInId] = item }, { __index = build.itemsTab.items }) },
			{ __index = build.itemsTab })
	end
	local influences = o.influences or { }
	local options = {
		statWeights = statWeights,
		includeCorrupted = o.includeCorrupted,
		includeMirrored = o.includeMirrored ~= false,
		-- PoB's popup has no scourge option for jewel slots.
		includeScourge = o.includeScourge == true and jewelType == nil,
		jewelType = jewelType,
		influence1 = influenceIndex(influences[1]),
		influence2 = influenceIndex(influences[2]),
		maxPrice = tonumber(o.maxPrice),
		maxPriceType = o.maxPriceType,
		maxLevel = tonumber(o.maxLevel),
		sockets = tonumber(o.sockets),
		links = tonumber(o.links),
	}
	-- PoB's popup defaults: corrupted mods unless the current item is already
	-- corrupted; eldritch choice and talisman toggle only on their slots.
	if options.includeCorrupted == nil then options.includeCorrupted = not (item and item.corrupted) end
	if unique ~= nil then
		-- As PoB's popup for the unique rows: no mirrored option (FinishQuery
		-- then excludes mirrored items), corrupted mods on by default (the
		-- Megalomaniac row's box is off: its notables are weighed, not mods).
		-- The caller refuses the options these searches do not take.
		options.special = { itemName = unique }
		options.includeMirrored = nil
		options.includeScourge = false
		if unique == "Megalomaniac" then options.includeCorrupted = false
		elseif o.includeCorrupted == nil then options.includeCorrupted = true end
	elseif customMd then
		-- StartQuery's special branch builds the test item from the slot's item without a trade category
		-- (an unknown name sets no flag); the category and filters are set on its context below.
		options.special = { itemName = category }
	elseif ELDRITCH_SLOTS[slot.slotName] then
		options.includeEldritch = ELDRITCH_OPTIONS[tonumber(o.eldritchIndex) or 1] or ELDRITCH_OPTIONS[1]
	end
	if unique == nil and slot.slotName == "Amulet" then options.includeTalisman = o.includeTalisman == true end

	-- An inactive flask slot counts for nothing in PoB's calculations (every
	-- weight would be 0): it is evaluated active for the call (with a
	-- calculator built for that state, as PoB builds one after every full
	-- recalculation, so the base output includes the flask), then its exact
	-- flags, the committed calculator and the calculator cache are put back
	-- and the committed state is checked by value. The fingerprint is read
	-- first (it runs a pending recalculation), before anything is replaced
	-- or captured.
	local activate = flask ~= nil and not slot.active
	local fpBefore = activate and tradeCompat.fingerprint() or nil
	local gen = st.gen
	gen.itemsTab = queryItemsTab
	gen.queryTab = { itemsTab = queryItemsTab }
	gen.lastMaxPrice, gen.lastMaxPriceTypeIndex, gen.lastMaxLevel = nil, nil, nil
	gen.tradeTypeIndex = tradeTypeIndex
	gen.calcContext = { }
	-- PoB without influence support (2.68+): require the influences with the
	-- same trade filters 2.67 added (the weights cannot use them there).
	local influenceIds = { }
	if not findUpvalue(gen.FinishQuery, "hasInfluenceModIds") then
		for _, idx in ipairs({ options.influence1, options.influence2 }) do
			if idx > 1 then
				influenceIds[#influenceIds + 1] = "pseudo.pseudo_has_"
					.. string.lower(itemLib.influenceInfo.default[idx - 1].display) .. "_influence"
			end
		end
	end
	local captured = nil
	gen.requesterContext = nil
	gen.requesterCallback = function(_ctx, json, errMsg) captured = { json = json, err = errMsg } end
	local openOrig, closeOrig = rawget(main, "OpenPopup"), rawget(main, "ClosePopup")
	main.OpenPopup = function() return { } end
	main.ClosePopup = function() end
	local capLifted = false
	local savedModData = gen.modData
	local activated, unactivate, savedCache = false, nil, nil
	local savedMisc = build.calcsTab.miscCalculator
	local started = os.clock()
	local ok, err = pcall(function()
		-- The activation runs inside the protected call, so a failure part-way
		-- through it still restores the popup stubs, the generator's views and
		-- whatever it changed (then checked by value below).
		if activate then
			activated = true
			local cache = GlobalCache.cachedData.CALCULATOR
			savedCache = { }
			for k, v in pairs(cache) do savedCache[k] = v end
			local entry = build.itemsTab.activeItemSet[slot.slotName]
			unactivate = slotChecks.setFlaskFlags(slot, true, entry and entry.active)
			-- Test fault: the activation fails once the flags are set.
			if TEST_FAULTS.tradeFlaskActivationFails then error("test fault: activating the flask slot for the trade search failed", 0) end
			build.calcsTab.miscCalculator = { build.calcsTab.calcs.getMiscCalculator(build) }
			-- Test fault: the search fails while the slot is activated.
			if TEST_FAULTS.tradeFlaskFailsActivated then error("test fault: trade search failed with the flask slot activated", 0) end
		end
		gen:StartQuery(querySlot, options)
		local co = gen.calcContext.co
		if customMd and co then
			gen.calcContext.itemCategory, gen.calcContext.itemCategoryQueryStr = category, nil
			gen.calcContext.special = {
				queryFilters = { type_filters = { filters = { rarity = { option = "nonunique" } } } },
				queryExtra = { type = custom.baseName },
			}
			gen.modData = customMd
		elseif customMd then
			userError("This Path of Building version's trade query generator cannot run a " .. category:lower() .. " search; update Path of Building")
		end
		local flag = unique and tradeCompat.UNIQUES[unique].flag
		if flag and not (type(gen.calcContext.special) == "table" and gen.calcContext.special[flag]) then
			userError("This Path of Building version's trade query generator has no " .. unique .. " search; update Path of Building")
		end
		if not co then
			userError("Path of Building cannot build a weighted trade search for the item in " .. (slot and slot.slotName or tostring(unique)))
		end
		while coroutine.status(co) ~= "dead" do
			local resumed, msg = coroutine.resume(co, gen)
			if not resumed then error("trade weight calculation failed: " .. tostring(msg), 0) end
		end
		gen.calcContext.co = nil
		-- Lift PoB's filter cap so every weight comes back; the caller applies
		-- the cap after its own adjustments.
		local unlift = tradeCompat.liftFilterCap(gen.FinishQuery)
		local finished, finishErr = pcall(gen.FinishQuery, gen)
		capLifted = unlift()
		if not finished then error(finishErr, 0) end
	end)
	local elapsed = os.clock() - started
	gen.modData = savedModData
	main.OpenPopup, main.ClosePopup = openOrig, closeOrig
	gen.calcContext = { }
	gen.requesterCallback = nil
	gen.itemsTab, gen.queryTab = build.itemsTab, { itemsTab = build.itemsTab }
	if activated then
		if unactivate then unactivate() end
		build.calcsTab.miscCalculator = savedMisc
		if savedCache then
			local cache = GlobalCache.cachedData.CALCULATOR
			wipeTable(cache)
			for k, v in pairs(savedCache) do cache[k] = v end
		end
		local after = tradeCompat.fingerprint()
		-- Test fault (rollback check): this read alone comes back different.
		if TEST_FAULTS.tradeFlaskRestoreInexact then after[#after + 1] = "testFault|tradeFlaskRestoreInexact" end
		local diff = tradeCompat.fingerprintDiff(fpBefore, after)
		if diff then
			error("the trade search left the build different from the committed one (" .. diff .. ")"
				.. (ok and "" or ("; the search itself failed: " .. tostring(err):gsub("^" .. USER_ERROR_PREFIX, "")))
				.. "; call reset_build", 0)
		end
	end
	if not ok then error(err, 0) end
	if captured then captured.json = tradeCompat.normaliseQuery(captured.json, influenceIds) end
	if not captured or type(captured.json) ~= "string" then
		error("Path of Building produced no trade query", 0)
	end
	local decoded = dkjson.decode(captured.json)
	local weightGroup = decoded and decoded.query and decoded.query.stats and decoded.query.stats[1]
	for _, f in ipairs(weightGroup and weightGroup.filters or { }) do
		if type(f.id) == "string" and st.texts[f.id] then idTexts[#idTexts + 1] = { id = f.id, text = st.texts[f.id] } end
	end
	local used = { }
	for _, w in ipairs(statWeights) do used[#used + 1] = { stat = w.stat, label = w.label, weight = w.weightMult } end
	return {
		queryJson = captured.json,
		pobMessage = captured.err or dkjson.null,
		capLifted = capLifted,
		itemCategory = category or dkjson.null,
		categoryQuery = queryStr or dkjson.null,
		currentItem = committedItem and (committedItem.title or committedItem.name) or dkjson.null,
		unique = unique,
		slot = slot and slot.slotName or dkjson.null,
		flaskType = flask and flask.kind or nil,
		baseType = customMd and custom.baseName or nil,
		testBase = flask and flask.standIn or nil,
		evaluatedActive = activated or nil,
		statWeights = used,
		texts = idTexts,
		pseudoMap = (function()
			local list = { }
			for _, id in ipairs(cmd.tradeIds or { }) do
				local pseudo = tradePseudoFor(id)
				if pseudo then list[#list + 1] = { from = id, to = pseudo } end
			end
			return list
		end)(),
		calcSeconds = elapsed,
	}
end

local function searchTradeMods(cmd)
	local st = tradeStateOrError()
	-- The category as PoB's popup lists mods (jewel sockets: by jewel type).
	-- A special unique lists the pool its search weighs: Watcher's Eye its
	-- mods (plus corrupted jewel implicits and pseudo stats, as other jewels),
	-- Megalomaniac the cluster notables, Pearl of Tsoatha its support filters
	-- (one per support and skill-group slot, the ids its search returns).
	local unique, category, kinds = cmd.unique, nil, { "Explicit", "Implicit", "Corrupted" }
	if unique ~= nil then
		-- The pool does not depend on the slot: one given is checked as for generate_trade_search.
		tradeCompat.uniqueOptions(st.gen, unique, cmd.jewelType, cmd.flaskType)
		if cmd.slot ~= nil then tradeCompat.uniqueSlot(st.gen, unique, cmd.slot, cmd.jewelType, cmd.flaskType) end
		category = ({ ["Watcher's Eye"] = "AnyJewel", ["Pearl of Tsoatha"] = "Ring" })[unique]
		kinds = ({ ["Watcher's Eye"] = { "WatchersEye", "Corrupted" }, Megalomaniac = { "PassiveNode" } })[unique] or { }
	else
		local _
		_, _, category = tradeSlotOrError(cmd.slot, st.helpers, cmd.jewelType, cmd.flaskType, true)
	end
	-- Grafts and tinctures: the bridge's own mod lists (every graft / tincture mod for an empty slot).
	local modData = st.gen.modData
	if category == "Graft" or category == "Tincture" then
		local item = build.itemsTab.items[build.itemsTab.slots[cmd.slot].selItemId or 0]
		local own = item and item.base and item.base.type == category and item or nil
		modData = tradeCompat.customModData(st.gen, category, own)
	end
	local needle = tostring(cmd.query or ""):lower()
	local found, seen = { }, { }
	local preferredPseudo = { }
	for _, pseudo in pairs(TRADE_PSEUDO_MAP) do preferredPseudo[pseudo] = true end
	-- Only ids generate_trade_search accepts (present in TradeSiteStats.lua).
	-- Single resistances/attributes point at their pseudo total, which is
	-- listed first: PoB weighs those stats through the pseudo filter. Stats
	-- PoB leaves out of the weights (all/hybrid resistances and attributes)
	-- stay listed with weightable = false and the totals that count them.
	local function add(id, text, kind)
		if seen[id] or not st.texts[id] then return end
		seen[id] = true
		if text:lower():find(needle, 1, true) then
			local entry = {
				tradeId = id, text = text, type = kind,
				preferred = preferredPseudo[id] or nil,
				preferredTradeId = tradePseudoFor(id),
			}
			local totals = tradeIgnoredFor(id)
			if totals then entry.weightable, entry.preferredTradeIds = false, totals end
			found[#found + 1] = entry
		end
	end
	for _, kind in ipairs(kinds) do
		for _, md in pairs(modData[kind] or { }) do
			-- Megalomaniac's notables have no item category (its search weighs every one).
			if (kind == "PassiveNode" or (category and md[category] ~= nil)) and md.tradeMod and type(md.tradeMod.id) == "string" then
				add(md.tradeMod.id, tostring(md.tradeMod.text), (kind == "WatchersEye" or kind == "PassiveNode") and "Explicit" or kind)
			end
		end
	end
	if unique == "Pearl of Tsoatha" then
		for _, entry in ipairs(tradeCompat.pearlPool(st.texts)) do add(entry.id, entry.text, "Explicit") end
	end
	for _, entry in ipairs(unique ~= nil and unique ~= "Watcher's Eye" and { } or st.pseudo) do
		local ignored = false
		for _, pattern in ipairs(PSEUDO_IGNORED) do
			if entry.id:find(pattern) then ignored = true break end
		end
		if not ignored then add(entry.id, entry.text, "Pseudo") end
	end
	local order = { Explicit = 1, Implicit = 2, Corrupted = 3, Pseudo = 4 }
	table.sort(found, function(a, b)
		if (a.preferred or false) ~= (b.preferred or false) then return a.preferred == true end
		if a.type ~= b.type then return order[a.type] < order[b.type] end
		if a.text ~= b.text then return a.text < b.text end
		return a.tradeId < b.tradeId
	end)
	local limit = tonumber(cmd.limit) or 25
	local mods = { }
	for i = 1, math.min(limit, #found) do mods[i] = found[i] end
	return { itemCategory = category or dkjson.null, total = #found, mods = mods }
end

-- Wickerman slots (3.30 trees): Viscera parts have fixed implicits and no
-- affixes, so generate_trade_search ranks PoB's Viscera list instead: every
-- entry of data.viscera, made as PoB's Viscera database makes it (a RARE
-- item from the raw text, BuildAndParseRaw), that PoB's IsItemValidForSlot
-- lets into the slot. BuildSession probes each candidate's text and scores
-- the results with tradeScores. `statKeys`: the output keys the scores read
-- (each weighted stat and its minion value; Full DPS also the stats PoB's
-- WeightedRatioOutputs falls back on) plus the stats shown per candidate.
function tradeCompat.visceraCandidates(cmd)
	local slotName = cmd.slot
	local slot = type(slotName) == "string" and build.itemsTab.slots[slotName] or nil
	local gate = slot and slotChecks.treeGated[slotName]
	if not gate or slotName:match("^Graft") then
		userError(tostring(slotName) .. " is not a Wickerman slot (Head, Body, Arm or Leg)")
	end
	local hidden = slotChecks.hiddenReason(slot)
	if hidden then userError("Cannot rank Viscera parts for " .. slotName .. ": " .. hidden .. "; " .. gate.remedy) end
	if type(data.viscera) ~= "table" then
		userError("This Path of Building version has no Viscera list (Data/Viscera.lua); update Path of Building")
	end
	local weights = tradeStatWeights(cmd.statWeights)
	local keys, seen = { }, { }
	local function key(k) if not seen[k] then seen[k] = true keys[#keys + 1] = k end end
	for _, w in ipairs(weights) do
		local stats = w.stat == "FullDPS" and { "FullDPS", "TotalDPS", "TotalDotDPS", "CombinedDPS" } or { w.stat }
		for _, stat in ipairs(stats) do key(stat) key("Minion:" .. stat) end
	end
	for _, stat in ipairs({ "CombinedDPS", "TotalEHP", "Life" }) do key(stat) end
	local candidates = { }
	for _, raw in ipairs(data.viscera) do
		local ok, item = pcall(construct, "Item", raw, "RARE", true)
		if ok and item and item.base then
			item:BuildAndParseRaw()
			if build.itemsTab:IsItemValidForSlot(item, slotName) then
				candidates[#candidates + 1] = { name = item.title or item.name, baseName = item.baseName, itemText = item:BuildRaw() }
			end
		end
	end
	local current = build.itemsTab.items[slot.selItemId or 0]
	local used = { }
	for _, w in ipairs(weights) do used[#used + 1] = { stat = w.stat, label = w.label, weight = w.weightMult } end
	return { candidates = candidates, statKeys = keys, statWeights = used,
		currentItem = current and (current.title or current.name) or dkjson.null }
end

-- Scores of probe results by PoB's own WeightedRatioOutputs (what the trade
-- generator weighs mods with): (score(base, result) - score(base, base)) x
-- 1000. `base` / `results` are probe stats; "Minion:<stat>" keys become
-- output.Minion[<stat>].
function tradeCompat.tradeScores(cmd)
	local ratio = tradeStateOrError().gen.WeightedRatioOutputs
	if type(ratio) ~= "function" then
		userError("This Path of Building version's trade query generator has no WeightedRatioOutputs; update Path of Building")
	end
	local weights = tradeStatWeights(cmd.statWeights)
	local function output(stats)
		local out = { Minion = { } }
		for k, v in pairs(type(stats) == "table" and stats or { }) do
			if type(v) == "number" then
				local minion = k:match("^Minion:(.+)$")
				if minion then out.Minion[minion] = v else out[k] = v end
			end
		end
		return out
	end
	local base = output(cmd.base)
	local baseScore = ratio(base, base, weights)
	local scores = { }
	for i, stats in ipairs(cmd.results or { }) do scores[i] = (ratio(base, output(stats), weights) - baseScore) * 1000 end
	return { scores = scores }
end

-- Commands that do not need a loaded build (everything else requires PoB to
-- be in BUILD mode before and after the command).
local NO_BUILD_REQUIRED = {
	ping = true, shutdown = true, verifyData = true, getConfigMetadata = true, engineSelfTest = true,
	-- loadXML runs its own post-load checks (and may start from LIST mode).
	loadXML = true,
}

local function currentPopups()
	local m = mainObject.main
	local set = { }
	if m and type(m.popups) == "table" then
		for _, p in ipairs(m.popups) do set[p] = true end
	end
	return set
end

local function describePopup(popup)
	local lines = { }
	if type(popup) == "table" then
		if type(popup.title) == "string" and popup.title ~= "" then
			lines[#lines + 1] = popup.title
		end
		if type(popup.controls) == "table" then
			for _, control in ipairs(popup.controls) do
				if type(control) == "table" and type(control.label) == "string" and control.label:match("%S") then
					lines[#lines + 1] = control.label
				end
			end
		end
	end
	if #lines == 0 then return "(untitled dialog)" end
	return stripColorCodes(table.concat(lines, " | "))
end

-- Inspect PoB's own error channels after a command: Launch.lua catches
-- OnFrame errors into launch.promptMsg, PoB reports load problems via
-- popups, and a crash during initial build load drops it to LIST mode.
-- Returns a message when something went wrong, else nil.
local function detectPoBFailure(popupsBefore, expectBuild)
	if mainObject.promptMsg then
		-- Launch.lua's prompt is "Error:\n\n<msg>\n<version>\nPress ... to dismiss ...":
		-- keep the message and version, drop the GUI key hints.
		local lines = { }
		for line in (stripColorCodes(mainObject.promptMsg) .. "\n"):gmatch("([^\n]*)\n") do
			line = line:gsub("^%s+", ""):gsub("%s+$", "")
			if line ~= "" and line ~= "Error:" and not line:match("^Press ") then
				lines[#lines + 1] = line
			end
		end
		return "Path of Building error: " .. table.concat(lines, " | ")
	end
	local m = mainObject.main
	if m and type(m.popups) == "table" then
		for _, p in ipairs(m.popups) do
			if not popupsBefore[p] then
				return "Path of Building opened a blocking dialog: " .. describePopup(p)
			end
		end
	end
	if expectBuild and m then
		local mode = m.newMode or m.mode
		if mode ~= "BUILD" then
			return "Path of Building is no longer in BUILD mode (mode=" .. tostring(mode)
				.. "); the build failed to load or crashed"
		end
	end
	return nil
end

-- Reset PoB's error channels so the next command starts clean.
local function clearPoBErrorState()
	mainObject.promptMsg = nil
	mainObject.promptFunc = nil
	local m = mainObject.main
	if m and type(m.popups) == "table" then
		for i = #m.popups, 1, -1 do m.popups[i] = nil end
	end
end

-- Return the engine to a known-good (empty) build after a failed load, so a
-- half-initialised build or LIST mode never leaks into later commands.
local function recoverBlankBuild()
	clearPoBErrorState()
	local ok, err = pcall(newBuild)
	if not ok then
		STDERR:write("[pob-mcp] failed to reset to blank build: ", tostring(err), "\n")
	end
	local after = detectPoBFailure({ }, true)
	if after then
		STDERR:write("[pob-mcp] could not reset to a blank build: ", (after:gsub("\n", " ")), "\n")
	end
	clearPoBErrorState()
end

-- True once a loadXML has succeeded and the active build came from it (the
-- boot-time "Unnamed build" and the blank recovery build do not count).
local buildLoaded = false

-- Load XML into PoB and verify it actually loaded. Returns nil on success or
-- a failure message (PoB's own error text when it reported one).
local function tryLoadBuild(xmlText, name)
	local popupsBefore = currentPopups()
	local ok, err = pcall(loadBuildFromXML, xmlText, name)
	local failure = detectPoBFailure(popupsBefore, true)
	if not failure and not ok then
		failure = "Path of Building failed to load the build: " .. tostring(err)
	end
	if not failure then
		local spec = build and build.spec
		if not (spec and spec.tree and spec.nodes and build.calcsTab and build.calcsTab.mainOutput) then
			failure = "Path of Building did not finish loading the build (no passive tree or calculation output)"
		end
	end
	return failure
end

-- Each handler returns the body of the response, NOT including `ok = true`.
-- The dispatcher adds `ok = true` automatically. If `mutating` is true the
-- dispatcher also calls getStats() after the handler and merges the result
-- into the response body — this encodes the pattern the old if/elseif chain
-- used for equipItem, allocNode, etc.
local DISPATCH = {
	-- Build loading / info
	loadXML = {
		handler = function(cmd)
			local xmlText = cmd.xml or ""
			if not xmlText:find("<PathOfBuilding", 1, true) or not xmlText:find("</PathOfBuilding>", 1, true) then
				userError("Invalid Path of Building XML")
			end
			-- Remembered config tables belong to the build being replaced (a
			-- load PoB rejects puts that build back from XML, as new tables).
			-- XML refused above never reaches PoB: the build, its tables and
			-- the session's undo entries stay as they are, so they are kept.
			ConfigTables.forgetAll()
			-- Capture the current build (including unsaved mutations) so a failed
			-- load can put the engine back exactly where the caller left it.
			local previous = nil
			local m = mainObject.main
			if buildLoaded and m and (m.newMode or m.mode) == "BUILD" and build then
				local okSave, prevXml = pcall(function() return build:SaveDB("mcp-restore") end)
				-- SaveDB reports ComposeXML failures via launch:ShowErrMsg (promptMsg)
				-- rather than throwing; that must not be blamed on the new load.
				local saveErr = mainObject.promptMsg
				if okSave and type(prevXml) == "string" and not saveErr then
					previous = { xml = prevXml, name = build.buildName, identities = itemIdentities() }
				else
					local reason = saveErr and stripColorCodes(saveErr):gsub("%s+", " ")
						or (okSave and "SaveDB returned no XML" or tostring(prevXml))
					STDERR:write("[pob-mcp] warning: could not capture current build before load (",
						reason, "); a failed load will leave no build loaded\n")
				end
				clearPoBErrorState()
			end
			local failure = tryLoadBuild(xmlText, cmd.name or "MCP Build")
			if failure then
				if previous then
					clearPoBErrorState()
					local restoreFailure = tryLoadBuild(previous.xml, previous.name)
					if not restoreFailure then
						-- Same build, same item ids, new item objects: keep their
						-- identities so the session's undo entries still apply.
						carryItemIdentities(previous.identities)
						error(failure .. " (the previously loaded build is still active)", 0)
					end
					STDERR:write("[pob-mcp] failed to restore previous build: ", (restoreFailure:gsub("\n", " ")), "\n")
				end
				recoverBlankBuild()
				buildLoaded = false
				error(failure .. " (the engine now has no build loaded; load a build before continuing)", 0)
			end
			buildLoaded = true
			return { info = getBuildInfo() }
		end,
	},
	getBuildInfo = {
		handler = function(_cmd) return { info = getBuildInfo() } end,
	},
	exportXML = {
		handler = function(_cmd) return { xml = exportBuildXML() } end,
	},
	verifyData = {
		handler = function(_cmd) return { data = verifyData() } end,
	},

	-- Stats / config
	getStats = {
		handler = function(_cmd) return { stats = getStats() } end,
	},
	getConfig = {
		handler = function(_cmd) return { config = getConfig() } end,
	},
	getConfigMetadata = {
		handler = function(_cmd) return { metadata = getConfigMetadata() } end,
	},
	getFullConfig = {
		handler = function(_cmd) return { input = ConfigTables.fullInput() } end,
	},
	setConfig = {
		-- Inline mutation: options loop + rebuild before stats
		handler = function(cmd)
			for key, value in pairs(cmd.options or { }) do
				build.configTab.input[key] = value
			end
			build.configTab:BuildModList()
			build.buildFlag = true
			runCallback("OnFrame")
			return { stats = getStats() }
		end,
	},
	restoreConfig = {
		handler = function(cmd) ConfigTables.restoreInput(cmd.input or { }, cmd.token) return { } end,
		mutating = true,
	},

	-- Items
	getItemInSlot = {
		handler = function(cmd) return { item = getItemInSlot(cmd.slot) } end,
	},
	listEquippedItems = {
		handler = function(_cmd) return { items = listEquippedItems() } end,
	},
	getValidSlots = {
		handler = function(_cmd) return { slots = getValidSlots() } end,
	},
	-- suggest_upgrades: every item slot PoB's calculations use, in PoB's slot
	-- order: gear of the weapon set in use (`Ring 3` only while PoB shows
	-- it), flask slots (`active`; `tincture` when one is there), allocated
	-- passive-tree jewel sockets, abyssal sockets the parent's item has (of
	-- the weapon set in use), tree-gated slots while PoB shows them. Each row:
	-- slot, kind (gear / flask / treeJewel / abyssal / treeGated), occupied.
	upgradeSlots = {
		handler = function(_cmd)
			local tab = build.itemsTab
			local out = { }
			for _, slot in ipairs(tab and tab.orderedSlots or { }) do
				local name = slot.slotName
				if name and not slotChecks.inactiveWeaponSet(slot) and not slotChecks.hiddenReason(slot) then
					local item = tab.items[slot.selItemId or 0]
					local index, count, parent = slotChecks.abyssalSocket(slot)
					local row = nil
					if slot.nodeId then
						if not slotChecks.unallocatedSocket(slot) then row = { kind = "treeJewel" } end
					elseif parent then
						if index <= count then row = { kind = "abyssal", parentSlot = parent.slotName } end
					elseif slotChecks.isFlaskSlot(slot) then
						row = { kind = "flask", active = slot.active == true,
							tincture = slotChecks.flaskKind(item) == "tincture" or nil }
					elseif slotChecks.treeGated[name] then
						row = { kind = "treeGated" }
					elseif name == "Ring 3" then
						local okShown, shown = pcall(function() return slot.shown == nil or slot:shown() end)
						if okShown and shown then row = { kind = "gear" } end
					else
						row = { kind = "gear" }
					end
					if row then
						row.slot, row.occupied = name, item ~= nil
						out[#out + 1] = row
					end
				end
			end
			return { slots = out }
		end,
	},
	equipItem = {
		handler = function(cmd)
			equipItemInSlot(cmd.slot, cmd.itemText or "")
			-- Allowed (PoB's build keeps a jewel in a socket that is later
			-- deallocated; its UI only hides such sockets), but the jewel does
			-- nothing there yet.
			local slot = build.itemsTab.slots[cmd.slot]
			local nodeId = slotChecks.unallocatedSocket(slot)
			if nodeId then
				return { note = "The jewel is equipped, but the socket is not allocated, so Path of Building ignores it. "
					.. slotChecks.socketRemedy(nodeId) }
			end
			-- Allowed too (PoB's UI equips into an inactive flask slot), but the
			-- flask or tincture does nothing until the slot is activated.
			if slotChecks.isFlaskSlot(slot) and not slot.active then
				return { note = "The item is equipped, but " .. cmd.slot .. " is not active, so Path of Building does not "
					.. "apply it. set_flask_active turns the slot on" }
			end
			return { }
		end,
		mutating = true,
	},
	unequipItem = {
		handler = function(cmd) unequipSlot(cmd.slot) return { } end,
		mutating = true,
	},
	checkSlotUsable = {
		-- The same refusal equipItem gives for an unknown or hidden slot,
		-- without changing anything (compare_items checks before probing).
		-- With `whatIf`, an unallocated passive-tree jewel socket is refused
		-- too: a jewel compared there would show no difference at all.
		-- With `whatIf`, so is an inactive flask slot unless `activate` (the
		-- candidates are then evaluated with the slot active); `activate` is
		-- for flask slots only. `flaskActive`: the flask slot's state now.
		handler = function(cmd)
			local slot = slotChecks.usableSlot(cmd.slot, true)
			local nodeId = cmd.whatIf and slotChecks.unallocatedSocket(slot)
			if nodeId then userError(slotChecks.unallocatedText(cmd.slot, nodeId)) end
			local isFlask = slotChecks.isFlaskSlot(slot)
			if cmd.activate ~= nil and not isFlask then
				userError("activate only applies to flask slots (Flask 1 to Flask 5); " .. tostring(cmd.slot) .. " is not one")
			end
			if cmd.whatIf and isFlask and not slot.active and cmd.activate ~= true then
				userError(slotChecks.inactiveFlaskText(cmd.slot, "Pass activate: true to compare the candidates with the slot "
					.. "active, or turn the slot on first with set_flask_active"))
			end
			if isFlask then return { flaskActive = slot.active == true } end
			-- Not refused (the comparison is still what PoB computes), but
			-- an item there counts for nothing: compare_items says so.
			local weaponSet = cmd.whatIf and slotChecks.inactiveWeaponSet(slot)
			if weaponSet then
				return { note = slotChecks.inactiveWeaponSetText(cmd.slot, weaponSet)
					.. ": the candidates show no difference until the build uses that weapon set" }
			end
			return { }
		end,
	},
	-- set_flask_active: PoB's "Activate this flask" check box on a flask slot
	-- holding a flask or tincture (PoB disables the box on an empty slot).
	-- `unchanged` when the slot already has that state. `restore` (undo only)
	-- puts back the exact flags getFlaskState returned, with no other check.
	getFlaskState = {
		handler = function(cmd)
			local slot = slotChecks.flaskSlot(cmd.slot)
			local entry = build.itemsTab.activeItemSet[slot.slotName]
			local item = build.itemsTab.items[slot.selItemId or 0]
			return { active = slot.active == true, occupied = item ~= nil,
				flags = { slotChecks.flagCode(slot.active), slotChecks.flagCode(entry and entry.active) } }
		end,
	},
	setFlaskActive = {
		handler = function(cmd)
			local slot = slotChecks.flaskSlot(cmd.slot)
			local tab = build.itemsTab
			if cmd.restore ~= nil then
				local r = cmd.restore
				if type(r) ~= "table" or type(r[1]) ~= "number" or type(r[2]) ~= "number" then
					error("setFlaskActive: malformed restore flags", 0)
				end
				slotChecks.setFlaskFlags(slot, slotChecks.flagValue(r[1]), slotChecks.flagValue(r[2]))
				build.buildFlag = true
				runCallback("OnFrame")
				return { slot = slot.slotName, active = slot.active == true }
			end
			if type(cmd.active) ~= "boolean" then userError("active must be true or false") end
			local item = tab.items[slot.selItemId or 0]
			if not item then
				userError(slot.slotName .. " is empty: Path of Building only lets a flask slot holding a flask or tincture be "
					.. "turned on or off. Equip one first (swap_item)")
			end
			local entry = tab.activeItemSet[slot.slotName]
			local result = { slot = slot.slotName, active = cmd.active, previous = slot.active == true,
				item = item.title or item.name, itemType = item.type }
			if (slot.active == true) == cmd.active and (entry == nil or (entry.active == true) == cmd.active) then
				result.unchanged = true
				return result
			end
			slotChecks.setFlaskFlags(slot, cmd.active, cmd.active)
			build.buildFlag = true
			-- Test fault: the command fails after the change is in, before PoB
			-- recalculates (never on a replay).
			if TEST_FAULTS.flaskFailsAfterChange and cmd.replay ~= true then
				error("test fault: set_flask_active failed after changing the build", 0)
			end
			runCallback("OnFrame")
			return result
		end,
	},
	selectItem = {
		-- Re-select an item the build already holds; `selected` is false (nothing
		-- changed) when the id is gone or holds a different item than `itemText`.
		handler = function(cmd)
			return { selected = selectItemInSlot(cmd.slot, cmd.itemId, cmd.itemText) }
		end,
	},
	captureItemsState = {
		handler = function(_cmd) return { state = captureItemsState() } end,
	},
	restoreItemsState = {
		handler = function(cmd) return restoreItemsState(cmd.state) end,
	},
	checkItemsState = {
		-- Raises when the captured ids no longer name the captured items.
		handler = function(cmd) checkItemsState(cmd.state) return { } end,
	},

	-- Passive tree
	getAllocatedNodes = {
		handler = function(_cmd) return { nodeIds = getAllocatedNodeIds() } end,
	},
	getAllocatedNodesDetailed = {
		handler = function(_cmd) return { nodes = getAllocatedNodesDetailed() } end,
	},
	getReachableNodes = {
		handler = function(_cmd) return { nodes = getReachableNodesList() } end,
	},
	getNodeInfo = {
		handler = function(cmd) return { node = getNodeInfo({ nodeId = cmd.nodeId, name = cmd.name }) } end,
	},
	isTreeConnected = {
		handler = function(_cmd) return { result = isTreeConnected() } end,
	},
	getPassiveTreeSummary = {
		handler = function(_cmd) return { summary = getPassiveTreeSummary() } end,
	},
	allocNode = {
		handler = function(cmd) allocNodeById(cmd.nodeId) return { } end,
		mutating = true,
	},
	deallocNode = {
		handler = function(cmd) deallocNodeById(cmd.nodeId) return { } end,
		mutating = true,
	},
	allocNodes = {
		-- `masteries`: [{ node, effect }] (allocate_nodes: ids or names; a
		-- crash replay: the ids recorded, its nodeIds listing the masteries it
		-- allocated in join order).
		handler = function(cmd)
			local strict = cmd.strict == true
			local skip = { }
			for _, id in ipairs(type(cmd.nodeIds) == "table" and cmd.nodeIds or { }) do skip[id] = true end
			local masteries = nodeBatch.resolveMasteries(cmd.masteries, { replay = not strict, skip = strict and skip or nil })
			if strict and #masteries > 0 and #(cmd.nodeIds or { }) == 0 and nodeBatch.allNoop(masteries) then
				return nodeBatch.unchanged(masteries)
			end
			return allocNodesBatch(cmd.nodeIds or { }, strict, masteries)
		end,
		mutating = true,
	},
	masteryOptions = {
		handler = function(cmd) return { masteries = nodeBatch.masteryOptions(cmd.nodes) } end,
	},
	respecTree = {
		-- plan_respec only, between a tree snapshot and its exact restore.
		handler = function(cmd) return nodeBatch.respec(cmd) end,
		mutating = true,
	},
	deallocNodes = {
		handler = function(cmd) return deallocNodesBatch(cmd.nodeIds or { }, cmd.strict == true) end,
		mutating = true,
	},
	treeEditApplied = {
		-- Whether the previous command ran a strict node batch, and what it
		-- changed if it changed the tree.
		handler = function(_cmd)
			local record = nodeBatch.record
			nodeBatch.record = nil
			return { started = record ~= nil, applied = record and record.applied or dkjson.null }
		end,
	},
	buildEditApplied = {
		-- Whether the previous command (applyChanges, createSocketGroup,
		-- deleteSocketGroup, setMainSkill) started changing the build, and
		-- what it changed if the whole change went in.
		handler = function(_cmd)
			local record = buildEdit.record
			buildEdit.record = nil
			return { started = record ~= nil, applied = record and record.applied or dkjson.null }
		end,
	},
	restoreTreeFromList = {
		handler = function(cmd)
			local missing = restoreTreeFromIds(cmd.nodeIds or { })
			if #missing > 0 then
				return { missingNodeIds = missing }
			end
			return { }
		end,
		mutating = true,
	},
	captureSpecState = {
		handler = function(_cmd)
			if type(build.spec) ~= "table" then
				userError("No build loaded — call load_build first")
			end
			return { state = encodeSpecState(captureSpecState(build.spec)) }
		end,
	},
	restoreTreeState = {
		handler = function(cmd) return restoreTreeState(cmd.state) end,
		mutating = true,
	},
	verifyTreeState = {
		handler = function(cmd) return verifyTreeState(cmd.state) end,
	},
	convertTreeToLatest = {
		handler = function(_cmd) return { result = convertTreeToLatest() } end,
		mutating = true,
	},
	restoreSpecState = {
		handler = function(cmd) restoreSpecState(cmd.state) return { } end,
		mutating = true,
	},

	-- Skills / gems
	getSkillBreakdown = {
		handler = function(cmd) return { breakdown = getSkillBreakdown(cmd.index) } end,
	},
	getSocketGroups = {
		handler = function(_cmd) return { groups = getSocketGroups() } end,
	},
	getGemByName = {
		handler = function(cmd)
			local gem, errMsg = getGemByNameImpl(cmd.name)
			if not gem then
				userError(errMsg or ("Gem not found: " .. tostring(cmd.name)))
			end
			return { gem = gem }
		end,
	},
	getAvailableSupports = {
		handler = function(cmd) return { supports = getAvailableSupports(cmd.activeSkillTags, cmd.includeAwakened) } end,
	},
	setGem = {
		handler = function(cmd) setGemImpl(cmd.groupIndex, cmd.gemIndex, cmd.gemName, cmd.level, cmd.quality) return { } end,
		mutating = true,
	},
	setGemLevel = {
		handler = function(cmd) setGemLevelImpl(cmd.groupIndex, cmd.gemIndex, cmd.level, cmd.quality) return { } end,
		mutating = true,
	},
	removeGem = {
		handler = function(cmd) removeGemImpl(cmd.groupIndex, cmd.gemIndex) return { } end,
		mutating = true,
	},
	addGem = {
		-- Returns gemIndex alongside stats; inline the stats call to include both.
		handler = function(cmd)
			local newIndex = addGemImpl(cmd.groupIndex, cmd.gemName, cmd.level, cmd.quality, cmd.position)
			return { stats = getStats(), gemIndex = newIndex }
		end,
	},
	setMainSocketGroup = {
		handler = function(cmd) buildEdit.setMainSocketGroup(cmd.groupIndex) return { } end,
		mutating = true,
	},
	createSocketGroup = {
		handler = function(cmd) return buildEdit.createSocketGroup(cmd) end,
	},
	deleteSocketGroup = {
		handler = function(cmd) return buildEdit.deleteSocketGroup(cmd) end,
	},
	setMainSkill = {
		handler = function(cmd) return buildEdit.setMainSkill(cmd) end,
	},
	snapshotSkills = {
		handler = function(_cmd) return { snapshot = snapshotSkills() } end,
	},
	restoreSkills = {
		handler = function(cmd) restoreSkills(cmd.snapshot) return { } end,
		mutating = true,
	},
	-- Atomically replace a socket group's gem list and recalculate once.
	-- Saves (N_remove + N_add - 1) OnFrame calls compared to individual
	-- removeGem/addGem round-trips. Used by testSupportCombinationLocked.
	replaceSocketGroup = {
		handler = function(cmd) replaceSocketGroupImpl(cmd.groupIndex, cmd.gems) return { } end,
		mutating = true,
	},

	-- Batched read-only snapshot for diagnoseBuild: assembles stats, items,
	-- skill groups, allocated tree nodes, and passive-tree summary in a single
	-- Lua call so the TS side needs only one bridge round-trip and one lock
	-- acquisition instead of the previous 4+ sequential withLock calls.
	-- All five helpers (getStats, listEquippedItems, getSocketGroups,
	-- getAllocatedNodesDetailed, getPassiveTreeSummary) are already top-level
	-- functions, so we call them directly — no duplication needed (option B).
	diagnoseSnapshot = {
		handler = function(_cmd)
			return {
				stats = getStats(),
				items = listEquippedItems(),
				groups = getSocketGroups(),
				allocatedNodes = getAllocatedNodesDetailed(),
				passiveTreeSummary = getPassiveTreeSummary(),
			}
		end,
	},

	-- Trade searches (read-only: the build is never changed)
	tradeQuery = {
		handler = function(cmd) return runTradeQuery(cmd) end,
	},
	searchTradeMods = {
		handler = function(cmd) return searchTradeMods(cmd) end,
	},
	visceraCandidates = {
		handler = function(cmd) return tradeCompat.visceraCandidates(cmd) end,
	},
	tradeScores = {
		handler = function(cmd) return tradeCompat.tradeScores(cmd) end,
	},

	-- Utility
	ping = {
		handler = function(_cmd) return { } end,
	},
	-- Diagnostics for the engine-safety test suite. Every path must be inside
	-- the PoB install (anything else is refused up front). "read" opens an
	-- existing file in "rb" only; write probes (open/remove/rename) only
	-- accept targets that do NOT exist, with a fixed set of modes, so even a
	-- broken guard could not modify an existing install file.
	engineSelfTest = {
		handler = function(cmd)
			local op = cmd.op
			if op == "guard" then
				local function requireInside(p)
					if type(p) ~= "string" or not isProtectedPath(p) then
						userError("engineSelfTest guard probes only accept paths inside the PoB install")
					end
				end
				local function requireAbsent(p)
					local f = raw_io_open(p, "rb")
					if f then f:close() end
					if f or NewFileSearch(p, true) or NewFileSearch(p) then
						userError("engineSelfTest write probes only accept non-existent targets: " .. p)
					end
				end
				local action = cmd.action
				if action == "read" then
					requireInside(cmd.path)
					local f = io.open(cmd.path, "rb")
					if not f then return { opened = false } end
					local content = f:read(16) or ""
					f:close()
					return { opened = true, bytesRead = #content }
				end
				local PROBE_MODES = { w = true, ["wb+"] = true, a = true, ["r+"] = true, rD = true, rbD = true }
				local r1, r2
				if action == "open" then
					requireInside(cmd.path)
					requireAbsent(cmd.path)
					if not PROBE_MODES[cmd.mode] then
						userError("Unsupported probe mode: " .. tostring(cmd.mode))
					end
					local f, msg = io.open(cmd.path, cmd.mode)
					if f then
						f:close()
						return { opened = true }
					end
					r1, r2 = nil, msg
				elseif action == "remove" then
					requireInside(cmd.path)
					requireAbsent(cmd.path)
					r1, r2 = os.remove(cmd.path)
				elseif action == "rename" then
					requireInside(cmd.path)
					requireInside(cmd.to)
					requireAbsent(cmd.path)
					requireAbsent(cmd.to)
					r1, r2 = os.rename(cmd.path, cmd.to)
				else
					userError("Unknown guard action: " .. tostring(action))
				end
				return { opened = false, result = r1 and true or false, message = r2 and tostring(r2) or dkjson.null }
			elseif op == "zlib" then
				local result = { available = zlibInfo.available, version = zlibInfo.version }
				if not zlibInfo.available then return result end
				if cmd.text then
					local packed = Deflate(cmd.text)
					result.deflatedSize = packed and #packed or dkjson.null
					result.roundTrip = packed ~= nil and Inflate(packed) == cmd.text
				end
				if cmd.file then
					if not isProtectedPath(cmd.file) then
						userError("engineSelfTest zlib probes only read files inside the PoB install")
					end
					local f = io.open(cmd.file, "rb")
					if not f then userError("Cannot read " .. tostring(cmd.file)) end
					local compressed = f:read("*a")
					f:close()
					local inflated = Inflate(compressed)
					result.inflatedSize = inflated and #inflated or dkjson.null
					result.inflatedHead = inflated and inflated:sub(1, 64):gsub(".", function(c)
						return string.format("%02x", c:byte())
					end) or dkjson.null
				end
				return result
			elseif op == "fileSearch" then
				if type(cmd.pattern) ~= "string" or not isProtectedPath(cmd.pattern) then
					userError("engineSelfTest fileSearch only accepts patterns inside the PoB install")
				end
				local h = NewFileSearch(cmd.pattern, cmd.dirOnly)
				local found = { }
				while h do
					found[#found + 1] = { name = h:GetFileName(), size = h:GetFileSize(), modified = h:GetFileModifiedTime() }
					if not h:NextFile() then break end
				end
				return { files = found }
			elseif op == "print" then
				print(cmd.text or "pob-mcp print probe")
				io.write(cmd.text or "pob-mcp io.write probe", "\n")
				ConPrintf("%s", cmd.text or "pob-mcp ConPrintf probe")
				return { }
			elseif op == "status" then
				return {
					installRoot = INSTALL_ROOT,
					cwd = CWD,
					blockedWrites = guardStats.blockedWrites,
					lastBlocked = guardStats.lastBlocked or dkjson.null,
					zlib = zlibInfo.available,
				}
			end
			userError("Unknown engineSelfTest op: " .. tostring(op))
		end,
	},
	shutdown = {
		-- Special: respond and exit immediately; dispatcher's ok=true injection never fires.
		handler = function(_cmd)
			respond({ ok = true })
			os.exit(0)
		end,
	},
}

-- Read-only what-if probes through PoB's calculator (lua/probe.lua). `probe`
-- never changes the committed build; `probeCommit` applies one variant for
-- real and is only sent between a full snapshot and its restore.
do
	local source = debug.getinfo(1, "S").source
	local bridgeDir = (source:sub(1, 1) == "@" and source:sub(2) or (arg and arg[0] or "")):match("^(.*)[/\\][^/\\]*$") or "."
	local probe = dofile(bridgeDir .. "/probe.lua")({
		userError = userError,
		USER_ERROR_PREFIX = USER_ERROR_PREFIX,
		jsonNull = dkjson.null,
		statKeys = statKeys,
		copyValue = copyValue,
		parseItemText = parseItemText,
		assertItemFitsSlot = assertItemFitsSlot,
		usableSlot = slotChecks.usableSlot,
		unallocatedSocketText = slotChecks.unallocatedText,
		isFlaskSlot = slotChecks.isFlaskSlot,
		flaskSlot = slotChecks.flaskSlot,
		setFlaskFlags = slotChecks.setFlaskFlags,
		inactiveFlaskText = slotChecks.inactiveFlaskText,
		clusterParent = slotChecks.clusterParent,
		construct = construct,
		findGemByName = findGemByName,
		getConfigMetadata = getConfigMetadata,
		equipItemInSlot = equipItemInSlot,
		detachConfigTables = ConfigTables.detach,
		restoreConfigTables = ConfigTables.restore,
		stashCommittedConfigTables = ConfigTables.stashCommitted,
		sameConfigValue = ConfigTables.sameValue,
		allocNodesBatch = allocNodesBatch,
		deallocNodesBatch = deallocNodesBatch,
		pumpAndRead = pumpAndRead,
		nodeBatch = nodeBatch,
		buildEdit = buildEdit,
	})
	DISPATCH.probe = {
		handler = function(cmd)
			local res = probe.probe(cmd)
			if cmd.fingerprint and buildEdit.rollbackInexact then
				-- Test fault (buildEditRollbackInexact): see buildEdit.testFaultMidway.
				-- Only the read that checks a build edit's rollback
				-- (`rollbackCheck`) gets the extra line; any other fingerprint
				-- read disarms the fault (the rollback failed before its check).
				buildEdit.rollbackInexact = nil
				if cmd.rollbackCheck == true then
					res.fingerprint[#res.fingerprint + 1] = "testFault|buildEditRollbackInexact"
				end
			end
			return res
		end,
	}
	-- The committed state by value, for the trade search's flask activation.
	tradeCompat.fingerprint = function() return probe.probe({ fingerprint = true }).fingerprint end
	DISPATCH.probeCommit = { handler = function(cmd) return probe.probeCommit(cmd) end }
	-- apply_changes: one probe variant applied for real and kept.
	DISPATCH.applyChanges = { handler = function(cmd) return probe.applyChanges(cmd) end }

	-- compare_builds: everything the comparison of two builds reads, in one
	-- read-only call: build info, the `stats` keys (as `probe` reads the
	-- committed build), allocated passive nodes, items by slot, socket groups
	-- and the config input. Changes nothing. (Helpers are locals of the
	-- handler: the main chunk is at Lua's limit of 200 locals.)
	DISPATCH.compareSnapshot = {
		handler = function(cmd)
			local stats = probe.probe({ stats = cmd.stats or statKeys }).base
			local spec = build.spec
			local points, ascPoints = 0, 0
			if spec and spec.CountAllocNodes then points, ascPoints = spec:CountAllocNodes() end
			local nodes = { }
			for id, node in pairs(spec and spec.allocNodes or { }) do
				local effectId = node.type == "Mastery" and spec.masterySelections and spec.masterySelections[id] or nil
				nodes[#nodes + 1] = {
					id = id,
					name = node.dn,
					type = node.type,
					ascendancy = node.ascendancyName,
					effect = effectId and masteryEffectText(spec, effectId) or nil,
				}
			end
			table.sort(nodes, function(a, b) return a.id < b.id end)

			local function modLines(item)
				local out = { }
				local function add(lines, tag)
					for _, ml in ipairs(lines or { }) do
						local active = not item.CheckModLineVariant or item:CheckModLineVariant(ml)
						if ml.line and active then
							local prefix = tag or (ml.crafted and "{crafted}" or (ml.fractured and "{fractured}" or ""))
							out[#out + 1] = prefix .. stripColorCodes(ml.line)
						end
					end
				end
				add(item.enchantModLines, "{enchant}")
				add(item.scourgeModLines, "{scourge}")
				add(item.implicitModLines, "{implicit}")
				add(item.explicitModLines, nil)
				return out
			end
			local function socketText(item)
				local parts = { }
				for i, socket in ipairs(item.sockets or { }) do
					parts[#parts + 1] = tostring(socket.color or "?")
					local nextSocket = item.sockets[i + 1]
					if nextSocket then parts[#parts + 1] = socket.group == nextSocket.group and "-" or " " end
				end
				return #parts > 0 and table.concat(parts) or nil
			end
			local items = { }
			local tab = build.itemsTab
			local function addItem(slotName, itemId, flags)
				local item = itemId and itemId ~= 0 and tab.items[itemId]
				if not item then return end
				items[#items + 1] = {
					slot = slotName,
					name = item.title or item.name,
					base = item.baseName,
					rarity = item.rarity,
					quality = item.quality,
					sockets = socketText(item),
					corrupted = item.corrupted or nil,
					hidden = flags.hidden,
					swap = flags.swap,
					inactive = flags.inactive,
					flaskActive = flags.flaskActive,
					mods = modLines(item),
				}
			end
			local useSecond = tab and tab.activeItemSet and tab.activeItemSet.useSecondWeaponSet
			for _, slot in ipairs(tab and tab.orderedSlots or { }) do
				-- Passive-tree socket slots ("Jewel <nodeId>") keep their item
				-- after the socket is deallocated: they are listed from
				-- spec.jewels below, allocated sockets only.
				if slot.slotName and not slot.nodeId then
					local inactive = nil
					-- The weapon set not in use, and an abyss jewel in a socket
					-- its parent item does not have: PoB's CalcSetup skips both.
					if slot.weaponSet and slot.weaponSet ~= (useSecond and 2 or 1) then inactive = true end
					if slot.parentSlot then
						local parentId = slot.parentSlot.selItemId or 0
						local parent = parentId ~= 0 and tab.items[parentId] or nil
						if not parent or (parent.abyssalSocketCount or 0) < (slot.slotNum or 0) then inactive = true end
					end
					-- Flask slots: PoB applies the flask or tincture only while
					-- the slot is active (its "Activate this flask" box).
					local flaskActive = nil
					if slotChecks.isFlaskSlot(slot) then flaskActive = slot.active == true end
					addItem(slot.slotName, slot.selItemId, {
						hidden = slotChecks.hiddenGate(slot) and true or nil,
						swap = slot.weaponSet == 2 or nil,
						inactive = inactive,
						flaskActive = flaskActive,
					})
				end
			end
			-- Jewels in allocated passive-tree sockets (part of the tree
			-- state), by node id so both sides list them in the same order.
			local socketIds = { }
			for nodeId in pairs(spec and spec.jewels or { }) do
				if spec.allocNodes and spec.allocNodes[nodeId] then socketIds[#socketIds + 1] = nodeId end
			end
			table.sort(socketIds)
			for _, nodeId in ipairs(socketIds) do
				addItem("Tree jewel " .. tostring(nodeId), spec.jewels[nodeId], { })
			end

			local groups = { }
			for i, group in ipairs(build.skillsTab and build.skillsTab.socketGroupList or { }) do
				local gems = { }
				for j, gem in ipairs(group.gemList or { }) do
					local gd = gem.gemData
					local ge = (gd and gd.grantedEffect) or gem.grantedEffect
					gems[j] = {
						name = (gd and gd.name) or (ge and ge.name) or gem.nameSpec or "",
						level = gem.level,
						quality = gem.quality,
						enabled = gem.enabled ~= false,
						support = (ge and ge.support) and true or false,
					}
				end
				groups[i] = {
					label = group.label ~= "" and group.label or nil,
					slot = group.slot ~= "" and group.slot or nil,
					enabled = group.enabled ~= false,
					source = group.source,
					main = build.mainSocketGroup == i or nil,
					gems = gems,
				}
			end
			return {
				info = getBuildInfo(),
				stats = stats,
				tree = { points = points, ascendancyPoints = ascPoints, nodes = nodes },
				items = items,
				groups = groups,
				config = ConfigTables.fullInput(),
			}
		end,
	}
end

-- Item data (search_items, get_item_text, list_item_mods, build_item): PoB's
-- own unique list (main.uniqueDB), item bases, affixes with their spawn
-- weights (Item:CanHaveMod, as the items tab's crafting dropdowns filter them)
-- and crafting bench mods (data.masterMods). Items are made with PoB's Item
-- class (BuildAndParseRaw, Craft, BuildRaw) and never added to the build:
-- these commands change nothing. (A `do` block: the main chunk is at Lua's
-- limit of 200 locals.)
do
	local itemData = {
		ROLLS = { max = 1, min = 0, avg = 0.5 },
		LINE_CAP = 160,
		SUMMARY_LINES = 6,
		VARIANT_CAP = 20,
		templates = { },
	}

	function itemData.trim(s)
		return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", ""))
	end

	function itemData.lower(s)
		return itemData.trim(s):lower()
	end

	function itemData.clip(s)
		local text = stripColorCodes(tostring(s or "")):gsub("\n", " / ")
		if #text > itemData.LINE_CAP then text = text:sub(1, itemData.LINE_CAP - 3) .. "..." end
		return text
	end

	function itemData.roll(name)
		if name == nil or name == dkjson.null then return itemData.ROLLS.max end
		local roll = itemData.ROLLS[name]
		if not roll then userError("roll must be max, min or avg") end
		return roll
	end

	-- PoB fills main.uniqueDB in an OnFrame coroutine after startup; finish it
	-- here (its own loader) if a command comes first.
	function itemData.uniques()
		if itemData.uniqueArray then return itemData.uniqueArray end
		local m = mainObject.main
		local db = m and m.uniqueDB
		if not db then error("Path of Building's unique item list is not available", 0) end
		local guard = 0
		while db.loading and m.onFrameFuncs and m.onFrameFuncs["LoadItems"] and guard < 100000 do
			m.onFrameFuncs["LoadItems"]()
			guard = guard + 1
		end
		if db.loading then error("Path of Building's unique item list did not finish loading", 0) end
		local list = { }
		for _, item in pairs(db.list) do list[#list + 1] = item end
		table.sort(list, function(a, b) return a.name < b.name end)
		itemData.uniqueArray = list
		return list
	end

	function itemData.primarySlot(base)
		if base.weapon then return "Weapon 1" end
		local t = base.type
		if t == "Quiver" or t == "Shield" then return "Weapon 2" end
		if t == "Ring" then return "Ring 1" end
		if t == "Flask" or t == "Tincture" then return "Flask 1" end
		if t == "Graft" then return "Graft 1" end
		return t
	end

	-- `slot` as list_valid_slots names it ("Ring 1", "Weapon 2 Swap") or an item
	-- type ("Body Armour", "Two Handed Sword", "Flask", "Jewel: Abyss").
	function itemData.slotFilter(slot)
		if slot == nil or slot == dkjson.null then return nil end
		local s = itemData.lower(slot):gsub(" swap$", "")
		local key = s:match("^(.-) %d+$") or s
		local function matches(base)
			local t = base.type:lower()
			if key == "weapon" then
				if s == "weapon 2" then
					local info = data.weaponTypeInfo and data.weaponTypeInfo[base.type]
					return t == "shield" or t == "quiver" or (base.weapon ~= nil and info ~= nil and info.oneHand == true)
				end
				return base.weapon ~= nil
			end
			if key == "flask" then return t == "flask" or t == "tincture" end
			if t == key then return true end
			if base.subType and (base.subType:lower() == key or (t .. ": " .. base.subType:lower()) == key) then return true end
			return false
		end
		for _, base in pairs(data.itemBases) do
			if matches(base) then return matches end
		end
		userError("No item base fits slot or item type \"" .. itemData.trim(slot) .. "\" (use a slot name such as \"Body Armour\", \"Ring 1\", \"Weapon 1\" or an item type such as \"Two Handed Sword\")")
	end

	-- 0 exact, 1 prefix, 2 contains, 3 found only in `extra` (base, type), nil no match.
	function itemData.rank(needle, name, extra)
		if needle == "" then return 3 end
		local n = name:lower()
		if n == needle then return 0 end
		if n:sub(1, #needle) == needle then return 1 end
		if n:find(needle, 1, true) then return 2 end
		for _, e in ipairs(extra) do
			if e and e:lower():find(needle, 1, true) then return 3 end
		end
		return nil
	end

	function itemData.activeLines(item, lines, cap)
		local out, more = { }, 0
		for _, ml in ipairs(lines or { }) do
			if item:CheckModLineVariant(ml) then
				if #out < cap then out[#out + 1] = itemData.clip(ml.line) else more = more + 1 end
			end
		end
		return out, more
	end

	function itemData.hasModText(item, needle)
		for _, key in ipairs({ "implicitModLines", "explicitModLines" }) do
			for _, ml in ipairs(item[key] or { }) do
				if tostring(ml.line):lower():find(needle, 1, true) then return true end
			end
		end
		return false
	end

	function itemData.variantNames(item)
		if not item.variantList then return nil, nil end
		local names = { }
		for i = 1, math.min(#item.variantList, itemData.VARIANT_CAP) do names[i] = item.variantList[i] end
		local more = #item.variantList - #names
		return names, more > 0 and more or nil
	end

	function itemData.describeUnique(item)
		local implicits = itemData.activeLines(item, item.implicitModLines, 4)
		local mods, more = itemData.activeLines(item, item.explicitModLines, itemData.SUMMARY_LINES)
		local variants, variantsMore = itemData.variantNames(item)
		return {
			kind = "unique",
			name = item.title,
			base = item.baseName,
			type = item.base.type,
			subType = item.base.subType,
			slot = itemData.primarySlot(item.base),
			levelReq = item.requirements and item.requirements.level or nil,
			variants = variants,
			variantsMore = variantsMore,
			variant = item.variantList and item.variantList[item.variant] or nil,
			implicits = #implicits > 0 and implicits or nil,
			mods = mods,
			modsMore = more > 0 and more or nil,
		}
	end

	function itemData.describeBase(name, base)
		local implicits = { }
		for line in tostring(base.implicit or ""):gmatch("[^\n]+") do implicits[#implicits + 1] = itemData.clip(line) end
		local req = base.req or { }
		return {
			kind = "base",
			name = name,
			type = base.type,
			subType = base.subType,
			slot = itemData.primarySlot(base),
			levelReq = req.level,
			str = req.str, dex = req.dex, int = req.int,
			implicits = #implicits > 0 and implicits or nil,
		}
	end

	function itemData.searchCommand(cmd)
		local needle = itemData.lower(cmd.query)
		local modNeedle = (cmd.modQuery ~= nil and cmd.modQuery ~= dkjson.null) and itemData.lower(cmd.modQuery) or nil
		if modNeedle == "" then modNeedle = nil end
		local kind = cmd.kind or "any"
		local slotOk = itemData.slotFilter(cmd.slot)
		local found = { }
		if kind ~= "base" then
			for _, item in ipairs(itemData.uniques()) do
				if not slotOk or slotOk(item.base) then
					local rank = itemData.rank(needle, item.title, { item.baseName, item.base.type, item.base.subType })
					if rank and (not modNeedle or itemData.hasModText(item, modNeedle)) then
						found[#found + 1] = { rank = rank, order = 1, name = item.name, item = item }
					end
				end
			end
		end
		if kind ~= "unique" then
			for name, base in pairs(data.itemBases) do
				if not base.hidden and (not slotOk or slotOk(base)) then
					local rank = itemData.rank(needle, name, { base.type, base.subType })
					if rank and (not modNeedle or tostring(base.implicit or ""):lower():find(modNeedle, 1, true)) then
						found[#found + 1] = { rank = rank, order = 2, name = name, base = base }
					end
				end
			end
		end
		table.sort(found, function(a, b)
			if a.rank ~= b.rank then return a.rank < b.rank end
			if a.order ~= b.order then return a.order < b.order end
			return a.name < b.name
		end)
		local limit = tonumber(cmd.limit) or 20
		local results = { }
		for i = 1, math.min(limit, #found) do
			local f = found[i]
			results[i] = f.item and itemData.describeUnique(f.item) or itemData.describeBase(f.name, f.base)
		end
		return { total = #found, more = math.max(0, #found - #results), results = results }
	end

	-- A unique by title ("Kaom's Heart") or full name ("Grand Spectrum, Cobalt Jewel").
	function itemData.findUnique(name)
		local low = itemData.lower(name)
		local matches, similar = { }, { }
		for _, item in ipairs(itemData.uniques()) do
			if item.name:lower() == low then return item end
			if item.title:lower() == low then
				matches[#matches + 1] = item.name
			elseif #similar < 5 and #low > 0 and item.name:lower():find(low, 1, true) then
				similar[#similar + 1] = item.title
			end
		end
		if #matches == 1 then
			for _, item in ipairs(itemData.uniques()) do
				if item.name == matches[1] then return item end
			end
		end
		if #matches > 1 then
			userError("\"" .. itemData.trim(name) .. "\" names several uniques: " .. table.concat(matches, "; ") .. " (pass the full name)")
		end
		userError("Unknown unique \"" .. itemData.trim(name) .. "\"" ..
			(#similar > 0 and (" (did you mean: " .. table.concat(similar, "; ") .. "?)") or "") .. "; use search_items")
	end

	-- A base by exact name, then case-insensitively.
	function itemData.findBase(name)
		local wanted = itemData.trim(name)
		if data.itemBases[wanted] then return wanted, data.itemBases[wanted] end
		local low = wanted:lower()
		local similar = { }
		for baseName, base in pairs(data.itemBases) do
			if baseName:lower() == low then return baseName, base end
			if not base.hidden and #low > 0 and baseName:lower():find(low, 1, true) then similar[#similar + 1] = baseName end
		end
		table.sort(similar)
		while #similar > 5 do table.remove(similar) end
		userError("Unknown item base \"" .. wanted .. "\"" ..
			(#similar > 0 and (" (did you mean: " .. table.concat(similar, "; ") .. "?)") or "") .. "; use search_items with kind \"base\"")
	end

	function itemData.setRoll(lines, roll)
		for _, ml in ipairs(lines or { }) do
			if type(ml.line) == "string" and ml.line:match("%(%-?[%d%.]+%-%-?[%d%.]+%)") then ml.range = roll end
		end
	end

	-- A new item on `base`, as the items tab's "Craft item" popup makes it
	-- (ItemsTab:CraftItem's makeItem): base implicits, PoB's default quality,
	-- `crafted` for magic and rare so PoB tracks its prefixes and suffixes.
	function itemData.newItem(baseName, base, rarity, title)
		local item = construct("Item")
		item.name = baseName
		item.base = base
		item.baseName = baseName
		item.buffModLines, item.enchantModLines, item.classRequirementModLines = { }, { }, { }
		item.scourgeModLines, item.implicitModLines, item.explicitModLines, item.crucibleModLines = { }, { }, { }, { }
		local t = base.type
		if t == "Amulet" or t == "Belt" or t == "Jewel" or t == "Quiver" or t == "Ring" or t == "Graft" then
			item.quality = nil
		else
			item.quality = 0
		end
		item.rarity = rarity
		if rarity == "MAGIC" or rarity == "RARE" then item.crafted = true end
		if rarity == "RARE" then item.title = title or "New Item" end
		if base.implicit then
			local index = 1
			for line in base.implicit:gmatch("[^\n]+") do
				local modList, extra = modLib.parseMod(line)
				item.implicitModLines[#item.implicitModLines + 1] = {
					line = line, extra = extra, modList = modList or { },
					modTags = base.implicitModTypes and base.implicitModTypes[index] or { },
				}
				index = index + 1
			end
		end
		item:NormaliseQuality()
		return item
	end

	function itemData.rolledLines(item, lines, suffix)
		local out = { }
		for _, ml in ipairs(lines or { }) do
			if item:CheckModLineVariant(ml) then
				local line = itemLib.applyRange(ml.line, ml.range or main.defaultItemAffixQuality or 0.5, ml.valueScalar)
				out[#out + 1] = itemData.clip(line) .. ((suffix and ml.crafted) and " (crafted)" or "")
			end
		end
		return out
	end

	-- Spec names PoB's ParseRaw reads from "Name: value" lines (Item:ParseRaw),
	-- plus the header lines it reads before them.
	itemData.HEADER_SPECS = { }
	for name in ([[Allow Duplicate Variants|Armour|Attacks per Second|Block chance|Catalyst|CatalystQuality|Chance to Block|Chaos Damage|Cluster Jewel Node Count|Cluster Jewel Skill|Crafted|Critical Strike Chance|Critical Strike Range|Crucible|Dex|Dexterity|Elemental Damage|Energy Shield|Evasion Rating|Evasion|Has Alt Variant Five|Has Alt Variant Four|Has Alt Variant Three|Has Alt Variant Two|Has Alt Variant|Has Variants|Implicit|Implicits|Int|Intangibility|Intelligence|Item Level|League|Level|LevelReq|Limited to|Memory Strands|Note|Physical Damage|Prefix|Quality|Radius|Requires Class|Requires Level|Scourge|Selected Alt Variant Five|Selected Alt Variant Four|Selected Alt Variant Three|Selected Alt Variant Two|Selected Alt Variant|Selected Variant Group|Selected Variant|Selected Variants|Selected Version|Sockets|Source|Str|Strength|Suffix|Talisman Tier|Unique ID|Unreleased|Upgrade|Variant|Version|Ward|Weapon Range|Rarity|Item Class|Class:]]):gmatch("[^|]+") do
		itemData.HEADER_SPECS[name] = true
	end
	itemData.FLAG_LINES = { ["--------"] = true, Split = true, Mirrored = true, Corrupted = true, ["Fractured Item"] = true,
		["Synthesised Item"] = true, Unidentified = true, ["Requirements:"] = true, ["Prefixes:"] = true,
		["Veiled Prefix"] = true, ["Veiled Suffix"] = true }

	-- Why PoB's ParseRaw would read `line` as an item header or flag instead
	-- of a modifier ("Corrupted", "Shaper Item", "Quality: 30", "--------"),
	-- or nil. In a name or an implicit such a line would change the item
	-- behind build_item's checks.
	function itemData.headerReason(line)
		if itemData.FLAG_LINES[line] or line:find("Foil Unique", 1, true) then return "is an item flag line" end
		for _, info in ipairs(itemLib.influenceInfo.all) do
			if line == info.display .. " Item" then return "is an influence line (use influences)" end
		end
		if line:match("^{") then return "starts with a { } tag" end
		if line:match("^%(%a") or line:match("^%(%d+%%? of ") then return "is read as reminder text" end
		local spec = line:match("^([%a %(%)]+:?): .+$")
		if spec and (itemData.HEADER_SPECS[spec] or spec:match("BasePercentile") or spec:match("^Quality %(")) then
			return "is read as the item header \"" .. spec .. "\""
		end
		if line:match("^Requires %a+ ") then return "is read as an item requirement" end
		return nil
	end

	-- Why an implicit line PoB keeps as a modifier but reads as a crafting rule
	-- (Item:ParseRaw / CanHaveMod: prefix or suffix limits, a crucible tree,
	-- "Cannot roll" restrictions, extra influences) is refused, or nil.
	function itemData.ruleReason(line)
		local low = line:lower()
		if low:match(" prefix modifiers? allowed") or low:match(" suffix modifiers? allowed") then
			return "changes the prefix or suffix limits"
		end
		if low:find("crucible passive skill tree", 1, true) then return "gives the item a crucible passive tree" end
		if low:match("^cannot roll ") then return "restricts the mods the item can roll" end
		if low == "has elder, shaper and all conqueror influences" or low:find("if the eater of worlds is dominant", 1, true) then
			return "adds influences (use influences)"
		end
		return nil
	end

	-- Why PoB would treat a rare named `title` as something else, or nil: a
	-- rare-like unique (its own affix pool and limits), a crucible unique
	-- (extra mod tags) or a Foulborn name (PoB renames it).
	function itemData.nameReason(title)
		local low = title:lower()
		if data.rareLikeUniques and data.rareLikeUniques[low] then
			return "is a unique Path of Building crafts with its own affix pool; pick another name"
		end
		for _, list in ipairs({ data.casterTagCrucibleUniques or { }, data.minionTagCrucibleUniques or { } }) do
			for name in pairs(list) do
				if tostring(name):lower() == low then return "is a unique whose name changes the mods Path of Building lets it roll; pick another name" end
			end
		end
		if low:match("^foulborn ") then return "starts with \"Foulborn \", which Path of Building reads as a Foulborn unique; pick another name" end
		return nil
	end

	-- What build_item asked for, checked on PoB's parse of the item: nothing
	-- may come out different (a line read as a header or flag, an implicit
	-- read as an explicit or the other way round).
	function itemData.verifyParsed(item, expect)
		local function refuse(what)
			userError("Path of Building reads the item differently from the request (" .. what ..
				"): a name or implicit line is probably read as an item header or flag; use plain modifier lines")
		end
		if item.baseName ~= expect.baseName then refuse("base " .. tostring(item.baseName)) end
		if item.rarity ~= expect.rarity then refuse("rarity " .. tostring(item.rarity)) end
		if expect.title and item.title ~= expect.title then refuse("name " .. tostring(item.title)) end
		if (item.corrupted == true) ~= expect.corrupted then refuse(item.corrupted and "corrupted" or "not corrupted") end
		for _, info in ipairs(itemLib.influenceInfo.all) do
			if (item[info.key] == true) ~= (expect.influences[info.key] == true) then
				refuse(info.display .. " influence " .. (item[info.key] and "added" or "lost"))
			end
		end
		if tonumber(item.itemLevel) ~= expect.itemLevel then refuse("item level " .. tostring(item.itemLevel)) end
		if item.quality ~= expect.quality then refuse("quality " .. tostring(item.quality)) end
		for _, part in ipairs({ { "implicits", "implicitModLines", "implicit" }, { "explicits", "explicitModLines", "mod" } }) do
			local wanted, lines = expect[part[1]], item[part[2]] or { }
			if wanted then
				if #lines ~= #wanted then refuse(#lines .. " " .. part[3] .. " lines instead of " .. #wanted) end
				for i, line in ipairs(wanted) do
					if lines[i].line ~= line then refuse(part[3] .. " line " .. i .. " is \"" .. itemData.clip(lines[i].line) .. "\"") end
				end
			end
		end
	end

	-- Text from BuildRaw, checked to parse back as swap_item parses item text
	-- (and, for build_item, to be the item that was asked for).
	function itemData.textResult(item, expect)
		local text = item:BuildRaw()
		local ok, check = pcall(construct, "Item", text)
		if not ok or not (check and check.base) then
			local message = "Path of Building could not parse the item text it built: " .. stripColorCodes(tostring(check))
			-- The name and implicits already parsed once (craftItem): a failure here is the engine's.
			error(message, 0)
		end
		if expect then itemData.verifyParsed(check, expect) end
		local variants, variantsMore = itemData.variantNames(check)
		local warnings = { }
		for _, key in ipairs({ "implicitModLines", "explicitModLines" }) do
			for _, ml in ipairs(check[key] or { }) do
				if ml.extra and check:CheckModLineVariant(ml) then
					warnings[#warnings + 1] = "Path of Building does not model this line: " .. itemData.clip(ml.line)
				end
			end
		end
		return {
			name = check.title or check.name,
			base = check.baseName,
			rarity = check.rarity,
			type = check.base.type,
			slot = itemData.primarySlot(check.base),
			levelReq = check.requirements and check.requirements.level or nil,
			variant = check.variantList and check.variantList[check.variant] or nil,
			variants = variants,
			variantsMore = variantsMore,
			implicits = itemData.rolledLines(check, check.implicitModLines),
			mods = itemData.rolledLines(check, check.explicitModLines, true),
			warnings = #warnings > 0 and warnings or nil,
			text = text,
		}
	end

	function itemData.selectVariant(item, variant)
		if variant == nil or variant == dkjson.null then return end
		if not item.variantList then userError(item.title .. " has no variants") end
		if item.usesVariantGroups then
			userError(item.title .. " picks its mods by variant groups; get_item_text uses PoB's default selection for it (omit variant)")
		end
		if type(variant) == "number" then
			if variant ~= math.floor(variant) or not item.variantList[variant] then
				userError("variant " .. tostring(variant) .. " is out of range: " .. item.title .. " has " .. #item.variantList .. " variants")
			end
			item.variant = variant
			return
		end
		local low = itemData.lower(variant)
		local hit = nil
		for i, name in ipairs(item.variantList) do
			if name:lower() == low then item.variant = i return end
			if name:lower():find(low, 1, true) then
				if hit then userError("variant \"" .. itemData.trim(variant) .. "\" matches several variants of " .. item.title .. ": " .. table.concat(item.variantList, "; ")) end
				hit = i
			end
		end
		if not hit then userError("Unknown variant \"" .. itemData.trim(variant) .. "\" for " .. item.title .. "; variants: " .. table.concat(item.variantList, "; ")) end
		item.variant = hit
	end

	function itemData.textCommand(cmd)
		local roll = itemData.roll(cmd.roll)
		local item
		if cmd.unique ~= nil and cmd.unique ~= dkjson.null then
			local entry = itemData.findUnique(cmd.unique)
			item = construct("Item", entry:BuildRaw())
			itemData.selectVariant(item, cmd.variant)
			for _, key in ipairs({ "implicitModLines", "explicitModLines" }) do itemData.setRoll(item[key], roll) end
		else
			local baseName, base = itemData.findBase(cmd.base)
			item = itemData.newItem(baseName, base, "NORMAL")
			itemData.setRoll(item.implicitModLines, roll)
		end
		item:BuildAndParseRaw()
		local result = itemData.textResult(item)
		result.roll = cmd.roll or "max"
		return result
	end

	-- Influence keys from display names ("Shaper", "Searing Exarch") or keys.
	function itemData.influenceKeys(list)
		local keys = { }
		for _, name in ipairs(list or { }) do
			local low = itemData.lower(name)
			local key = nil
			for _, info in ipairs(itemLib.influenceInfo.all) do
				if info.display:lower() == low or info.key == low then key = info.key end
			end
			if not key then userError("Unknown influence \"" .. itemData.trim(name) .. "\"") end
			keys[#keys + 1] = key
		end
		return keys
	end

	-- The item list_item_mods and build_item work on: a normal, magic or rare
	-- item of `base` with its influences, item level, corruption and
	-- implicits, parsed by PoB and checked to be exactly that. Returns the
	-- item and what it must stay (for build_item's final check).
	function itemData.craftItem(cmd)
		local baseName, base = itemData.findBase(cmd.base)
		local onlyMagic = base.flask or base.type == "Tincture" or (base.type == "Jewel" and base.subType == "Charm")
		local rarity = (cmd.rarity or (onlyMagic and "magic" or "rare")):upper()
		if rarity == "RARE" and onlyMagic then
			userError(baseName .. " cannot be rare in Path of Building (flasks, tinctures and charms are at most magic): use rarity \"magic\"")
		end
		local title = nil
		if cmd.name ~= nil and cmd.name ~= dkjson.null then
			title = itemData.trim(cmd.name)
			local reason = itemData.headerReason(title)
			if reason then userError("name \"" .. title .. "\" " .. reason .. " in Path of Building item text") end
			reason = itemData.nameReason(title)
			if reason then userError("name \"" .. title .. "\" " .. reason) end
		end
		local item = itemData.newItem(baseName, base, rarity, title)
		local influences = itemData.influenceKeys(cmd.influences)
		if #influences > 0 and not base.influenceTags then
			userError(baseName .. " (" .. base.type .. ") cannot have influences")
		end
		local wanted = { }
		for _, key in ipairs(influences) do
			item[key] = true
			wanted[key] = true
		end
		item.itemLevel = tonumber(cmd.itemLevel) or 86
		-- Before the parse: PoB's prefix/suffix limits depend on it (a corrupted abyss jewel).
		if cmd.corrupted == true then item.corrupted = true end
		local implicits = nil
		if cmd.implicits ~= nil and cmd.implicits ~= dkjson.null then
			implicits = { }
			item.implicitModLines = { }
			for _, raw in ipairs(cmd.implicits) do
				local line = itemData.trim(raw)
				local reason = itemData.headerReason(line)
				if reason then userError("implicit \"" .. line .. "\" " .. reason .. " in Path of Building item text, not a modifier") end
				reason = itemData.ruleReason(line)
				if reason then userError("implicit \"" .. line .. "\" " .. reason .. ", which build_item does not model") end
				implicits[#implicits + 1] = line
				item.implicitModLines[#item.implicitModLines + 1] = { line = line, modTags = { } }
			end
		end
		local expect = {
			baseName = baseName, rarity = rarity, title = rarity == "RARE" and (title or "New Item") or nil,
			corrupted = cmd.corrupted == true, influences = wanted, itemLevel = item.itemLevel, quality = item.quality,
			implicits = implicits, explicits = { },
		}
		local parsed, parseError = pcall(item.BuildAndParseRaw, item)
		if not parsed then
			local message = "Path of Building could not parse the item: " .. stripColorCodes(tostring(parseError))
			-- Only the name and implicit lines come from the caller here.
			if title or implicits then userError(message .. " (check the name and implicit lines)") end
			error(message, 0)
		end
		itemData.verifyParsed(item, expect)
		if rarity ~= "NORMAL" and not item.crafted then
			userError(baseName .. " (" .. base.type .. ") has no prefixes or suffixes Path of Building can craft")
		end
		return item, baseName, base, expect
	end

	function itemData.limits(item)
		local half = (item.affixLimit or 0) / 2
		return item.prefixes.limit or half, item.suffixes.limit or half
	end

	-- Tags every affix check gets, as the items tab's crafting dropdowns add
	-- them: the cluster jewel skill's tag.
	function itemData.baseTags(item)
		local tags = { }
		if item.clusterJewel and item.clusterJewelSkill then
			local skill = item.clusterJewel.skills and item.clusterJewel.skills[item.clusterJewelSkill]
			if skill and skill.tag then tags[skill.tag] = true end
		end
		return tags
	end

	-- PoB's check that `mod` can roll (Item:CanHaveMod with `tags`), on
	-- prefixes and suffixes only, delve mods left out as the dropdowns do.
	function itemData.canRoll(item, mod, tags)
		if not (mod.type == "Prefix" or mod.type == "Suffix") or not mod.weightKey or item:CheckIfModIsDelve(mod) then return false end
		local copy = { }
		for k, v in pairs(tags or { }) do copy[k] = v end
		return item:CanHaveMod(mod, copy) and true or false
	end

	-- Affix ids that can roll with `tags` (cached per tag set).
	function itemData.rollableWith(item, tags)
		local keys = { }
		for tag in pairs(tags) do keys[#keys + 1] = tag end
		table.sort(keys)
		local key = table.concat(keys, ",")
		item.rollableByTags = item.rollableByTags or { }
		if item.rollableByTags[key] then return item.rollableByTags[key] end
		local ok = { }
		for modId, mod in pairs(item.affixes or { }) do
			if itemData.canRoll(item, mod, tags) then ok[modId] = true end
		end
		item.rollableByTags[key] = ok
		return ok
	end

	-- Prefixes and suffixes that can roll on `item` with its base tags, with
	-- tiers: within one family (type, group, stats) the highest-level mod is
	-- tier 1. Item level is not applied here.
	function itemData.rollable(item)
		if item.rollableCache then return item.rollableCache.ok, item.rollableCache.tiers end
		local ok = itemData.rollableWith(item, itemData.baseTags(item))
		local families = { }
		for modId in pairs(ok) do
			local mod = item.affixes[modId]
			local key = mod.type .. "|" .. tostring(mod.group) .. "|" .. table.concat(mod.statOrder or { }, ",")
			families[key] = families[key] or { }
			table.insert(families[key], modId)
		end
		local tiers = { }
		for _, ids in pairs(families) do
			table.sort(ids, function(a, b)
				local la, lb = item.affixes[a].level or 0, item.affixes[b].level or 0
				if la ~= lb then return la > lb end
				return a < b
			end)
			for i, id in ipairs(ids) do tiers[id] = { tier = i, of = #ids } end
		end
		item.rollableCache = { ok = ok, tiers = tiers }
		return ok, tiers
	end

	function itemData.compareMods(item, a, b)
		local ma, mb = item.affixes[a], item.affixes[b]
		if ma.type ~= mb.type then return ma.type == "Prefix" end
		local sa, sb = ma.statOrder or { }, mb.statOrder or { }
		for i = 1, math.max(#sa, #sb) do
			if not sa[i] then return true end
			if not sb[i] then return false end
			if sa[i] ~= sb[i] then return sa[i] < sb[i] end
		end
		if tostring(ma.group) ~= tostring(mb.group) then return tostring(ma.group) < tostring(mb.group) end
		if (ma.level or 0) ~= (mb.level or 0) then return (ma.level or 0) > (mb.level or 0) end
		return a < b
	end

	-- Crafting bench prefixes and suffixes for the item class. PoB's bench
	-- data has no ids (and group + level is not unique), so a bench mod is
	-- named by its text with ranges, which stays valid as long as the mod.
	function itemData.benchMods(item)
		local list = { }
		for _, craft in ipairs(data.masterMods or { }) do
			if craft.types and craft.types[item.type] and (craft.type == "Prefix" or craft.type == "Suffix") then
				list[#list + 1] = { id = table.concat(craft, " / "), mod = craft }
			end
		end
		return list
	end

	function itemData.modsCommand(cmd)
		local item, baseName = itemData.craftItem(cmd)
		local ilvl = item.itemLevel
		local ok, tiers = itemData.rollable(item)
		local want = cmd.affix ~= nil and cmd.affix ~= dkjson.null and cmd.affix ~= "any" and cmd.affix or nil
		local needle = cmd.query ~= nil and cmd.query ~= dkjson.null and itemData.lower(cmd.query) or ""
		local function wanted(id, mod)
			if want and mod.type:lower() ~= want then return false end
			if needle == "" then return true end
			return table.concat(mod, " / "):lower():find(needle, 1, true) ~= nil
				or id:lower():find(needle, 1, true) ~= nil or tostring(mod.affix or ""):lower():find(needle, 1, true) ~= nil
		end
		local ids = { }
		for id in pairs(ok) do
			local mod = item.affixes[id]
			if (mod.level or 0) <= ilvl and wanted(id, mod) then ids[#ids + 1] = id end
		end
		table.sort(ids, function(a, b) return itemData.compareMods(item, a, b) end)
		local limit = tonumber(cmd.limit) or 50
		local mods = { }
		for i = 1, math.min(limit, #ids) do
			local id = ids[i]
			local mod = item.affixes[id]
			mods[i] = {
				id = id, type = mod.type:lower(), tier = tiers[id].tier, tiers = tiers[id].of,
				level = mod.level, group = mod.group, affix = mod.affix ~= "" and mod.affix or nil,
				weight = item:GetModSpawnWeight(mod), text = itemData.clip(table.concat(mod, " / ")),
			}
		end
		local prefixLimit, suffixLimit = itemData.limits(item)
		local result = {
			base = baseName, type = item.base.type, itemLevel = ilvl,
			prefixLimit = prefixLimit, suffixLimit = suffixLimit,
			total = #ids, more = math.max(0, #ids - #mods), mods = mods,
		}
		if cmd.includeCrafted then
			local crafted = { }
			local craftedTotal = 0
			for _, entry in ipairs(itemData.benchMods(item)) do
				if wanted(entry.id, entry.mod) then
					craftedTotal = craftedTotal + 1
					if #crafted < limit then
						crafted[#crafted + 1] = {
							type = entry.mod.type:lower(), level = entry.mod.level, group = entry.mod.group,
							text = itemData.clip(entry.id),
						}
					end
				end
			end
			result.crafted, result.craftedMore = crafted, math.max(0, craftedTotal - #crafted)
		end
		return result
	end

	function itemData.norm(text)
		return (itemData.lower(text):gsub("%s*\n%s*", " / "):gsub("%s*/%s*", " / "):gsub("%s+", " "))
	end

	-- Ranges and numbers become "#"; a "+" before them is dropped (optional),
	-- a "-" is kept, so "-10%" never matches a "+(..)%" mod.
	function itemData.template(normText)
		return (normText:gsub("%((%-?%d+%.?%d*)%-(%-?%d+%.?%d*)%)", "#"):gsub("%d+%.?%d*", "#"):gsub("%+#", "#"))
	end

	-- A mod's numbers in order: ranges { min, max } and fixed values.
	function itemData.tokens(text)
		local tokens, pos = { }, 1
		while true do
			local rs, re, a, b = text:find("%((%-?%d+%.?%d*)%-(%-?%d+%.?%d*)%)", pos)
			local ns, ne = text:find("%d+%.?%d*", pos)
			if not ns then break end
			if rs and rs <= ns then
				tokens[#tokens + 1] = { min = tonumber(a), max = tonumber(b) }
				pos = re + 1
			else
				tokens[#tokens + 1] = { value = tonumber(text:sub(ns, ne)) }
				pos = ne + 1
			end
		end
		return tokens
	end

	function itemData.modTemplate(mod)
		local cached = itemData.templates[mod]
		if cached then return cached end
		local norm = itemData.norm(table.concat(mod, " / "))
		cached = { norm = norm, template = itemData.template(norm) }
		itemData.templates[mod] = cached
		return cached
	end

	-- nil: the text is not this mod; false: same mod text, numbers outside its
	-- ranges; else { ranges } giving those numbers (exact: the mod's own text,
	-- ranges included, which takes the requested roll).
	function itemData.matchMod(spec, mod)
		local t = itemData.modTemplate(mod)
		if t.norm == spec.norm then return { exact = true } end
		if t.template ~= spec.template then return nil end
		local tokens = itemData.tokens(t.norm)
		if #tokens ~= #spec.values then return nil end
		local ranges = { }
		for i, tok in ipairs(tokens) do
			local v = spec.values[i]
			if tok.value then
				if math.abs(tok.value - v) > 1e-9 then return false end
			else
				local lo, hi = math.min(tok.min, tok.max), math.max(tok.min, tok.max)
				if v < lo - 1e-9 or v > hi + 1e-9 then return false end
				ranges[#ranges + 1] = tok.max == tok.min and 1 or (v - tok.min) / (tok.max - tok.min)
			end
		end
		return { ranges = ranges }
	end

	-- The roll for a matched mod: the requested roll for its own text (every
	-- range at that roll), else the rolls that give the numbers asked for.
	-- A one-line mod keeps one roll per range (itemLib.applyRange takes a
	-- list); several lines that need different rolls, or a bench craft
	-- (PoB keeps one roll per crafted line), get the average, with a warning.
	function itemData.rangeFor(match, mod, roll, label, warnings, scalarOnly)
		if match.exact or #match.ranges == 0 then return roll end
		local function up(r)
			-- BuildRaw keeps 3 decimals of an affix roll: round up so the value is reached.
			local v = math.ceil(r * 1000 - 1e-6) / 1000
			if v <= 0 then return 0 end
			return math.min(1, v)
		end
		local sum, same = 0, true
		for _, r in ipairs(match.ranges) do
			sum = sum + r
			if math.abs(r - match.ranges[1]) > 1e-9 then same = false end
		end
		if same then return up(match.ranges[1]) end
		if #mod == 1 and not scalarOnly then
			local list = { }
			for i, r in ipairs(match.ranges) do list[i] = up(r) end
			return list
		end
		warnings[#warnings + 1] = label .. ": its values need different rolls; one average roll is used"
		return up(sum / #match.ranges)
	end

	function itemData.parseSpec(text)
		local norm = itemData.norm(text)
		local values = { }
		for n in norm:gmatch("%d+%.?%d*") do values[#values + 1] = tonumber(n) end
		return { text = itemData.trim(text), norm = norm, template = itemData.template(norm), values = values }
	end

	function itemData.describeCandidates(item, ids)
		local out = { }
		for i = 1, math.min(5, #ids) do
			local mod = item.affixes[ids[i]]
			out[i] = ids[i] .. " (level " .. tostring(mod.level) .. "): " .. itemData.clip(table.concat(mod, " / "))
		end
		return table.concat(out, "; ")
	end

	-- A prefix or suffix by mod id or text, checked against the base, its
	-- influences, the item level and `ok` (what can roll with the other
	-- mods' tags). Returns the choice, or nil and why not.
	function itemData.resolveAffix(item, baseName, specText, roll, warnings, ok)
		local ilvl = item.itemLevel
		local where = baseName .. " at item level " .. ilvl
		local id = nil
		local trimmed = itemData.trim(specText)
		if item.affixes[trimmed] then
			id = trimmed
		elseif not trimmed:find("%s") then
			for modId in pairs(item.affixes) do
				if modId:lower() == trimmed:lower() then id = modId break end
			end
		end
		if id then
			local mod = item.affixes[id]
			if not (mod.type == "Prefix" or mod.type == "Suffix") then
				return nil, id .. " is a " .. tostring(mod.type) .. " modifier, not a prefix or suffix"
			end
			if not ok[id] then
				return nil, id .. " (" .. itemData.clip(table.concat(mod, " / ")) .. ") cannot roll on " .. baseName .. " (Path of Building's spawn weights; influences change them)"
			end
			if (mod.level or 0) > ilvl then return nil, id .. " needs item level " .. mod.level .. " (itemLevel is " .. ilvl .. ")" end
			return { id = id, mod = mod, range = roll }
		end
		local spec = itemData.parseSpec(specText)
		local best, bestMatch, outOfRange, tooHigh, notRollable = nil, nil, { }, { }, { }
		for modId, mod in pairs(item.affixes) do
			if mod.type == "Prefix" or mod.type == "Suffix" then
				local m = itemData.matchMod(spec, mod)
				if m ~= nil then
					if not ok[modId] then
						notRollable[#notRollable + 1] = modId
					elseif m == false then
						outOfRange[#outOfRange + 1] = modId
					elseif (mod.level or 0) > ilvl then
						tooHigh[#tooHigh + 1] = modId
					elseif not best or (mod.level or 0) > (item.affixes[best].level or 0) or ((mod.level or 0) == (item.affixes[best].level or 0) and modId < best) then
						best, bestMatch = modId, m
					end
				end
			end
		end
		if best then
			local mod = item.affixes[best]
			return { id = best, mod = mod, range = itemData.rangeFor(bestMatch, mod, roll, best, warnings) }
		end
		local function sorted(list)
			table.sort(list, function(a, b) return (item.affixes[a].level or 0) > (item.affixes[b].level or 0) end)
			return list
		end
		if #tooHigh > 0 then
			return nil, "\"" .. spec.text .. "\" needs a higher item level than " .. ilvl .. ": " .. itemData.describeCandidates(item, sorted(tooHigh))
		end
		if #outOfRange > 0 then
			return nil, "\"" .. spec.text .. "\" is outside every tier that can roll on " .. where .. ": " .. itemData.describeCandidates(item, sorted(outOfRange))
		end
		if #notRollable > 0 then
			return nil, "\"" .. spec.text .. "\" cannot roll on " .. baseName .. " (Path of Building's spawn weights; influences change them): " .. itemData.describeCandidates(item, sorted(notRollable))
		end
		return nil, "No prefix or suffix matches \"" .. spec.text .. "\" (give a mod id or its text, e.g. \"+(100-114) to maximum Life\" or \"+110 to maximum Life\"; use list_item_mods)"
	end

	function itemData.resolveCraft(item, baseName, specText, roll, warnings)
		local bench = itemData.benchMods(item)
		local spec = itemData.parseSpec(specText)
		local best, bestMatch, outOfRange = nil, nil, { }
		for _, entry in ipairs(bench) do
			local m = itemData.matchMod(spec, entry.mod)
			if m == false then
				outOfRange[#outOfRange + 1] = itemData.clip(entry.id)
			elseif m and (not best or (entry.mod.level or 0) > (best.mod.level or 0)) then
				best, bestMatch = entry, m
			end
		end
		if best then
			return { id = best.id, mod = best.mod, range = itemData.rangeFor(bestMatch, best.mod, roll, best.id, warnings, true), crafted = true }
		end
		if #outOfRange > 0 then
			while #outOfRange > 5 do table.remove(outOfRange) end
			userError("\"" .. spec.text .. "\" is outside every crafting bench tier for " .. baseName .. ": " .. table.concat(outOfRange, "; "))
		end
		userError("No crafting bench prefix or suffix for " .. baseName .. " matches \"" .. spec.text .. "\" (use list_item_mods with includeCrafted)")
	end

	-- Every `mods` entry resolved; each is checked with the tags the other
	-- chosen mods add (PoB's UpdateAffixControl passes them to CanHaveMod),
	-- so a mod that needs another one's tag is found once that one is.
	function itemData.resolveAffixes(item, baseName, specs, roll, warnings)
		local resolved = { }
		local function tagsExcept(i)
			local tags = itemData.baseTags(item)
			for j, r in pairs(resolved) do
				if j ~= i then
					for _, tag in ipairs(r.mod.tags or { }) do tags[tag] = true end
				end
			end
			return tags
		end
		local progress = true
		while progress do
			progress = false
			for i, spec in ipairs(specs) do
				if not resolved[i] then
					local r = itemData.resolveAffix(item, baseName, spec, roll, warnings, itemData.rollableWith(item, tagsExcept(i)))
					if r then
						resolved[i] = r
						progress = true
					end
				end
			end
		end
		local list = { }
		for i, spec in ipairs(specs) do
			if not resolved[i] then
				local _, message = itemData.resolveAffix(item, baseName, spec, roll, { }, itemData.rollableWith(item, tagsExcept(i)))
				userError(message)
			end
		end
		for i = 1, #specs do
			-- Tags only ever add weight keys, but a key can carry weight 0: check each with all the others.
			if not itemData.canRoll(item, resolved[i].mod, tagsExcept(i)) then
				userError(resolved[i].id .. " cannot roll on " .. baseName .. " together with the other mods")
			end
			list[i] = resolved[i]
		end
		return list
	end

	function itemData.buildCommand(cmd)
		local roll = itemData.roll(cmd.roll)
		local item, baseName, base, expect = itemData.craftItem(cmd)
		local warnings = { }
		local affixes = itemData.resolveAffixes(item, baseName, cmd.mods or { }, roll, warnings)
		local crafts = { }
		for _, spec in ipairs(cmd.crafted or { }) do crafts[#crafts + 1] = itemData.resolveCraft(item, baseName, spec, roll, warnings) end
		local total = #affixes + #crafts
		if item.rarity == "NORMAL" and total > 0 then
			userError("A normal item has no prefixes or suffixes: use rarity \"magic\" or \"rare\"")
		end
		-- As PoB's crafting dropdowns: one mod of each group.
		local groups = { }
		for _, list in ipairs({ affixes, crafts }) do
			for _, r in ipairs(list) do
				if r.mod.group then
					if groups[r.mod.group] then
						userError(r.id .. " and " .. groups[r.mod.group] .. " are both in mod group " .. r.mod.group .. ": an item can have one mod of each group")
					end
					groups[r.mod.group] = r.id
				end
			end
		end
		local prefixLimit, suffixLimit = itemData.limits(item)
		local counts = { Prefix = 0, Suffix = 0 }
		for _, list in ipairs({ affixes, crafts }) do
			for _, r in ipairs(list) do counts[r.mod.type] = counts[r.mod.type] + 1 end
		end
		local rarityName = item.rarity:lower()
		local what = rarityName .. (item.corrupted and " corrupted " or " ") .. base.type
		if counts.Prefix > prefixLimit then
			userError(counts.Prefix .. " prefixes (crafted ones included) but a " .. what .. " can have " .. prefixLimit)
		end
		if counts.Suffix > suffixLimit then
			userError(counts.Suffix .. " suffixes (crafted ones included) but a " .. what .. " can have " .. suffixLimit)
		end
		if #crafts > 1 then
			warnings[#warnings + 1] = "more than one crafted modifier needs the bench's \"Can have up to 3 Crafted Modifiers\" craft"
		end
		if cmd.name ~= nil and cmd.name ~= dkjson.null and item.rarity ~= "RARE" then
			warnings[#warnings + 1] = "name is used for rare items only; a " .. rarityName .. " item is named from its affixes"
		end
		if cmd.quality ~= nil and cmd.quality ~= dkjson.null then
			if item.quality == nil then userError(base.type .. " items have no quality") end
			item.quality = tonumber(cmd.quality)
			expect.quality = item.quality
		end
		local p, s = 0, 0
		for _, r in ipairs(affixes) do
			if r.mod.type == "Prefix" then
				p = p + 1
				item.prefixes[p] = { modId = r.id, range = r.range }
			else
				s = s + 1
				item.suffixes[s] = { modId = r.id, range = r.range }
			end
		end
		for i = p + 1, prefixLimit do item.prefixes[i] = { modId = "None" } end
		for i = s + 1, suffixLimit do item.suffixes[i] = { modId = "None" } end
		for _, r in ipairs(crafts) do
			for _, line in ipairs(r.mod) do
				item.explicitModLines[#item.explicitModLines + 1] = { line = line, modTags = r.mod.modTags or { }, crafted = true, range = r.range }
			end
		end
		if item.crafted then
			item:Craft()
		else
			item:BuildAndParseRaw()
		end
		expect.explicits = { }
		for i, ml in ipairs(item.explicitModLines) do expect.explicits[i] = ml.line end
		local result = itemData.textResult(item, expect)
		local _, tiers = itemData.rollable(item)
		local chosen = { }
		for _, list in ipairs({ affixes, crafts }) do
			for _, r in ipairs(list) do
				chosen[#chosen + 1] = {
					id = r.id, type = r.mod.type:lower(), crafted = r.crafted,
					tier = tiers[r.id] and tiers[r.id].tier or nil, tiers = tiers[r.id] and tiers[r.id].of or nil,
					text = itemData.clip(itemLib.applyRange(table.concat(r.mod, "\n"), r.range)),
				}
			end
		end
		result.affixes = chosen
		result.itemLevel = item.itemLevel
		result.roll = cmd.roll or "max"
		for _, w in ipairs(warnings) do
			result.warnings = result.warnings or { }
			result.warnings[#result.warnings + 1] = w
		end
		return result
	end

	for name, handler in pairs({
		itemSearch = itemData.searchCommand,
		itemText = itemData.textCommand,
		itemMods = itemData.modsCommand,
		itemBuild = itemData.buildCommand,
	}) do
		DISPATCH[name] = { handler = handler }
		NO_BUILD_REQUIRED[name] = true
	end
end

-- The build's fundamentals: a blank build to start from (new_build), the
-- character level (set_character_level) and the class / ascendancy /
-- secondary ascendancy (set_ascendancy). Names are matched without regard to
-- case, spaces, `_` or `-`; a refusal lists the choices. (A `do` block: the
-- main chunk is at Lua's limit of 200 locals.)
do
	local basics = { }

	function basics.given(v)
		return v ~= nil and v ~= dkjson.null
	end

	function basics.key(s)
		return (tostring(s or ""):lower():gsub("[%s_%-]+", " "):gsub("^ ", ""):gsub(" $", ""))
	end

	function basics.isNone(s)
		local k = basics.key(s)
		return k == "" or k == "none"
	end

	-- PoB's tree data for `version`. main:LoadTree sets PoB's global jewel
	-- radii for the version it loads, so they are put back for the active
	-- tree (TreeTab:SetActiveSpec sets them the same way).
	function basics.tree(version)
		local tree = mainObject.main:LoadTree(version)
		local spec = build and build.spec
		data.setJewelRadiiGlobally(spec and type(spec.treeVersion) == "string" and spec.treeVersion or latestTreeVersion)
		if not tree then error("Path of Building could not load passive tree " .. tostring(version), 0) end
		return tree
	end

	-- A tree version as PoB names it ("3_30", "3_30_ruthless"); "3.30" and
	-- "latest" are accepted. Default: PoB's latest tree.
	function basics.version(v)
		if not basics.given(v) or basics.key(v) == "latest" or basics.key(v) == "" then return latestTreeVersion end
		local s = tostring(v):lower():gsub("^%s+", ""):gsub("%s+$", ""):gsub("[%.%s%-]+", "_")
		if treeVersions[s] and listContains(treeVersionList, s) then return s end
		userError("Unknown passive tree version '" .. tostring(v) .. "'. Path of Building has: "
			.. table.concat(treeVersionList, ", ") .. " (default: the latest, " .. latestTreeVersion .. ")")
	end

	function basics.sortedById(map, skipZero)
		local list = { }
		for id, entry in pairs(map or { }) do
			if not (skipZero and id == 0) and type(entry) == "table" then list[#list + 1] = { id = id, entry = entry } end
		end
		table.sort(list, function(a, b) return a.id < b.id end)
		return list
	end

	-- "Scion (Ascendant), Marauder (Juggernaut, Berserker, Chieftain), ..."
	function basics.classChoices(tree)
		local out = { }
		for _, c in ipairs(basics.sortedById(tree.classes)) do
			local asc = { }
			for _, a in ipairs(basics.sortedById(c.entry.classes, true)) do asc[#asc + 1] = a.entry.name end
			out[#out + 1] = c.entry.name .. " (" .. table.concat(asc, ", ") .. ")"
		end
		return table.concat(out, ", ")
	end

	function basics.findClass(tree, name, version)
		local want = basics.key(name)
		for _, c in ipairs(basics.sortedById(tree.classes)) do
			if basics.key(c.entry.name) == want then return c.id end
		end
		userError("Unknown class '" .. tostring(name) .. "'. Classes (ascendancies) on tree " .. version .. ": " .. basics.classChoices(tree))
	end

	-- The class id and ascendancy id of an ascendancy name (or PoB id), or nil.
	function basics.findAscendancy(tree, name)
		local want = basics.key(name)
		for _, c in ipairs(basics.sortedById(tree.classes)) do
			for _, a in ipairs(basics.sortedById(c.entry.classes, true)) do
				if basics.key(a.entry.name) == want or (a.entry.id and basics.key(a.entry.id) == want) then return c.id, a.id end
			end
		end
		return nil
	end

	function basics.unknownAscendancy(tree, name, version)
		userError("Unknown ascendancy '" .. tostring(name) .. "'. Classes (ascendancies) on tree " .. version .. ": " .. basics.classChoices(tree))
	end

	-- Secondary ascendancies (bloodlines) the tree offers, by name. PoB's tree
	-- loader already drops the legacy ones its dropdown no longer offers.
	function basics.secondaryChoices(tree)
		local names = { }
		for _, a in ipairs(basics.sortedById(tree.alternate_ascendancies)) do names[#names + 1] = a.entry.name end
		table.sort(names)
		return names
	end

	function basics.findSecondary(tree, name, version)
		if basics.isNone(name) then return 0 end
		local names = basics.secondaryChoices(tree)
		if #names == 0 then
			userError("Passive tree " .. version .. " has no secondary ascendancies (bloodlines); leave secondaryAscendancy out")
		end
		local want = basics.key(name)
		for _, a in ipairs(basics.sortedById(tree.alternate_ascendancies)) do
			local n = basics.key(a.entry.name)
			if n == want or basics.key(a.entry.id) == want or (n:gsub(" bloodline$", "")) == want then return a.id end
		end
		userError("Unknown secondary ascendancy '" .. tostring(name) .. "'. Tree " .. version .. " offers: "
			.. table.concat(names, ", ") .. " (or None)")
	end

	function basics.level(v)
		local level = tonumber(v)
		if not level or level ~= math.floor(level) or level < 1 or level > 100 then
			userError("level must be a whole number from 1 to 100")
		end
		return level
	end

	function basics.xmlAttr(s)
		return (tostring(s):gsub("&", "&amp;"):gsub('"', "&quot;"):gsub("<", "&lt;"):gsub(">", "&gt;"))
	end

	-- new_build: the XML of a blank build (what PoB's "New" gives, with the
	-- class, ascendancies, level and tree chosen; the level in manual mode),
	-- checked against the tree first, so a refusal changes nothing.
	function basics.blankBuild(cmd)
		local version = basics.version(cmd.treeVersion)
		local tree = basics.tree(version)
		local classId, ascendClassId = nil, 0
		if basics.given(cmd.className) then classId = basics.findClass(tree, cmd.className, version) end
		if basics.given(cmd.ascendancy) and not basics.isNone(cmd.ascendancy) then
			local cid, aid = basics.findAscendancy(tree, cmd.ascendancy)
			if not cid then basics.unknownAscendancy(tree, cmd.ascendancy, version) end
			if classId and cid ~= classId then
				userError(tostring(cmd.ascendancy) .. " is a " .. tree.classes[cid].name .. " ascendancy, not a "
					.. tree.classes[classId].name .. " one. Classes (ascendancies) on tree " .. version .. ": " .. basics.classChoices(tree))
			end
			classId, ascendClassId = cid, aid
		end
		if not classId then
			userError("Pass className (or an ascendancy). Classes (ascendancies) on tree " .. version .. ": " .. basics.classChoices(tree))
		end
		local secondaryId = basics.given(cmd.secondaryAscendancy) and basics.findSecondary(tree, cmd.secondaryAscendancy, version) or 0
		local level = basics.given(cmd.level) and basics.level(cmd.level) or 1
		local class = tree.classes[classId]
		local ascendancy = class.classes[ascendClassId] or class.classes[0]
		local secondary = secondaryId ~= 0 and tree.alternate_ascendancies[secondaryId] or nil
		local attr = basics.xmlAttr
		local xml = table.concat({
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<PathOfBuilding>",
			string.format('\t<Build level="%d" targetVersion="%s" className="%s" ascendClassName="%s" mainSocketGroup="1" viewMode="TREE" characterLevelAutoMode="false"/>',
				level, attr(liveTargetVersion), attr(class.name), attr(ascendancy.name)),
			'\t<Tree activeSpec="1">',
			string.format('\t\t<Spec treeVersion="%s" clusterHashFormatVersion="2" classId="%d" ascendClassId="%d" secondaryAscendClassId="%d" nodes="" masteryEffects=""/>',
				attr(version), classId, ascendClassId, secondaryId),
			"\t</Tree>",
			"</PathOfBuilding>",
			"",
		}, "\n")
		return {
			xml = xml,
			build = {
				class = class.name,
				ascendancy = ascendancy.name,
				secondaryAscendancy = secondary and secondary.name or nil,
				level = level,
				treeVersion = version,
			},
		}
	end

	function basics.levelState()
		return { level = build.characterLevel, autoMode = build.characterLevelAutoMode == true }
	end

	-- set_character_level (and its undo, which may put PoB's auto level mode
	-- back): what PoB's level box does. The level is in manual mode afterwards
	-- unless `autoMode` is true.
	function basics.setLevel(cmd)
		local level = basics.level(cmd.level)
		build.characterLevel = level
		build.characterLevelAutoMode = cmd.autoMode == true
		local controls = build.controls or { }
		if controls.characterLevel and controls.characterLevel.SetText then controls.characterLevel:SetText(level) end
		if controls.levelScalingButton then controls.levelScalingButton.label = build.characterLevelAutoMode and "Auto" or "Manual" end
		build.configTab:BuildModList()
		build.buildFlag = true
		runCallback("OnFrame")
		return basics.levelState()
	end

	function basics.describeClass(spec)
		return {
			className = spec.curClassName,
			ascendancy = spec.curAscendClassName or "None",
			secondaryAscendancy = spec.curSecondaryAscendClassName or "None",
			classId = spec.curClassId,
			ascendClassId = spec.curAscendClassId or 0,
			secondaryAscendClassId = spec.curSecondaryAscendClassId or 0,
		}
	end

	-- The class, ascendancy and secondary ascendancy set_ascendancy asks for,
	-- as ids (`replay`: the ids a committed change recorded).
	function basics.targetClass(cmd, spec, from)
		local tree, version = spec.tree, spec.treeVersion
		if cmd.replay then
			local classId, ascendClassId, secondaryId = tonumber(cmd.classId), tonumber(cmd.ascendClassId), tonumber(cmd.secondaryAscendClassId)
			local class = classId and tree.classes[classId]
			if not (class and ascendClassId and class.classes[ascendClassId] and secondaryId
				and (secondaryId == 0 or (tree.alternate_ascendancies and tree.alternate_ascendancies[secondaryId]))) then
				error("setAscendancy replay: unknown class / ascendancy ids", 0)
			end
			return classId, ascendClassId, secondaryId
		end
		if not (basics.given(cmd.className) or basics.given(cmd.ascendancy) or basics.given(cmd.secondaryAscendancy)) then
			userError("Pass ascendancy, secondaryAscendancy or className")
		end
		local classId = from.classId
		if basics.given(cmd.className) then classId = basics.findClass(tree, cmd.className, version) end
		local ascendClassId = classId == from.classId and from.ascendClassId or 0
		if basics.given(cmd.ascendancy) then
			if basics.isNone(cmd.ascendancy) then
				ascendClassId = 0
			else
				local cid, aid = basics.findAscendancy(tree, cmd.ascendancy)
				if not cid then basics.unknownAscendancy(tree, cmd.ascendancy, version) end
				if cid ~= classId then
					local other = tree.classes[cid].name
					if basics.given(cmd.className) then
						userError(tostring(cmd.ascendancy) .. " is a " .. other .. " ascendancy, not a " .. tree.classes[classId].name .. " one")
					end
					userError(tostring(cmd.ascendancy) .. " is a " .. other .. " ascendancy and this build is a " .. tostring(from.className)
						.. ". Pass className: \"" .. other .. "\" as well to change class (Path of Building keeps the allocated passives only "
						.. "when they connect to the " .. other .. " start), or start over with new_build")
				end
				ascendClassId = aid
			end
		end
		local secondaryId = from.secondaryAscendClassId
		if basics.given(cmd.secondaryAscendancy) then secondaryId = basics.findSecondary(tree, cmd.secondaryAscendancy, version) end
		return classId, ascendClassId, secondaryId
	end

	-- set_ascendancy: PoB's class / ascendancy / secondary ascendancy
	-- dropdowns (PassiveSpec:SelectClass, SelectAscendClass,
	-- SelectSecondaryAscendClass). Passives that no longer connect to a start
	-- (the old ascendancy's, the old class's) are removed, as PoB does. A class
	-- change is refused, as PoB asks first, when passives are allocated and none
	-- connects to the new class's start, unless `allowTreeReset` (PoB's
	-- "Continue"). Returns { unchanged } or { from, to, removed }.
	function basics.setAscendancy(cmd)
		local spec = build.spec
		local from = basics.describeClass(spec)
		local classId, ascendClassId, secondaryId = basics.targetClass(cmd, spec, from)
		if classId == from.classId and ascendClassId == from.ascendClassId and secondaryId == from.secondaryAscendClassId then
			return { unchanged = true, from = from, to = from }
		end
		local classChange = classId ~= from.classId
		if classChange and not cmd.replay and cmd.allowTreeReset ~= true then
			local used = spec:CountAllocNodes()
			if (tonumber(used) or 0) > 0 and not spec:IsClassConnected(classId) then
				local name = spec.tree.classes[classId].name
				userError("Changing class from " .. tostring(from.className) .. " to " .. name .. " would reset the passive tree: no allocated "
					.. "passive connects to the " .. name .. " start (Path of Building asks before doing this). Pass allowTreeReset: true "
					.. "to change class anyway (every passive that no longer connects is removed, as with PoB's Continue), connect the tree "
					.. "to the " .. name .. " start with allocate_nodes first, or start over with new_build")
			end
		end
		local before = nodeBatch.captureAllocated()
		buildEdit.started()
		withTreeRollback(function()
			if classChange then spec:SelectClass(classId) end
			if (spec.curAscendClassId or 0) ~= ascendClassId then spec:SelectAscendClass(ascendClassId) end
			if (spec.curSecondaryAscendClassId or 0) ~= secondaryId then spec:SelectSecondaryAscendClass(secondaryId) end
			local now = basics.describeClass(spec)
			if now.classId ~= classId or now.ascendClassId ~= ascendClassId or now.secondaryAscendClassId ~= secondaryId then
				error("Path of Building did not switch the class / ascendancy (PassiveSpec changed?)", 0)
			end
		end)
		local removed = { }
		for _, node in ipairs(nodeBatch.lostSince(before)) do
			if node.type ~= "ClassStart" and node.type ~= "AscendClassStart" then removed[#removed + 1] = node end
		end
		local result = { from = from, to = basics.describeClass(spec), removed = removed }
		buildEdit.applied(result, cmd.replay)
		build.buildFlag = true
		runCallback("OnFrame")
		return result
	end

	-- A new_build request: an XML document whose only element under
	-- <PathOfBuilding> is <MCPNewBuild className=... ascendancy=...
	-- secondaryAscendancy=... level=... treeVersion=.../> (BuildSession.newBuild).
	-- Returns its attributes, or nil for any other XML.
	function basics.newBuildRequest(xmlText)
		if type(xmlText) ~= "string" or not xmlText:find("<MCPNewBuild", 1, true) then return nil end
		local parsed = common.xml.ParseXML(xmlText)
		local root = type(parsed) == "table" and parsed[1]
		if not (type(root) == "table" and root.elem == "PathOfBuilding") then return nil end
		local request = nil
		for _, child in ipairs(root) do
			if type(child) == "table" then
				if child.elem ~= "MCPNewBuild" or request then return nil end
				request = child.attrib or { }
			end
		end
		return request
	end

	-- new_build goes through loadXML like any build (BuildSession.newBuild
	-- sends the request as the build's XML), so it shares load_build's path in
	-- the bridge and in LuaBridge: a respawn for it skips the replay, a refusal
	-- (raised here before anything changes) puts the last committed build
	-- back, and the request is the recovery build and reset_build's target,
	-- which give the same blank build again. `info.newBuild` is what the build
	-- should load as (BuildSession checks it).
	local plainLoad = DISPATCH.loadXML.handler
	DISPATCH.loadXML.handler = function(cmd)
		local request = basics.newBuildRequest(cmd.xml)
		if not request then return plainLoad(cmd) end
		local blank = basics.blankBuild(request)
		local body = plainLoad({ xml = blank.xml, name = cmd.name })
		body.info.newBuild = blank.build
		return body
	end

	buildEdit.COMMANDS.setAscendancy = true
	DISPATCH.getCharacterLevel = { handler = function(_cmd) return basics.levelState() end }
	DISPATCH.setCharacterLevel = { handler = basics.setLevel }
	DISPATCH.setAscendancy = { handler = basics.setAscendancy }
end

local function dispatch(cmd)
	if type(cmd) ~= "table" then
		error("Command must be a JSON object")
	end
	if cmd.cmd ~= "treeEditApplied" then nodeBatch.record = nil end
	if cmd.cmd ~= "buildEditApplied" then buildEdit.record = nil end
	if buildEdit.COMMANDS[cmd.cmd] then buildEdit.failNextStats, buildEdit.rollbackInexact = nil, nil end
	if buildEdit.failNextStats and cmd.cmd == "getStats" then
		-- Test fault (buildEditRecalcFails): PoB's recalculation after an applied edit fails.
		buildEdit.failNextStats = nil
		if TEST_FAULTS.buildEditRecalcExits then os.exit(3) end
		error("test fault: the recalculation after a build edit failed", 0)
	end
	local entry = DISPATCH[cmd.cmd]
	if not entry then
		userError("Unknown command: " .. tostring(cmd.cmd))
	end
	testFaultsForCommand(cmd.cmd)
	local expectBuild = not NO_BUILD_REQUIRED[cmd.cmd]
	-- Any leftover state from an earlier command must not be attributed to
	-- this one.
	clearPoBErrorState()
	if expectBuild then
		local m = mainObject.main
		local mode = m and (m.newMode or m.mode)
		if mode ~= "BUILD" or not build then
			error("No build is active in Path of Building (mode=" .. tostring(mode) .. "); load a build first")
		end
	end
	local popupsBefore = currentPopups()
	local ok, body = pcall(function()
		local b = entry.handler(cmd)
		if TEST_CHANGE_COMMANDS[cmd.cmd] then testChangeDone = true end
		if entry.mutating then
			b.stats = getStats()
		end
		return b
	end)
	local failure = detectPoBFailure(popupsBefore, expectBuild)
	if failure then
		clearPoBErrorState()
		local detail = (not ok) and (" [" .. tostring(body) .. "]") or ""
		error(failure .. detail, 0)
	end
	if not ok then
		error(body, 0)
	end
	body.ok = true
	return body
end

-- Boot may leave informational popups (settings/cloud warnings) open; they
-- would swallow input and be misattributed to the first command.
do
	local m = mainObject.main
	if m and type(m.popups) == "table" then
		for _, p in ipairs(m.popups) do
			STDERR:write("[pob-mcp] dismissing PoB dialog at startup: ", describePopup(p), "\n")
		end
	end
	clearPoBErrorState()
end

-- Test faults: a startup that never becomes ready, or that fails.
if TEST_FAULTS.hangOnStart then testFaultStall() end
if TEST_FAULTS.failOnStart then error("test fault: startup failed", 0) end

respond({ ok = true, ready = true })

while true do
	local line = io.stdin:read("*l")
	if not line then break end
	local cmd, pos, decodeErr = dkjson.decode(line, 1, nil)
	if decodeErr then
		respond({ error = "Invalid JSON: " .. tostring(decodeErr) })
	else
		local ok, result = pcall(dispatch, cmd)
		if not ok then
			-- userError() throws at level 0, so its message starts with the marker
			-- and carries no source prefix. Any other error is wrapped by Lua with
			-- a source path/line prefix (e.g. ".../bridge.lua:411: "); strip it so
			-- the surface error message is user-friendly.
			local msg = tostring(result)
			local userFlag = false
			if msg:sub(1, #USER_ERROR_PREFIX) == USER_ERROR_PREFIX then
				msg = msg:sub(#USER_ERROR_PREFIX + 1)
				userFlag = true
			else
				msg = msg:gsub("^%.%.%.[^:]*%.lua:%d+:%s*", "")
				msg = msg:gsub("^[^:]*%.lua:%d+:%s*", "")
			end
			if userFlag then
				respond({ error = msg, userError = true })
			else
				respond({ error = msg })
			end
		else
			respond(result)
		end
	end
end
