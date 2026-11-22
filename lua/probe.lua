-- Read-only what-if probes through Path of Building's own calculator.
--
-- `probe` evaluates many variants of the loaded build (passive nodes, items,
-- gems, config) with `build.calcsTab:GetMiscCalculator()`, the calculator
-- PoB's UI uses for its tooltip stat deltas, and never runs a full recalc
-- (BuildOutput) or sets `build.buildFlag`. Per variant:
--   1. data changes are applied in place: config input (+ BuildModList),
--      gem lists (changed gems are copies; the original gem objects are put
--      back), items (each assigned to its slot under a free item id);
--   2. calcFunc({ addNodes / removeNodes }, useFullDPS) runs on that data;
--   3. every data change is undone, in reverse order.
-- After the whole command the committed state is compared with a fingerprint
-- taken before it (gem lists, config input, item slots and items, allocated
-- nodes, mainOutput identity, buildFlag); any difference is an internal error
-- naming reset_build.
--
-- Variant kinds the calculator cannot reproduce exactly come back as
-- { fallback = true, reason } and are run by the caller through `probeCommit`
-- (apply for real -> full recalc -> read) between a full snapshot and its
-- exact restore (BuildSession.probe does this). They are:
--   * more than one node change (allocate/deallocate together, or several of
--     either): PoB recomputes paths/dependencies after every single change;
--   * a node change touching a cluster-jewel socket or expansion node, a
--     jewel socket holding a jewel, a multiple-choice option, or a node that
--     grants a skill (the skill's socket group exists only after a full recalc);
--   * an item in a passive-tree jewel socket (cluster graphs / conquered
--     nodes are rebuilt by the spec), an item granting a skill or replacing
--     one that does;
--   * every variant while the party tab's "export buffs" option is on (see
--     checkVariant).
-- Gem changes on item- or tree-granted socket groups are refused.
--
-- Full DPS: PoB's calculator only rolls up Full DPS when the build already
-- had a skill counted in it when the calculator was made. When it had none,
-- the roll-up is run here with the same arguments (so a variant that adds the
-- build's first Full DPS skill is still exact), or FullDPS / FullDotDPS are 0
-- when no socket group is included in Full DPS (what a full recalc reports).
return function(ctx)
	local userError = ctx.userError
	local USER_ERROR_PREFIX = ctx.USER_ERROR_PREFIX
	local jsonNull = ctx.jsonNull

	local M = { }
	M.MAX_VARIANTS = 500
	M.MAX_NODE_LIST = 100
	M.MAX_ITEMS = 10
	M.MAX_GEM_CHANGES = 20
	M.MAX_CONFIG_KEYS = 50
	M.MAX_STAT_KEYS = 200

	local function isInt(v, min)
		return type(v) == "number" and v == v and v % 1 == 0 and v >= (min or 0) and v < 2 ^ 31
	end

	local function isArray(v)
		if type(v) ~= "table" then return false end
		local n = 0
		for _ in pairs(v) do n = n + 1 end
		return n == #v
	end

	local function optArray(v, label, max)
		if v == nil then return { } end
		if not isArray(v) then userError(label .. " must be an array") end
		if #v > max then userError(label .. " has " .. #v .. " entries; at most " .. max .. " are allowed") end
		return v
	end

	local function nodeLabel(node)
		return tostring(node.id) .. (node.dn and (" (" .. node.dn .. ")") or "")
	end

	-- ------------------------------------------------------------------
	-- Stats
	-- ------------------------------------------------------------------

	local function statKeyList(requested)
		if requested == nil then return ctx.statKeys end
		if not isArray(requested) then userError("stats must be an array of stat names") end
		if #requested > M.MAX_STAT_KEYS then
			userError("stats has " .. #requested .. " names; at most " .. M.MAX_STAT_KEYS .. " are allowed")
		end
		for i, key in ipairs(requested) do
			if type(key) ~= "string" or key == "" then userError("stats[" .. i .. "] must be a non-empty string") end
		end
		return requested
	end

	-- Numbers, strings and booleans only; anything else (or missing) is null.
	local function readStats(output, keys, nullFullDPS)
		local stats = { }
		for _, key in ipairs(keys) do
			local value = ctx.copyValue(output[key])
			if nullFullDPS and (key == "FullDPS" or key == "FullDotDPS") then value = nil end
			if value == nil then value = jsonNull end
			stats[key] = value
		end
		return stats
	end

	-- Stats only a full recalc (calcs.buildOutput in MAIN mode) adds to the
	-- output, recomputed from the calculator's main env with the same formulas.
	local TREE_INC = {
		["Spec:LifeInc"] = { "Life" },
		["Spec:ManaInc"] = { "Mana" },
		["Spec:ArmourInc"] = { "Armour", "ArmourAndEvasion" },
		["Spec:EvasionInc"] = { "Evasion", "ArmourAndEvasion" },
		["Spec:EnergyShieldInc"] = { "EnergyShield" },
	}

	local function addMainOnlyStats(stats, keys, env)
		if not (env and env.modDB) then return end
		for _, key in ipairs(keys) do
			if stats[key] == jsonNull then
				if TREE_INC[key] then
					stats[key] = env.modDB:Sum("INC", { source = "Tree" }, unpack(TREE_INC[key]))
				elseif key == "ExtraPoints" then
					stats[key] = env.modDB:Sum("BASE", nil, "ExtraPoints")
				end
			end
		end
	end

	-- ------------------------------------------------------------------
	-- Nodes
	-- ------------------------------------------------------------------

	local function grantsSkill(node)
		for _, mod in ipairs(node.modList or { }) do
			if mod.name == "ExtraSkill" then return true end
		end
		return false
	end

	local function holdsJewel(spec, node)
		return node.type == "Socket" and (spec.jewels[node.id] or 0) ~= 0
	end

	-- Why changing `set` (allocating it when `adding`) cannot go through the
	-- calculator exactly, or nil.
	local function nodeFallbackReason(spec, set, adding)
		for node in pairs(set) do
			if node.expansionJewel ~= nil then return "node " .. nodeLabel(node) .. " is a cluster jewel expansion socket" end
			if holdsJewel(spec, node) then return "node " .. nodeLabel(node) .. " is a jewel socket holding a jewel" end
			if adding and node.isMultipleChoiceOption then return "node " .. nodeLabel(node) .. " is a multiple-choice option" end
			if grantsSkill(node) then return "node " .. nodeLabel(node) .. " grants a skill" end
		end
		return nil
	end

	local function nodeById(spec, id, label)
		if not isInt(id, 0) then userError(label .. " must be a node id (integer)") end
		local node = spec.nodes[id]
		if not node then userError("Unknown node id: " .. tostring(id)) end
		return node
	end

	-- Validate a variant's node lists against the committed tree (user errors
	-- before any change). Returns the nodes to allocate and to deallocate.
	function M.checkNodes(variant)
		local spec = build.spec
		local alloc = optArray(variant.allocate, "allocate", M.MAX_NODE_LIST)
		local dealloc = optArray(variant.deallocate, "deallocate", M.MAX_NODE_LIST)
		local seen = { }
		local addList, removeList = { }, { }
		for i, id in ipairs(alloc) do
			local node = nodeById(spec, id, "allocate[" .. i .. "]")
			if seen[node] then userError("Node " .. nodeLabel(node) .. " is listed twice") end
			seen[node] = true
			if node.type == "Mastery" then
				userError("Node " .. nodeLabel(node) .. " is a mastery; probe cannot allocate masteries (they need an effect choice)")
			end
			if node.alloc then userError("Node " .. nodeLabel(node) .. " is already allocated") end
			if not node.path or #node.path == 0 then
				userError("Node " .. nodeLabel(node) .. " cannot be allocated: no path from the allocated tree reaches it")
			end
			addList[#addList + 1] = node
		end
		for i, id in ipairs(dealloc) do
			local node = nodeById(spec, id, "deallocate[" .. i .. "]")
			if seen[node] then userError("Node " .. nodeLabel(node) .. " is listed twice") end
			seen[node] = true
			if node.type == "ClassStart" or node.type == "AscendClassStart" then
				userError("Node " .. nodeLabel(node) .. " is a class start and cannot be deallocated")
			end
			if not node.alloc then userError("Node " .. nodeLabel(node) .. " is not allocated") end
			removeList[#removeList + 1] = node
		end
		return addList, removeList
	end

	-- The node set one change touches, exactly as PassiveSpec:AllocNode /
	-- DeallocNode would change it.
	local function allocSet(node)
		local set = { }
		if #(node.intuitiveLeapLikesAffecting or { }) > 0 then
			set[node] = true
		else
			for _, pathNode in ipairs(node.path) do set[pathNode] = true end
		end
		return set
	end

	local function deallocSet(node)
		local set = { [node] = true }
		for _, dep in ipairs(node.depends or { }) do set[dep] = true end
		return set
	end

	local function countsAsPoint(node)
		return not node.ascendancyName and node.type ~= "ClassStart" and node.type ~= "AscendClassStart"
	end

	local function describeSet(set)
		local ids, points = { }, 0
		for node in pairs(set) do
			ids[#ids + 1] = node.id
			if countsAsPoint(node) then points = points + 1 end
		end
		table.sort(ids)
		return ids, points
	end

	-- ------------------------------------------------------------------
	-- Items
	-- ------------------------------------------------------------------

	local function hasGrantedSkills(item)
		return item ~= nil and type(item.grantedSkills) == "table" and #item.grantedSkills > 0
	end

	-- The slot whose item decides whether `slot` can hold an item: the main
	-- hand for an off-hand (ItemsTab:IsItemValidForSlot), the parent item for
	-- an abyssal socket (assertItemFitsSlot / ItemSlot:Populate).
	local function governingSlotName(slot)
		if slot.parentSlot then return slot.parentSlot.slotName end
		if slot.slotName == "Weapon 2" then return "Weapon 1" end
		if slot.slotName == "Weapon 2 Swap" then return "Weapon 1 Swap" end
		return nil
	end

	-- Parse every item and check what can be checked against the committed
	-- build (user errors before any change); an item whose fit depends on
	-- another item of the same variant is checked again when it is applied.
	-- Returns { { slot, item, itemText } ... } and a fallback reason or nil.
	function M.checkItems(variant)
		local list = optArray(variant.items, "items", M.MAX_ITEMS)
		local tab = build.itemsTab
		local parsed, bySlot, reason = { }, { }, nil
		for i, entry in ipairs(list) do
			if type(entry) ~= "table" or type(entry.slot) ~= "string" or type(entry.itemText) ~= "string" then
				userError("items[" .. i .. "] must be { slot, itemText }")
			end
			local slot = tab.slots[entry.slot]
			if not slot then userError("Unknown slot: " .. entry.slot) end
			if bySlot[entry.slot] then userError("Slot " .. entry.slot .. " is listed twice") end
			local item = ctx.parseItemText(entry.itemText, entry.slot)
			bySlot[entry.slot] = item
			parsed[i] = { slot = slot, item = item, itemText = entry.itemText }
			local current = tab.items[slot.selItemId or 0]
			if slot.nodeId then
				reason = reason or (entry.slot .. " is a passive tree jewel socket")
			elseif hasGrantedSkills(item) or hasGrantedSkills(current) then
				reason = reason or ("the item for " .. entry.slot .. " or the item it replaces grants a skill")
			end
		end
		for _, p in ipairs(parsed) do
			local governing = governingSlotName(p.slot)
			if not (governing and bySlot[governing]) then
				ctx.assertItemFitsSlot(tab, p.slot, p.item)
			end
		end
		return parsed, reason
	end

	local function freeItemId(tab)
		local id = 1
		while tab.items[id] do id = id + 1 end
		return id
	end

	-- Equip the items one after another the way equip_item does, without
	-- its side effects on the committed build: each item is checked against
	-- the slots as they are at that point, added under a free id and selected
	-- (slot.selItemId and the active item set's entry, as ItemSlot:SetSelItemId
	-- does for a non-socket slot); then what ItemsTab:PopulateSlots would do is
	-- emulated: every slot whose item no longer fits is emptied (an off-hand
	-- after a new main hand) and abyssal sockets beyond their parent item's
	-- socket count are emptied. Returns the undo function, which puts every
	-- slot, set entry and the item list back.
	local function applyItems(parsed)
		local tab = build.itemsTab
		local itemSet = tab.activeItemSet
		local changes, added = { }, { }
		local function select(slot, id)
			local entry = itemSet[slot.slotName]
			changes[#changes + 1] = { slot = slot, slotId = slot.selItemId, entry = entry, entryId = entry and entry.selItemId }
			if entry then entry.selItemId = id end
			slot.selItemId = id
		end
		local function undo()
			for i = #changes, 1, -1 do
				local c = changes[i]
				c.slot.selItemId = c.slotId
				if c.entry then c.entry.selItemId = c.entryId end
			end
			for i = #added, 1, -1 do tab.items[added[i]] = nil end
			build.skillsTab:UpdateSocketGroups()
		end
		local function populate()
			for _, slot in ipairs(tab.orderedSlots) do
				local id = slot.selItemId or 0
				if not slot.nodeId and id ~= 0 then
					local item = tab.items[id]
					if not item or not tab:IsItemValidForSlot(item, slot.slotName) then select(slot, 0) end
				end
			end
			for _, slot in ipairs(tab.orderedSlots) do
				if not slot.nodeId and slot.abyssalSocketList then
					local item = tab.items[slot.selItemId or 0]
					local count = item and item.abyssalSocketCount or 0
					for i, socket in ipairs(slot.abyssalSocketList) do
						if i > count and (socket.selItemId or 0) ~= 0 then select(socket, 0) end
					end
				end
			end
		end
		local ok, err = pcall(function()
			for _, p in ipairs(parsed) do
				ctx.assertItemFitsSlot(tab, p.slot, p.item)
				local id = freeItemId(tab)
				p.item.id = id
				tab.items[id] = p.item
				added[#added + 1] = id
				p.item:BuildModList() -- as ItemsTab:AddItem does
				select(p.slot, id)
				populate()
			end
			build.skillsTab:UpdateSocketGroups()
		end)
		if not ok then
			undo()
			error(err, 0)
		end
		return undo
	end

	-- ------------------------------------------------------------------
	-- Gems
	-- ------------------------------------------------------------------

	local GEM_OPS = { set = true, remove = true, add = true }

	local function checkGemChange(ch, i)
		local label = "gems[" .. i .. "]"
		if type(ch) ~= "table" or not GEM_OPS[ch.op] then
			userError(label .. ": op must be one of set, remove, add")
		end
		if not isInt(ch.group, 1) then userError(label .. ": group must be a 1-based integer") end
		if ch.op ~= "add" and not isInt(ch.index, 1) then userError(label .. ": index must be a 1-based integer") end
		if ch.op == "add" and type(ch.name) ~= "string" then userError(label .. ": add needs a gem name") end
		if ch.name ~= nil and type(ch.name) ~= "string" then userError(label .. ": name must be a string") end
		for _, key in ipairs({ "level", "quality" }) do
			if ch[key] ~= nil and not isInt(ch[key], 0) then userError(label .. ": " .. key .. " must be a non-negative integer") end
		end
		if ch.enabled ~= nil and type(ch.enabled) ~= "boolean" then userError(label .. ": enabled must be a boolean") end
		if ch.position ~= nil and not isInt(ch.position, 1) then userError(label .. ": position must be a 1-based integer") end
		if ch.op == "set" and ch.name == nil and ch.level == nil and ch.quality == nil and ch.enabled == nil then
			userError(label .. ": set needs at least one of name, level, quality, enabled")
		end
		return label
	end

	local function lookupGem(name, label)
		local gemData, errMsg = ctx.findGemByName(name)
		if not gemData then userError(label .. ": gem lookup failed for '" .. tostring(name) .. "': " .. tostring(errMsg)) end
		return gemData
	end

	-- Apply gem changes in order (indices refer to the group as it is when
	-- that change applies, like calling the gem commands one after another).
	-- Changed gems are copies; returns the undo function, which puts the
	-- original gem objects back.
	local function applyGems(changes)
		local skillsTab = build.skillsTab
		local groups = skillsTab.socketGroupList
		local order, original, copies = { }, { }, { }
		local function undo()
			for i = #order, 1, -1 do
				local group = order[i]
				local list = group.gemList
				for j = #list, 1, -1 do list[j] = nil end
				for j, gem in ipairs(original[group]) do list[j] = gem end
				skillsTab:ProcessSocketGroup(group)
			end
			if #order > 0 then skillsTab:UpdateSocketGroups() end
		end
		local ok, err = pcall(function()
			for i, ch in ipairs(changes) do
				local label = checkGemChange(ch, i)
				local group = groups[ch.group]
				if not group then userError(label .. ": skill group not found at index " .. tostring(ch.group)) end
				if group.source then
					userError(label .. ": group " .. ch.group .. " is granted by an item or the passive tree; probe cannot change its gems")
				end
				if not original[group] then
					local copy = { }
					for j, gem in ipairs(group.gemList) do copy[j] = gem end
					original[group] = copy
					order[#order + 1] = group
				end
				local list = group.gemList
				if ch.op == "add" then
					local gemData = lookupGem(ch.name, label)
					local newGem = {
						nameSpec = gemData.name, gemId = gemData.id, skillId = gemData.grantedEffectId,
						level = ch.level or 20, quality = ch.quality or 0,
						enabled = true, enableGlobal1 = true, enableGlobal2 = true, count = 1,
					}
					if ch.enabled ~= nil then newGem.enabled = ch.enabled end
					if ch.position and ch.position <= #list + 1 then
						table.insert(list, ch.position, newGem)
					else
						table.insert(list, newGem)
					end
					copies[newGem] = true
				else
					local gem = list[ch.index]
					if not gem then
						userError(label .. ": gem not found at index " .. ch.index .. " in group " .. ch.group)
					end
					if ch.op == "remove" then
						table.remove(list, ch.index)
					else
						if not copies[gem] then
							local copy = { }
							for k, v in pairs(gem) do copy[k] = v end
							copies[copy] = true
							list[ch.index] = copy
							gem = copy
						end
						if ch.name ~= nil then
							-- As setGem does.
							local gemData = lookupGem(ch.name, label)
							gem.gemId = gemData.id
							gem.skillId = gemData.grantedEffectId
							gem.nameSpec = gemData.name
							gem.gemData = nil
							gem.grantedEffect = nil
							gem.enabled = true
							gem.new = nil
						end
						if ch.level ~= nil then gem.level = ch.level end
						if ch.quality ~= nil then gem.quality = ch.quality end
						if ch.enabled ~= nil then gem.enabled = ch.enabled end
					end
				end
			end
			for _, group in ipairs(order) do skillsTab:ProcessSocketGroup(group) end
			if #order > 0 then skillsTab:UpdateSocketGroups() end
		end)
		if not ok then
			undo()
			error(err, 0)
		end
		return undo
	end

	-- ------------------------------------------------------------------
	-- Config
	-- ------------------------------------------------------------------

	local configVars = nil
	local function knownConfigVar(key)
		if not configVars then
			configVars = { customMods = true }
			for _, meta in ipairs(ctx.getConfigMetadata()) do configVars[meta.var] = true end
		end
		return configVars[key] == true
	end

	local function checkConfig(variant)
		local options = variant.config
		if options == nil then return nil end
		if type(options) ~= "table" or (next(options) ~= nil and isArray(options)) then
			userError("config must be an object of config keys")
		end
		local n = 0
		for key, value in pairs(options) do
			n = n + 1
			if type(key) ~= "string" or not knownConfigVar(key) then
				userError("Unknown config key: \"" .. tostring(key) .. "\". Use get_config to list valid keys.")
			end
			local t = type(value)
			if t ~= "number" and t ~= "string" and t ~= "boolean" then
				userError("Invalid value for config key \"" .. key .. "\": must be a number, string or boolean")
			end
		end
		if n > M.MAX_CONFIG_KEYS then userError("config has " .. n .. " keys; at most " .. M.MAX_CONFIG_KEYS .. " are allowed") end
		return n > 0 and options or nil
	end

	-- Set the inputs and rebuild the config mod list, as set_config does
	-- (without the recalc). Returns the undo function.
	local function applyConfig(options)
		local configTab = build.configTab
		local input = configTab.input
		local saved, flag = { }, build.buildFlag
		for key, value in pairs(options) do
			saved[key] = { value = input[key] }
			input[key] = value
		end
		local function undo()
			for key, s in pairs(saved) do input[key] = s.value end
			configTab:BuildModList()
			build.buildFlag = flag
		end
		local ok, err = pcall(function() configTab:BuildModList() end)
		build.buildFlag = flag
		if not ok then
			undo()
			error(err, 0)
		end
		return undo
	end

	-- ------------------------------------------------------------------
	-- Committed-state fingerprint
	-- ------------------------------------------------------------------

	local GEM_FIELDS = { "nameSpec", "gemId", "skillId", "level", "quality", "enabled", "count", "gemData", "grantedEffect" }

	local function fingerprint()
		local fp = { }
		local function add(...)
			local parts = { ... }
			for i = 1, select("#", ...) do parts[i] = tostring(parts[i]) end
			fp[#fp + 1] = table.concat(parts, "|")
		end
		add("mainOutput", build.calcsTab.mainOutput, "buildFlag", build.buildFlag, "mainSocketGroup", build.mainSocketGroup)
		local ids = { }
		for id in pairs(build.spec.allocNodes) do ids[#ids + 1] = id end
		table.sort(ids)
		add("nodes", table.concat(ids, ","))
		local tab = build.itemsTab
		for _, slot in ipairs(tab.orderedSlots) do
			local entry = tab.activeItemSet[slot.slotName]
			add("slot", slot.slotName, slot.selItemId, entry and entry.selItemId)
		end
		local itemIds = { }
		for id, item in pairs(tab.items) do itemIds[#itemIds + 1] = id .. "=" .. tostring(item) end
		table.sort(itemIds)
		add("items", table.concat(itemIds, ","), table.concat(tab.itemOrderList, ","))
		for gi, group in ipairs(build.skillsTab.socketGroupList) do
			add("group", gi, group, group.enabled, group.mainActiveSkill, #group.gemList)
			for gj, gem in ipairs(group.gemList) do
				local vals = { }
				for k, f in ipairs(GEM_FIELDS) do vals[k] = tostring(gem[f]) end
				add("gem", gi, gj, gem, table.concat(vals, ","))
			end
		end
		local keys = { }
		for k, v in pairs(build.configTab.input) do keys[#keys + 1] = tostring(k) .. "=" .. type(v) .. ":" .. tostring(v) end
		table.sort(keys)
		add("config", table.concat(keys, ","), build.configTab.enemyLevel)
		return fp
	end

	local function fingerprintDiff(a, b)
		local n = math.max(#a, #b)
		for i = 1, n do
			if a[i] ~= b[i] then return tostring(a[i]) .. " -> " .. tostring(b[i]) end
		end
		return nil
	end

	-- ------------------------------------------------------------------
	-- Commands
	-- ------------------------------------------------------------------

	local function isUserErr(err)
		return tostring(err):sub(1, #USER_ERROR_PREFIX) == USER_ERROR_PREFIX
	end

	local function variantErrorResult(err)
		local msg = tostring(err)
		if isUserErr(msg) then
			return { error = msg:sub(#USER_ERROR_PREFIX + 1), userError = true }
		end
		return { error = (msg:gsub("^[^:]*%.lua:%d+:%s*", "")), userError = false }
	end

	local function flushPendingRecalc()
		if build.buildFlag then
			runCallback("OnFrame")
			build = mainObject.main.modes["BUILD"]
		end
	end

	-- Validate a variant (user errors) and decide whether it can go through
	-- the calculator. Returns the checked pieces.
	local function checkVariant(variant)
		if type(variant) ~= "table" or (next(variant) ~= nil and isArray(variant)) then
			userError("each variant must be an object")
		end
		local addList, removeList = M.checkNodes(variant)
		local parsedItems, reason = M.checkItems(variant)
		local config = checkConfig(variant)
		local gems = optArray(variant.gems, "gems", M.MAX_GEM_CHANGES)
		for i, ch in ipairs(gems) do checkGemChange(ch, i) end
		local nodeSet, adding = nil, false
		if #addList + #removeList > 1 then
			reason = reason or "more than one node change (paths are recomputed after each)"
		elseif #addList == 1 then
			nodeSet, adding = allocSet(addList[1]), true
		elseif #removeList == 1 then
			nodeSet = deallocSet(removeList[1])
		end
		if nodeSet and not reason then
			reason = nodeFallbackReason(build.spec, nodeSet, adding)
		end
		-- With the party tab's "export buffs" option on, CalcPerform computes
		-- the MAIN pass differently from the CALCULATOR pass (only MAIN collects
		-- buff exports, and that branch can apply non-unique flasks to a minion
		-- through a link skill), so the calculator is not trusted then. PoB
		-- neither saves nor loads the option in build XML and the bridge never
		-- sets it, so this cannot happen through the MCP tools today.
		if build.partyTab and build.partyTab.enableExportBuffs then
			reason = reason or "the party tab's export-buffs option is on"
		end
		return {
			addList = addList, removeList = removeList, items = parsedItems, config = config, gems = gems,
			nodeSet = nodeSet, adding = adding, fallbackReason = reason,
		}
	end

	local function wipeCalculatorCache()
		local cache = GlobalCache and GlobalCache.cachedData and GlobalCache.cachedData.CALCULATOR
		if cache then wipeTable(cache) end
	end

	-- The main env of the calculator pass that runs next (the first
	-- calcs.perform call inside calcFunc), captured by wrapping calcs.perform
	-- for the duration of the probe command.
	-- calcs.initEnv is wrapped the same way to keep the cached mod DBs of that
	-- pass, which a Full DPS roll-up run here needs.
	local capturedEnv, capturedInit = nil, nil
	local function withEnvCapture(fn)
		local calcsMod = build.calcsTab.calcs
		local perform = calcsMod and calcsMod.perform
		local initEnv = calcsMod and calcsMod.initEnv
		if type(perform) ~= "function" or type(initEnv) ~= "function" then
			error("Path of Building's calcs module changed (no calcs.perform / calcs.initEnv)")
		end
		calcsMod.perform = function(env, ...)
			if capturedEnv == nil then capturedEnv = env end
			return perform(env, ...)
		end
		calcsMod.initEnv = function(...)
			local results = { initEnv(...) }
			if capturedInit == nil then capturedInit = results end
			return unpack(results, 1, table.maxn(results))
		end
		local ok, res = pcall(fn)
		calcsMod.perform = perform
		calcsMod.initEnv = initEnv
		capturedEnv, capturedInit = nil, nil
		if not ok then error(res, 0) end
		return res
	end

	local function anyGroupInFullDPS()
		for _, group in ipairs(build.skillsTab.socketGroupList) do
			if group.includeInFullDPS then return true end
		end
		return false
	end

	-- Full DPS for a calculator that was made without any Full DPS skill (see
	-- the header): the roll-up calcFunc would run, with the main pass's DBs.
	local function addFullDPS(output, override)
		if anyGroupInFullDPS() and capturedInit then
			local env, playerDB, enemyDB, minionDB = capturedInit[1], capturedInit[2], capturedInit[3], capturedInit[4]
			local fullDPS = build.calcsTab.calcs.calcFullDPS(build, "CALCULATOR", override, {
				cachedPlayerDB = playerDB, cachedEnemyDB = enemyDB, cachedMinionDB = minionDB, env = nil,
				triggerSourceCache = env and env.triggerSourceCache,
			})
			output.SkillDPS = fullDPS.skills
			output.FullDPS = fullDPS.combinedDPS
			output.FullDotDPS = fullDPS.TotalDotDPS
		else
			output.FullDPS = 0
			output.FullDotDPS = 0
		end
	end

	-- One variant through the calculator: data changes, calcFunc, undo.
	local function runFast(checked, calcFunc, keys, useFullDPS, nullFullDPS, rollUpHere)
		local undos = { }
		local ok, res = pcall(function()
			if checked.config then undos[#undos + 1] = applyConfig(checked.config) end
			if #checked.gems > 0 then undos[#undos + 1] = applyGems(checked.gems) end
			if #checked.items > 0 then undos[#undos + 1] = applyItems(checked.items) end
			local override = { }
			local result = { }
			if checked.nodeSet then
				local ids, points = describeSet(checked.nodeSet)
				if checked.adding then
					override.addNodes = checked.nodeSet
					result.nodesAdded, result.pointsAdded = ids, points
				else
					override.removeNodes = checked.nodeSet
					result.nodesRemoved, result.pointsRemoved = ids, points
				end
			end
			wipeCalculatorCache()
			capturedEnv, capturedInit = nil, nil
			local output = calcFunc(override, useFullDPS)
			if rollUpHere then addFullDPS(output, override) end
			result.stats = readStats(output, keys, nullFullDPS)
			addMainOnlyStats(result.stats, keys, capturedEnv)
			capturedEnv, capturedInit = nil, nil
			return result
		end)
		local restoreErr = nil
		for i = #undos, 1, -1 do
			local rok, rerr = pcall(undos[i])
			if not rok and not restoreErr then restoreErr = rerr end
		end
		if restoreErr then
			error("probe could not undo a variant's changes (" .. tostring(restoreErr):gsub("^" .. USER_ERROR_PREFIX, "")
				.. "); the build may differ from the committed one: call reset_build", 0)
		end
		if not ok then error(res, 0) end
		return res
	end

	function M.probe(cmd)
		flushPendingRecalc()
		local keys = statKeyList(cmd.stats)
		local variants = cmd.variants
		if variants == nil then variants = { } end
		if not isArray(variants) then userError("variants must be an array") end
		if #variants > M.MAX_VARIANTS then
			userError("variants has " .. #variants .. " entries; at most " .. M.MAX_VARIANTS .. " are allowed per call")
		end
		if cmd.useFullDPS ~= nil and type(cmd.useFullDPS) ~= "boolean" then userError("useFullDPS must be a boolean") end
		local useFullDPS = cmd.useFullDPS
		if cmd.classifyOnly then
			-- Validate and classify only (nothing is computed or changed).
			local results = { }
			for i, variant in ipairs(variants) do
				local ok, res = pcall(checkVariant, variant)
				if not ok then
					results[i] = variantErrorResult(res)
				elseif res.fallbackReason then
					results[i] = { fallback = true, reason = res.fallbackReason }
				else
					results[i] = { fallback = false }
				end
			end
			return { results = results }
		end
		local calcsTab = build.calcsTab
		local calcFunc, calcBase = calcsTab:GetMiscCalculator()
		if type(calcFunc) ~= "function" then error("Path of Building's calculator is not available (no calculation output yet)") end
		local mainOutput = calcsTab.mainOutput
		local base = readStats(mainOutput, keys, false)
		local nullFullDPS = useFullDPS == false
		-- No skill counted towards Full DPS when the calculator was made: it
		-- will not roll Full DPS up, so runFast does (see the header).
		local rollUpHere = not nullFullDPS and calcBase ~= nil and calcBase.FullDPS == nil

		local before = fingerprint()
		local cache = GlobalCache.cachedData.CALCULATOR
		local savedCache = { }
		for k, v in pairs(cache) do savedCache[k] = v end

		local results = { }
		local fatal = nil
		withEnvCapture(function()
			for i, variant in ipairs(variants) do
				local ok, res = pcall(function()
					local checked = checkVariant(variant)
					if checked.fallbackReason then
						return { fallback = true, reason = checked.fallbackReason }
					end
					return runFast(checked, calcFunc, keys, useFullDPS, nullFullDPS, rollUpHere)
				end)
				if ok then
					results[i] = res
				elseif tostring(res):find("call reset_build", 1, true) and not isUserErr(res) then
					fatal = res
					break
				else
					results[i] = variantErrorResult(res)
				end
			end
		end)

		wipeTable(cache)
		for k, v in pairs(savedCache) do cache[k] = v end
		if fatal then error(fatal, 0) end
		local diff = fingerprintDiff(before, fingerprint())
		if diff then
			error("probe left the build different from the committed one (" .. diff .. "); call reset_build", 0)
		end
		return { base = base, results = results }
	end

	-- A fallback variant, applied for real: the caller snapshots the whole
	-- build before and restores it exactly after (BuildSession.probe).
	function M.probeCommit(cmd)
		flushPendingRecalc()
		local keys = statKeyList(cmd.stats)
		if cmd.useFullDPS ~= nil and type(cmd.useFullDPS) ~= "boolean" then userError("useFullDPS must be a boolean") end
		local checked = checkVariant(cmd.variant)
		local beforeIds = { }
		for id in pairs(build.spec.allocNodes) do beforeIds[id] = true end
		if checked.config then applyConfig(checked.config) end
		if #checked.gems > 0 then applyGems(checked.gems) end
		for _, p in ipairs(checked.items) do
			ctx.equipItemInSlot(p.slot.slotName, p.itemText)
		end
		local function ids(list)
			local out = { }
			for i, node in ipairs(list) do out[i] = node.id end
			return out
		end
		if #checked.removeList > 0 then ctx.deallocNodesBatch(ids(checked.removeList)) end
		if #checked.addList > 0 then ctx.allocNodesBatch(ids(checked.addList)) end
		build.buildFlag = true
		local output = ctx.pumpAndRead()
		local added, removed = { }, { }
		for id, node in pairs(build.spec.allocNodes) do
			if not beforeIds[id] then added[node] = true end
		end
		for id in pairs(beforeIds) do
			local node = build.spec.nodes[id]
			if node and not build.spec.allocNodes[id] then removed[node] = true end
		end
		local result = { stats = readStats(output, keys, cmd.useFullDPS == false), fallback = true }
		if next(added) then result.nodesAdded, result.pointsAdded = describeSet(added) end
		if next(removed) then result.nodesRemoved, result.pointsRemoved = describeSet(removed) end
		return result
	end

	return M
end
