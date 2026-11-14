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
	local func, err = loadfile(fileName)
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
	local func, err = loadfile(fileName)
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

dofile(SCRIPT_PATH .. "/Launch.lua")
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
	return {
		class = build.className or (build.spec and build.spec.curClassName),
		ascendancy = build.ascendClassName or (build.spec and build.spec.curAscendClassName),
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

-- Why ItemsTab:IsItemValidForSlot refused `item` for `slotName`.
local function slotRefusalReason(tab, item, slotName)
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

-- Parse item text exactly as ItemsTab:CreateDisplayItemFromRaw does (without
-- normalising), but never through the items tab's displayItem: a parse
-- failure can then never leave an earlier display item behind to be equipped.
local function parseItemText(itemRaw, slotName)
	local ok, item = pcall(new, "Item", itemRaw)
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
			slotRefusalReason(tab, item, slotName)))
	end
	local parent = slot.parentSlot
	if parent then
		local index = 0
		for i, s in ipairs(parent.abyssalSocketList or { }) do
			if s == slot then index = i end
		end
		local parentItem = tab.items[parent.selItemId or 0]
		local count = parentItem and parentItem.abyssalSocketCount or 0
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
	local slot = tab.slots[slotName]
	if not slot then
		userError("Unknown slot: " .. tostring(slotName))
	end
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
	return { slots = slots, itemOrder = order, itemTokens = tokens }
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
	local report = { exact = #mismatches == 0 }
	if #mismatches > 0 then
		report.mismatches = mismatches
		STDERR:write("[pob-mcp] warning: item restore is not exact: ", encodeJSON(report), "\n")
	end
	if #removed > 0 then report.removedItemIds = removed end
	return report
end

local function unequipSlot(slotName)
	local slot = build.itemsTab.slots[slotName]
	if not slot then
		userError("Unknown slot: " .. tostring(slotName))
	end
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
	local newSpec = new("PassiveSpec", build, version)
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
		if jewelsChanged then
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

local function getFullConfigInput()
	local result = { }
	if build.configTab and build.configTab.input then
		for key, value in pairs(build.configTab.input) do
			result[key] = copyValue(value)
		end
	end
	return result
end

local function restoreConfigInput(input)
	if not (build.configTab and build.configTab.input) then
		error("Config tab not available")
	end
	-- Wipe current input and replace with snapshot
	for key, _ in pairs(build.configTab.input) do
		build.configTab.input[key] = nil
	end
	for key, value in pairs(input or { }) do
		build.configTab.input[key] = value
	end
	build.configTab:BuildModList()
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

local function allocNodesBatch(nodeIds)
	local nodes = batchNodes(nodeIds)
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
	withTreeRollback(function()
		for _, node in ipairs(nodes) do
			build.spec:AllocNode(node)
		end
		for _, node in ipairs(nodes) do
			if not node.alloc then
				userError("Node " .. nodeLabel(node) .. " could not be allocated")
			end
		end
	end)
	build.buildFlag = true
	runCallback("OnFrame")
end

local function deallocNodesBatch(nodeIds)
	local nodes = batchNodes(nodeIds)
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
	withTreeRollback(function()
		for _, node in ipairs(nodes) do
			build.spec:DeallocNode(node)
		end
	end)
	build.buildFlag = true
	runCallback("OnFrame")
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
	for _, slot in ipairs(build.itemsTab.orderedSlots) do
		if slot.slotName and not slot.slotName:find("Abyssal Socket") then
			local itemId = slot.selItemId or 0
			local item = (itemId ~= 0) and build.itemsTab.items[itemId] or nil
			table.insert(result, {
				slot = slot.slotName,
				occupied = itemId ~= 0,
				itemName = item and (item.title or item.name) or nil,
				baseName = item and item.baseName or nil,
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
		-- Skip abyssal sockets and inactive flask slots
		if slot.slotName and not slot.slotName:find("Abyssal Socket") then
			local itemId = slot.selItemId or 0
			if itemId ~= 0 then
				local item = build.itemsTab.items[itemId]
				if item then
					table.insert(result, {
						slot = slot.slotName,
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

local function setMainSocketGroupImpl(groupIndex)
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
local function tradePseudoFor(id)
	local hash = type(id) == "string" and not id:find("^pseudo%.") and id:match("^[a-z]+%.stat_(%d+)$")
	return hash and TRADE_PSEUDO_MAP[hash] or nil
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
	local gen = new("TradeQueryGenerator", { itemsTab = build.itemsTab })
	local _, helpers = findUpvalue(gen.StartQuery, "tradeHelpers")
	helpers = helpers or LoadModule("Classes/TradeHelpers")
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

-- Gear and flask slots PoB can build a weighted search for (no jewel sockets).
local function tradeSlotOrError(slotName, helpers)
	local supported = { }
	for _, slot in ipairs(build.itemsTab.orderedSlots or { }) do
		local name = slot.slotName
		if name and not name:find("Jewel") and not name:find("Abyssal") and not name:find("Socket")
			and helpers.getTradeCategory(name, nil) then
			supported[#supported + 1] = name
		end
	end
	if type(slotName) ~= "string" or not listContains(supported, slotName) then
		userError("Unsupported slot for a trade search: " .. tostring(slotName)
			.. ". Supported slots: " .. table.concat(supported, ", "))
	end
	return build.itemsTab.slots[slotName]
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

local function runTradeQuery(cmd)
	local st = tradeStateOrError()
	local slot = tradeSlotOrError(cmd.slot, st.helpers)
	local statWeights = tradeStatWeights(cmd.statWeights)
	local idTexts = tradeIdTexts(st, cmd.tradeIds)
	local o = cmd.options or { }
	local tradeTypeIndex = nil
	for i, t in ipairs(TRADE_TYPES) do if t == o.tradeType then tradeTypeIndex = i end end
	if not tradeTypeIndex then userError("Unknown tradeType '" .. tostring(o.tradeType) .. "'") end
	local item = build.itemsTab.items[slot.selItemId]
	local queryStr, category = st.helpers.getTradeCategory(slot.slotName, item)
	local influences = o.influences or { }
	local options = {
		statWeights = statWeights,
		includeCorrupted = o.includeCorrupted,
		includeMirrored = o.includeMirrored ~= false,
		includeScourge = o.includeScourge == true,
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
	if ELDRITCH_SLOTS[slot.slotName] then
		options.includeEldritch = ELDRITCH_OPTIONS[tonumber(o.eldritchIndex) or 1] or ELDRITCH_OPTIONS[1]
	end
	if slot.slotName == "Amulet" then options.includeTalisman = o.includeTalisman == true end

	local gen = st.gen
	gen.itemsTab = build.itemsTab
	gen.queryTab = { itemsTab = build.itemsTab }
	gen.lastMaxPrice, gen.lastMaxPriceTypeIndex, gen.lastMaxLevel = nil, nil, nil
	gen.tradeTypeIndex = tradeTypeIndex
	gen.calcContext = { }
	local captured = nil
	gen.requesterContext = nil
	gen.requesterCallback = function(_ctx, json, errMsg) captured = { json = json, err = errMsg } end
	-- Lift PoB's 36-filter cap so every weight comes back; the caller applies
	-- the cap after its own adjustments.
	local maxIdx, maxOrig = findUpvalue(gen.FinishQuery, "MAX_FILTERS")
	local openOrig, closeOrig = rawget(main, "OpenPopup"), rawget(main, "ClosePopup")
	main.OpenPopup = function() return { } end
	main.ClosePopup = function() end
	if maxIdx then debug.setupvalue(gen.FinishQuery, maxIdx, 100000) end
	local started = os.clock()
	local ok, err = pcall(function()
		gen:StartQuery(slot, options)
		local co = gen.calcContext.co
		if not co then
			userError("Path of Building cannot build a weighted trade search for the item in " .. slot.slotName)
		end
		while coroutine.status(co) ~= "dead" do
			local resumed, msg = coroutine.resume(co, gen)
			if not resumed then error("trade weight calculation failed: " .. tostring(msg), 0) end
		end
		gen.calcContext.co = nil
		gen:FinishQuery()
	end)
	local elapsed = os.clock() - started
	if maxIdx then debug.setupvalue(gen.FinishQuery, maxIdx, maxOrig) end
	main.OpenPopup, main.ClosePopup = openOrig, closeOrig
	gen.calcContext = { }
	gen.requesterCallback = nil
	if not ok then error(err, 0) end
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
		capLifted = maxIdx ~= nil,
		itemCategory = category or dkjson.null,
		categoryQuery = queryStr or dkjson.null,
		currentItem = item and (item.title or item.name) or dkjson.null,
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
	local slot = tradeSlotOrError(cmd.slot, st.helpers)
	local item = build.itemsTab.items[slot.selItemId]
	local _, category = st.helpers.getTradeCategory(slot.slotName, item)
	local needle = tostring(cmd.query or ""):lower()
	local found, seen = { }, { }
	local preferredPseudo = { }
	for _, pseudo in pairs(TRADE_PSEUDO_MAP) do preferredPseudo[pseudo] = true end
	-- Only ids generate_trade_search accepts (present in TradeSiteStats.lua).
	-- Single resistances/attributes point at their pseudo total, which is
	-- listed first: PoB weighs those stats through the pseudo filter.
	local function add(id, text, kind)
		if seen[id] or not st.texts[id] then return end
		seen[id] = true
		if text:lower():find(needle, 1, true) then
			found[#found + 1] = {
				tradeId = id, text = text, type = kind,
				preferred = preferredPseudo[id] or nil,
				preferredTradeId = tradePseudoFor(id),
			}
		end
	end
	for _, kind in ipairs({ "Explicit", "Implicit", "Corrupted" }) do
		for _, md in pairs(st.gen.modData[kind] or { }) do
			if category and md[category] ~= nil and md.tradeMod and type(md.tradeMod.id) == "string" then
				add(md.tradeMod.id, tostring(md.tradeMod.text), kind)
			end
		end
	end
	for _, entry in ipairs(st.pseudo) do
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
		handler = function(_cmd) return { input = getFullConfigInput() } end,
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
		handler = function(cmd) restoreConfigInput(cmd.input or { }) return { } end,
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
	equipItem = {
		handler = function(cmd) equipItemInSlot(cmd.slot, cmd.itemText or "") return { } end,
		mutating = true,
	},
	unequipItem = {
		handler = function(cmd) unequipSlot(cmd.slot) return { } end,
		mutating = true,
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
		handler = function(cmd) allocNodesBatch(cmd.nodeIds or { }) return { } end,
		mutating = true,
	},
	deallocNodes = {
		handler = function(cmd) deallocNodesBatch(cmd.nodeIds or { }) return { } end,
		mutating = true,
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
		handler = function(cmd) setMainSocketGroupImpl(cmd.groupIndex) return { } end,
		mutating = true,
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

local function dispatch(cmd)
	if type(cmd) ~= "table" then
		error("Command must be a JSON object")
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
