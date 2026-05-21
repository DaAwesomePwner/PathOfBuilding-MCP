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

local IS_FLAT_INSTALL = fileExists(POB_PATH .. "/Launch.lua")
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

-- Search Handles
function NewFileSearch() end

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
function Deflate(data)
	return ""
end
function Inflate(data)
	return ""
end
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
-- and sets userError = true in the response.
local USER_ERROR_PREFIX = "__USER__"
local function userError(msg)
  error(USER_ERROR_PREFIX .. msg)
end

dofile(SCRIPT_PATH .. "/Launch.lua")
mainObject.continuousIntegrationMode = os.getenv("CI")
runCallback("OnInit")
runCallback("OnFrame")

if mainObject.promptMsg then
	error(mainObject.promptMsg)
end

build = mainObject.main.modes["BUILD"]

function newBuild()
	mainObject.main:SetMode("BUILD", false, "Help, I'm stuck in Path of Building!")
	runCallback("OnFrame")
	build = mainObject.main.modes["BUILD"]
end

function loadBuildFromXML(xmlText, name)
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

local function respond(obj)
	io.stdout:write(dkjson.encode(obj) .. "\n")
	io.stdout:flush()
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
	return {
		class = build.className or (build.spec and build.spec.curClassName),
		ascendancy = build.ascendClassName or (build.spec and build.spec.curAscendClassName),
		level = build.characterLevel,
		mainSkill = getMainSkillName(),
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

local function equipItemInSlot(slotName, itemRaw)
	local slot = build.itemsTab.slots[slotName]
	if not slot then
		userError("Unknown slot: " .. tostring(slotName))
	end
	build.itemsTab:CreateDisplayItemFromRaw(itemRaw)
	if not build.itemsTab.displayItem then
		userError("Failed to parse item raw text")
	end
	build.itemsTab:AddDisplayItem(true) -- noAutoEquip = true
	-- The new item id is the highest in items map after AddDisplayItem.
	-- AddItem assigns the next free id, so find it.
	local maxId = 0
	for id, _ in pairs(build.itemsTab.items) do
		if id > maxId then maxId = id end
	end
	slot:SetSelItemId(maxId)
	build.buildFlag = true
	build.itemsTab:PopulateSlots()
	runCallback("OnFrame")
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

local function restoreTreeFromIds(nodeIds)
	-- Use ImportFromNodeList to atomically replace the tree with the snapshot.
	local hashList = { }
	for _, id in ipairs(nodeIds) do
		table.insert(hashList, id)
	end
	-- Preserve current mastery selections (deep copy)
	local masteryEffects = { }
	if build.spec.masterySelections then
		for k, v in pairs(build.spec.masterySelections) do
			masteryEffects[k] = v
		end
	end
	build.spec:ImportFromNodeList(
		build.spec.curClassId,
		build.spec.curAscendClassId,
		build.spec.curSecondaryAscendClassId,
		hashList,
		build.spec.hashOverrides or { },
		masteryEffects,
		build.spec.treeVersion
	)
	build.buildFlag = true
	runCallback("OnFrame")
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

local function allocNodesBatch(nodeIds)
	for _, id in ipairs(nodeIds or { }) do
		local node = build.spec.nodes[id]
		if not node then
			userError("Unknown node id: " .. tostring(id))
		end
		build.spec:AllocNode(node)
	end
	build.buildFlag = true
	runCallback("OnFrame")
end

local function deallocNodesBatch(nodeIds)
	for _, id in ipairs(nodeIds or { }) do
		local node = build.spec.nodes[id]
		if not node then
			userError("Unknown node id: " .. tostring(id))
		end
		build.spec:DeallocNode(node)
	end
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

local function snapshotSkills()
	local snap = { mainSocketGroup = build.mainSocketGroup, groups = { } }
	if not (build and build.skillsTab and build.skillsTab.socketGroupList) then
		return snap
	end
	for i, group in ipairs(build.skillsTab.socketGroupList) do
		local gemList = { }
		for j, gem in ipairs(group.gemList or { }) do
			gemList[j] = {
				nameSpec = gem.nameSpec,
				gemId = gem.gemId,
				skillId = gem.skillId,
				level = gem.level,
				quality = gem.quality,
				qualityId = gem.qualityId,
				enabled = gem.enabled,
				enableGlobal1 = gem.enableGlobal1,
				enableGlobal2 = gem.enableGlobal2,
				count = gem.count,
				skillPart = gem.skillPart,
				skillPartCalcs = gem.skillPartCalcs,
				skillMineCount = gem.skillMineCount,
				skillStageCount = gem.skillStageCount,
				skillStageCountCalcs = gem.skillStageCountCalcs,
				triggered = gem.triggered,
			}
		end
		snap.groups[i] = {
			label = group.label,
			slot = group.slot,
			enabled = group.enabled,
			source = group.source,
			mainActiveSkill = group.mainActiveSkill,
			mainActiveSkillCalcs = group.mainActiveSkillCalcs,
			includeInFullDPS = group.includeInFullDPS,
			noSupports = group.noSupports,
			gemList = gemList,
		}
	end
	return snap
end

local function restoreSkills(snap)
	if not (build and build.skillsTab and build.skillsTab.socketGroupList) then
		error("Skills tab not available")
	end
	if type(snap) ~= "table" or type(snap.groups) ~= "table" then
		error("Invalid skills snapshot")
	end
	-- Wipe current groups; we mutate in place to preserve socketGroupList reference
	local list = build.skillsTab.socketGroupList
	for i = #list, 1, -1 do list[i] = nil end
	for i, snapGroup in ipairs(snap.groups) do
		local group = {
			label = snapGroup.label,
			slot = snapGroup.slot,
			enabled = snapGroup.enabled,
			source = snapGroup.source,
			mainActiveSkill = snapGroup.mainActiveSkill,
			mainActiveSkillCalcs = snapGroup.mainActiveSkillCalcs,
			includeInFullDPS = snapGroup.includeInFullDPS,
			noSupports = snapGroup.noSupports,
			gemList = { },
		}
		for j, snapGem in ipairs(snapGroup.gemList) do
			local g = { }
			for k, v in pairs(snapGem) do g[k] = v end
			group.gemList[j] = g
		end
		list[i] = group
		build.skillsTab:ProcessSocketGroup(group)
	end
	build.mainSocketGroup = snap.mainSocketGroup or 1
	build.buildFlag = true
	runCallback("OnFrame")
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
			loadBuildFromXML(xmlText, cmd.name or "MCP Build")
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
	snapshotAllItems = {
		handler = function(cmd)
			if type(cmd.slots) ~= "table" then
				userError("snapshotAllItems requires `slots` array")
			end
			local out = {}
			for i = 1, #cmd.slots do
				local slotName = cmd.slots[i]
				local item = getItemInSlot(slotName)
				-- Transform to ItemSnapshot shape: { slot, itemText, itemId }
				-- (mirrors the logic in TS snapshotSlotUnlocked)
				if item.itemId and item.itemId ~= 0 and item.raw then
					out[i] = { slot = slotName, itemText = item.raw, itemId = item.itemId }
				else
					out[i] = { slot = slotName, itemText = dkjson.null, itemId = dkjson.null }
				end
			end
			return { items = out }
		end,
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
		handler = function(cmd) restoreTreeFromIds(cmd.nodeIds or { }) return { } end,
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

	-- Utility
	ping = {
		handler = function(_cmd) return { } end,
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
	local body = entry.handler(cmd)
	if entry.mutating then
		body.stats = getStats()
	end
	body.ok = true
	return body
end

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
			-- Strip Lua source path/line prefixes (e.g. ".../bridge.lua:411: ") so
			-- the surface error message is user-friendly. This MUST happen before
			-- the userError prefix check because Lua wraps thrown errors with
			-- source-location prefixes; after stripping, __USER__ appears at start.
			local msg = tostring(result)
			msg = msg:gsub("^%.%.%.[^:]*%.lua:%d+:%s*", "")
			msg = msg:gsub("^[^:]*%.lua:%d+:%s*", "")
			local userFlag = false
			if msg:sub(1, #USER_ERROR_PREFIX) == USER_ERROR_PREFIX then
				msg = msg:sub(#USER_ERROR_PREFIX + 1)
				userFlag = true
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
