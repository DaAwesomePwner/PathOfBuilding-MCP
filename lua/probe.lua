-- Read-only what-if probes through Path of Building's own calculator.
--
-- `probe` evaluates many variants of the loaded build (passive nodes, items,
-- gems, config) with `build.calcsTab:GetMiscCalculator()`, the calculator
-- PoB's UI uses for its tooltip stat deltas, and never runs a full recalc
-- (BuildOutput) or sets `build.buildFlag`. Per variant:
--   1. data changes are applied: config input on copies of the config tables
--      (+ BuildModList; the committed tables are put back unwritten, as PoB
--      2.67 exports them in pairs() order),
--      gem lists (changed gems are copies; the original gem objects are put
--      back), items (each assigned to its slot under a free item id, or the
--      slot emptied for an `unequip` entry), `modLines` (custom-modifier
--      lines read from a copy of the config mod list; see applyModLines);
--      `mainSkill` (build.mainSocketGroup and the group's mainActiveSkill,
--      which the calculator reads, set after every other change);
--   2. calcFunc({ addNodes / removeNodes }, useFullDPS) runs on that data;
--      one mastery change (`masteries`: allocating a mastery with an effect,
--      or a new effect on an allocated one) passes a copy of the mastery
--      node with that effect's stats (masteryEffectNode, as PoB's power
--      builder evaluates mastery effects) in addNodes, with its path, or in
--      place of the allocated node (removeNodes holds the node itself);
--   3. every data change is undone, in reverse order.
-- After the whole command the committed state is compared with a fingerprint
-- taken before it (gem lists, config input, item slots and items, allocated
-- nodes, mainOutput identity, buildFlag); any difference is an internal error
-- naming reset_build.
--
-- Variant kinds the calculator cannot reproduce exactly come back as
-- { fallback = true, reason, treeOnly } and are run by the caller through
-- `probeCommit` (apply for real -> full recalc -> read) between a full
-- snapshot and its exact restore (BuildSession.probe does this; `treeOnly`
-- marks a single node change that touches no skill, for which a passive-tree
-- snapshot and restore are enough). They are:
--   * more than one node change (allocate/deallocate together, several of
--     either, mastery changes counted as node changes): PoB recomputes
--     paths/dependencies after every single change;
--   * a mastery change on a mastery in a timeless jewel's radius;
--   * a node change touching a cluster-jewel socket or expansion node, a
--     jewel socket holding a jewel, a multiple-choice option, or a node that
--     grants a skill (the skill's socket group exists only after a full recalc);
--   * an item in a passive-tree jewel socket (cluster graphs / conquered
--     nodes are rebuilt by the spec), an item granting a skill or replacing
--     one that does, or a change that may empty an off-hand or abyssal
--     socket whose item grants one;
--   * every variant while the party tab's "export buffs" option is on (see
--     checkVariant).
-- A `probe` without variants (and the classify-only pass) reads the base
-- from the last full recalc without building a calculator; `probe` with
-- `candidates` lists the nodes the tree searches evaluate (listCandidates);
-- `probe` with `fingerprint` returns the committed state by value, which the
-- caller compares before and after every fallback variant, so an inexact
-- restore of anything (not only the part a tree-only restore checks) fails.
-- Gem changes on item- or tree-granted socket groups are refused. Gem ops:
-- set, remove, add, and clear (every gem out of a group; followed by adds it
-- rebuilds a group as replaceSocketGroup does).
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

	-- Whether changing `set` can add or remove a skill: a node granting one,
	-- or a jewel socket holding a jewel that grants one.
	local function touchesSkills(spec, set)
		for node in pairs(set) do
			if grantsSkill(node) then return true end
			if holdsJewel(spec, node) then
				local jewel = build.itemsTab.items[spec.jewels[node.id]]
				if jewel == nil or (type(jewel.grantedSkills) == "table" and #jewel.grantedSkills > 0) then return true end
			end
		end
		return false
	end

	local function nodeById(spec, id, label)
		if not isInt(id, 0) then userError(label .. " must be a node id (integer)") end
		local node = spec.nodes[id]
		if not node then userError("Unknown node id: " .. tostring(id)) end
		return node
	end

	-- Validate a variant's node lists against the committed tree (user errors
	-- before any change). Returns the nodes to allocate, the nodes to
	-- deallocate and the mastery choices (ctx.nodeBatch.resolveMasteries:
	-- { node, id, effect } each).
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
			if node.type == "Mastery" then userError(ctx.nodeBatch.masteryInNodes(node)) end
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
		local skip = { }
		for node in pairs(seen) do skip[node.id] = true end
		local masteries = ctx.nodeBatch.resolveMasteries(variant.masteries, { skip = skip })
		return addList, removeList, masteries
	end

	-- A copy of mastery `node` with effect `effectId` chosen, as
	-- PassiveSpec:BuildAllDependsAndPaths makes an allocated mastery (sd =
	-- the effect's lines, tree:ProcessStats) and as CalcsTab's power builder
	-- evaluates a mastery effect: the calculator reads the copy in place of
	-- the node (same id), so the committed node is never changed.
	local function masteryEffectNode(node, effectId)
		local copy = { }
		for k, v in pairs(node) do copy[k] = v end
		local effect = build.spec.tree.masteryEffects[effectId]
		local sd = { }
		for i, line in ipairs(effect and effect.sd or { }) do sd[i] = line end
		copy.sd = sd
		copy.allMasteryOptions = false
		copy.unknown, copy.extra = nil, nil
		copy.grantedSkills = { } -- calcs.buildModListForNode wipes this table
		build.spec.tree:ProcessStats(copy)
		return copy
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

	-- The slots a change of `slot` can empty as a side effect (applyItems'
	-- populate step, ItemsTab:PopulateSlots): its abyssal sockets, and for a
	-- main hand the off-hand and the off-hand's abyssal sockets.
	local function dependentSlots(tab, slot)
		local out = { }
		local function addWithSockets(s)
			if not s then return end
			if s ~= slot then out[#out + 1] = s end
			for _, socket in ipairs(s.abyssalSocketList or { }) do out[#out + 1] = socket end
		end
		addWithSockets(slot)
		if slot.slotName == "Weapon 1" then addWithSockets(tab.slots["Weapon 2"]) end
		if slot.slotName == "Weapon 1 Swap" then addWithSockets(tab.slots["Weapon 2 Swap"]) end
		return out
	end

	-- Parse every item and check what can be checked against the committed
	-- build (user errors before any change); an item whose fit depends on
	-- another item of the same variant is checked again when it is applied.
	-- An entry { slot, unequip = true } empties the slot instead.
	-- Returns { { slot, item, itemText, unequip } ... } and a fallback reason or nil.
	function M.checkItems(variant)
		local list = optArray(variant.items, "items", M.MAX_ITEMS)
		local tab = build.itemsTab
		local parsed, bySlot, reason = { }, { }, nil
		for i, entry in ipairs(list) do
			local unequip = type(entry) == "table" and entry.unequip == true and entry.itemText == nil
			if type(entry) ~= "table" or type(entry.slot) ~= "string" or not (unequip or type(entry.itemText) == "string") then
				userError("items[" .. i .. "] must be { slot, itemText } or { slot, unequip = true }")
			end
			-- Unknown slots and (for an item) slots PoB hides on this tree are
			-- refused as swap_item refuses them.
			local slot = ctx.usableSlot(entry.slot, not unequip)
			if bySlot[entry.slot] then userError("Slot " .. entry.slot .. " is listed twice") end
			local item = nil
			if not unequip then item = ctx.parseItemText(entry.itemText, entry.slot) end
			bySlot[entry.slot] = true
			parsed[i] = { slot = slot, item = item, itemText = entry.itemText, unequip = unequip }
			local current = tab.items[slot.selItemId or 0]
			if slot.nodeId then
				reason = reason or (entry.slot .. " is a passive tree jewel socket")
			elseif hasGrantedSkills(item) or hasGrantedSkills(current) then
				reason = reason or ("the item for " .. entry.slot .. " or the item it replaces grants a skill")
			else
				-- The change may empty an off-hand or abyssal socket whose item
				-- grants a skill (its socket group exists only after a full recalc).
				for _, dep in ipairs(dependentSlots(tab, slot)) do
					if hasGrantedSkills(tab.items[dep.selItemId or 0]) then
						reason = reason or ("the change to " .. entry.slot .. " may empty " .. dep.slotName .. ", whose item grants a skill")
						break
					end
				end
			end
		end
		for _, p in ipairs(parsed) do
			local governing = governingSlotName(p.slot)
			if not p.unequip and not (governing and bySlot[governing]) then
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
	-- does for a non-socket slot; an `unequip` entry selects nothing, as
	-- unequip_item does); then what ItemsTab:PopulateSlots would do is
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
				if p.unequip then
					select(p.slot, 0) -- as unequip_item (ItemSlot:SetSelItemId(0)) does
				else
					ctx.assertItemFitsSlot(tab, p.slot, p.item)
					local id = freeItemId(tab)
					p.item.id = id
					tab.items[id] = p.item
					added[#added + 1] = id
					p.item:BuildModList() -- as ItemsTab:AddItem does
					select(p.slot, id)
				end
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

	local GEM_OPS = { set = true, remove = true, add = true, clear = true }

	local function checkGemChange(ch, i)
		local label = "gems[" .. i .. "]"
		if type(ch) ~= "table" or not GEM_OPS[ch.op] then
			userError(label .. ": op must be one of set, remove, add, clear")
		end
		if not isInt(ch.group, 1) then userError(label .. ": group must be a 1-based integer") end
		if ch.op ~= "add" and ch.op ~= "clear" and not isInt(ch.index, 1) then userError(label .. ": index must be a 1-based integer") end
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
				if ch.op == "clear" then
					-- Every gem out of the group (then `add` builds a new list, as replaceSocketGroup does).
					for j = #list, 1, -1 do list[j] = nil end
				elseif ch.op == "add" then
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
	-- Main skill
	-- ------------------------------------------------------------------

	-- `mainSkill = { group, activeSkill? }`: the variant's stats are those
	-- with that socket group as the main skill group (and, with activeSkill,
	-- that active skill of it as the group's main one), as set_main_skill
	-- makes it. The group is checked against the groups as they are now
	-- (gem changes never add or remove groups); its active skill count when
	-- it applies, after the variant's gem changes.
	function M.checkMainSkill(variant)
		local ms = variant.mainSkill
		if ms == nil then return nil end
		if type(ms) ~= "table" or (next(ms) ~= nil and isArray(ms)) then userError("mainSkill must be { group, activeSkill? }") end
		if not isInt(ms.group, 1) then userError("mainSkill.group must be a 1-based integer") end
		if ms.activeSkill ~= nil and not isInt(ms.activeSkill, 1) then userError("mainSkill.activeSkill must be a 1-based integer") end
		ctx.buildEdit.groupAt(ms.group)
		return { group = ms.group, activeSkill = ms.activeSkill }
	end

	-- The group, once its active skills are checked as set_main_skill checks them.
	function M.mainSkillGroup(ms)
		local group = ctx.buildEdit.groupAt(ms.group)
		local count = ctx.buildEdit.activeSkillCount(group)
		if count == 0 then
			userError("mainSkill: skill group " .. ms.group .. " has no enabled active skill gem to use as the main skill")
		end
		if ms.activeSkill ~= nil and ms.activeSkill > count then
			userError("mainSkill: activeSkill " .. ms.activeSkill .. " is out of range: skill group " .. ms.group .. " has " .. count .. " active skill(s)")
		end
		return group
	end

	-- Set the main skill (build.mainSocketGroup, the group's mainActiveSkill)
	-- for the calculator, which reads both; returns the undo.
	local function applyMainSkill(ms)
		local group = M.mainSkillGroup(ms)
		local main, active = build.mainSocketGroup, group.mainActiveSkill
		build.mainSocketGroup = ms.group
		if ms.activeSkill ~= nil then group.mainActiveSkill = ms.activeSkill end
		return function()
			build.mainSocketGroup = main
			group.mainActiveSkill = active
		end
	end

	-- Set it for real, as the bridge's setMainSkill does (a full recalc follows).
	local function commitMainSkill(ms)
		local group = M.mainSkillGroup(ms)
		build.mainSocketGroup = ms.group
		if ms.activeSkill ~= nil then group.mainActiveSkill = ms.activeSkill end
		build.buildFlag = true
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
	-- (without the recalc), on copies of the config tables: the committed
	-- tables are never written, so their pairs() order (which PoB 2.67's
	-- export follows) stays (ctx.detachConfigTables). Returns the undo
	-- function, which puts the very same tables back, and the originals.
	local function applyConfig(options)
		local flag = build.buildFlag
		local orig = ctx.detachConfigTables(options)
		local function undo()
			local ok, err = pcall(ctx.restoreConfigTables, orig)
			build.buildFlag = flag
			if not ok then error(err, 0) end
		end
		local ok, err = pcall(function() build.configTab:BuildModList() end)
		build.buildFlag = flag
		if not ok then
			undo()
			error(err, 0)
		end
		return undo, orig
	end

	-- ------------------------------------------------------------------
	-- Mod lines (stat_weights)
	-- ------------------------------------------------------------------

	-- `modLines`: item-style mod lines added to the config mod list as PoB's
	-- Custom modifiers box adds them (ConfigTab:BuildModList: escapes
	-- stripped, trimmed, modLib.parseMod; a line with unparsed text left over
	-- is skipped there, so it is refused here). The committed config mod list
	-- is never written: the calculator reads a copy with the lines' mods
	-- appended, after every mod BuildModList adds (the order a line appended
	-- to the custom modifier text would have), and the original list object
	-- is put back afterwards. Only for calculator variants: the full-recalc
	-- fallback and apply_changes have no way to apply them.
	M.MAX_MOD_LINES = 20
	M.MAX_PARSE_LINES = 500
	M.MAX_MOD_LINE_LENGTH = 300

	-- The mods of one line, or nil and why PoB cannot use it.
	local function parseModLine(line)
		local stripped = StripEscapes(line):match("^%s*(.-)%s*$")
		if stripped == "" then return nil, "empty line" end
		local mods, extra = modLib.parseMod(stripped)
		if not mods then return nil, "not recognised by Path of Building's mod parser" end
		if extra then return nil, "only partly recognised by Path of Building's mod parser (left over: \"" .. tostring(extra) .. "\")" end
		local n = 0
		for _, mod in pairs(mods) do
			n = n + 1
			if type(mod) == "table" and mod.name == "ExtraSkill" then return nil, "grants a skill (not supported)" end
		end
		if n == 0 then return nil, "parsed to no modifier" end
		return mods
	end

	local function checkModLineText(line, label)
		if type(line) ~= "string" or line:find("[\r\n]") or #line > M.MAX_MOD_LINE_LENGTH then
			userError(label .. " must be one line of text of at most " .. M.MAX_MOD_LINE_LENGTH .. " characters")
		end
	end

	-- A variant's modLines as one list of mods (copies, so the source can be set).
	local function checkModLines(variant)
		local lines = optArray(variant.modLines, "modLines", M.MAX_MOD_LINES)
		local out = { }
		for i, line in ipairs(lines) do
			checkModLineText(line, "modLines[" .. i .. "]")
			local mods, why = parseModLine(line)
			if not mods then userError("mod line \"" .. line .. "\" cannot be used: " .. why) end
			for _, mod in ipairs(mods) do out[#out + 1] = mod end
		end
		return out
	end

	local function applyModLines(mods)
		local configTab = build.configTab
		local orig = configTab.modList
		local copy = ctx.construct("ModList")
		copy:AddList(orig)
		for _, mod in ipairs(mods) do copy:AddMod(modLib.setSource(mod, "Custom")) end
		configTab.modList = copy
		return function() configTab.modList = orig end
	end

	-- `probe` with `parseModLines`: whether PoB can use each line (nothing is
	-- computed or changed).
	function M.parseModLines(lines)
		if not isArray(lines) then userError("parseModLines must be an array of mod lines") end
		if #lines > M.MAX_PARSE_LINES then
			userError("parseModLines has " .. #lines .. " entries; at most " .. M.MAX_PARSE_LINES .. " are allowed")
		end
		local out = { }
		for i, line in ipairs(lines) do
			checkModLineText(line, "parseModLines[" .. i .. "]")
			local mods, why = parseModLine(line)
			if mods then
				local n = 0
				for _ in pairs(mods) do n = n + 1 end
				out[i] = { ok = true, mods = n }
			else
				out[i] = { ok = false, reason = why }
			end
		end
		return { lines = out }
	end

	-- ------------------------------------------------------------------
	-- Committed-state fingerprint
	-- ------------------------------------------------------------------

	local GEM_FIELDS = { "nameSpec", "gemId", "skillId", "level", "quality", "enabled", "count", "gemData", "grantedEffect" }
	local GROUP_FIELDS = { "label", "slot", "source", "enabled", "includeInFullDPS", "mainActiveSkill", "mainActiveSkillCalcs" }

	-- A short hash of a string (FNV-1a, 32 bit), so item texts can be compared
	-- cheaply. The FNV prime is 2^24 + 403: h * prime is computed as
	-- (h << 24) + h * 403, which stays far below 2^53, so every step is exact
	-- before bit.tobit takes it back to 32 bits.
	local function hashText(text)
		local h = bit.tobit(2166136261)
		for i = 1, #text do
			h = bit.bxor(h, text:byte(i))
			h = bit.tobit(bit.lshift(h, 24) + h * 403)
		end
		return bit.tohex(h)
	end

	-- The committed state as a list of lines. By default table identities are
	-- part of it (the probe's own data changes must put back the very same
	-- gem, group and item objects and leave the last recalc's output alone).
	-- With `byValue` only values count (a full snapshot/restore rebuilds
	-- socket groups and gems as new tables and a full recalc replaces the
	-- output): gem and group fields, item ids with a hash of their text, slot
	-- selections, allocated nodes, socketed tree jewels, config input.
	-- Both include mastery effect choices and every skill set (the active
	-- one's groups and gems in full, the others by value).
	local function fingerprint(byValue)
		local fp = { }
		local function add(...)
			local parts = { ... }
			for i = 1, select("#", ...) do parts[i] = tostring(parts[i]) end
			fp[#fp + 1] = table.concat(parts, "|")
		end
		local function id(object)
			return byValue and "" or object
		end
		if byValue then
			add("mainSocketGroup", build.mainSocketGroup)
		else
			add("mainOutput", build.calcsTab.mainOutput, "buildFlag", build.buildFlag, "mainSocketGroup", build.mainSocketGroup)
		end
		local ids = { }
		for nodeId in pairs(build.spec.allocNodes) do ids[#ids + 1] = nodeId end
		table.sort(ids)
		add("nodes", table.concat(ids, ","))
		local masteries = { }
		for nodeId, effectId in pairs(build.spec.masterySelections or { }) do masteries[#masteries + 1] = nodeId .. "=" .. tostring(effectId) end
		table.sort(masteries)
		add("masteries", table.concat(masteries, ","))
		if byValue then
			local jewels = { }
			for nodeId, itemId in pairs(build.spec.jewels) do jewels[#jewels + 1] = nodeId .. "=" .. tostring(itemId) end
			table.sort(jewels)
			add("jewels", table.concat(jewels, ","))
		end
		local tab = build.itemsTab
		for _, slot in ipairs(tab.orderedSlots) do
			local entry = tab.activeItemSet[slot.slotName]
			add("slot", slot.slotName, slot.selItemId, entry and entry.selItemId)
		end
		local itemIds = { }
		for itemId, item in pairs(tab.items) do
			local text = byValue and hashText(tostring(item.raw)) or tostring(item)
			itemIds[#itemIds + 1] = itemId .. "=" .. text
		end
		table.sort(itemIds)
		add("items", table.concat(itemIds, ","), table.concat(tab.itemOrderList, ","))
		for gi, group in ipairs(build.skillsTab.socketGroupList) do
			if byValue then
				local vals = { }
				for k, f in ipairs(GROUP_FIELDS) do vals[k] = tostring(group[f]) end
				add("group", gi, table.concat(vals, ","), #group.gemList)
			else
				add("group", gi, group, group.enabled, group.mainActiveSkill, #group.gemList)
			end
			for gj, gem in ipairs(group.gemList) do
				local vals = { }
				for k, f in ipairs(GEM_FIELDS) do vals[k] = tostring(gem[f]) end
				add("gem", gi, gj, id(gem), table.concat(vals, ","))
			end
		end
		local skillsTab = build.skillsTab
		add("skillSets", skillsTab.activeSkillSetId, table.concat(skillsTab.skillSetOrderList or { }, ","))
		for _, setId in ipairs(skillsTab.skillSetOrderList or { }) do
			local set = skillsTab.skillSets[setId]
			add("skillSet", setId, set and set.title, set and #set.socketGroupList)
			if set and set.socketGroupList ~= skillsTab.socketGroupList then
				for gi, group in ipairs(set.socketGroupList) do
					local vals = { }
					for k, f in ipairs(GROUP_FIELDS) do vals[k] = tostring(group[f]) end
					add("setGroup", setId, gi, table.concat(vals, ","), #group.gemList)
					for gj, gem in ipairs(group.gemList) do
						local gvals = { }
						for k, f in ipairs(GEM_FIELDS) do gvals[k] = tostring(gem[f]) end
						add("setGem", setId, gi, gj, table.concat(gvals, ","))
					end
				end
			end
		end
		local keys = { }
		for k, v in pairs(build.configTab.input) do keys[#keys + 1] = tostring(k) .. "=" .. type(v) .. ":" .. tostring(v) end
		table.sort(keys)
		add("config", table.concat(keys, ","), build.configTab.enemyLevel)
		-- The config tables in pairs() order, which PoB 2.67's export follows
		-- (see applyConfig); without byValue, the very same table objects.
		local configTab = build.configTab
		local function inOrder(t)
			local out = { }
			for k, v in pairs(t or { }) do out[#out + 1] = tostring(k) .. "=" .. tostring(v) end
			return table.concat(out, ",")
		end
		add("configInputOrder", inOrder(configTab.input))
		add("configPlaceholderOrder", inOrder(configTab.placeholder))
		if not byValue then
			local set = configTab.configSets and configTab.activeConfigSetId and configTab.configSets[configTab.activeConfigSetId]
			add("configTables", configTab.input, configTab.placeholder, set and set.input, set and set.placeholder)
		end
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
		local addList, removeList, masteries = M.checkNodes(variant)
		local parsedItems, reason = M.checkItems(variant)
		local config = checkConfig(variant)
		local gems = optArray(variant.gems, "gems", M.MAX_GEM_CHANGES)
		for i, ch in ipairs(gems) do checkGemChange(ch, i) end
		local mainSkill = M.checkMainSkill(variant)
		-- Mastery choices that change something: allocating a mastery, or a
		-- new effect on an allocated one (its current effect again is a no-op).
		local masteryChanges = { }
		for _, m in ipairs(masteries) do
			if not m.node.alloc or build.spec.masterySelections[m.id] ~= m.effect then masteryChanges[#masteryChanges + 1] = m end
		end
		local nodeSet, adding, swap = nil, false, nil
		if #addList + #removeList + #masteryChanges > 1 then
			reason = reason or "more than one node change (paths are recomputed after each)"
		elseif #addList == 1 then
			nodeSet, adding = allocSet(addList[1]), true
		elseif #removeList == 1 then
			nodeSet = deallocSet(removeList[1])
		elseif #masteryChanges == 1 then
			local m = masteryChanges[1]
			local effectNode = masteryEffectNode(m.node, m.effect)
			if m.node.alloc then
				-- A new effect on an allocated mastery: the calculator reads the
				-- copy with that effect in place of the node.
				swap = { add = effectNode, remove = m.node }
				if m.node.conqueredBy then reason = reason or ("mastery " .. nodeLabel(m.node) .. " is in a timeless jewel's radius") end
				if grantsSkill(effectNode) then reason = reason or ("mastery effect " .. m.effect .. " grants a skill") end
			else
				nodeSet, adding = allocSet(m.node), true
				if nodeSet[m.node] then
					nodeSet[m.node] = nil
					nodeSet[effectNode] = true
				end
				if m.node.conqueredBy then reason = reason or ("mastery " .. nodeLabel(m.node) .. " is in a timeless jewel's radius") end
			end
		end
		if nodeSet and not reason then
			reason = nodeFallbackReason(build.spec, nodeSet, adding)
		end
		-- A fallback that only changes the passive tree and no skill: the
		-- caller may snapshot and restore just the passive tree around it.
		local touched = nodeSet or (swap and { [swap.add] = true, [swap.remove] = true })
		local treeOnly = reason ~= nil and touched ~= nil and #parsedItems == 0 and config == nil
			and #gems == 0 and mainSkill == nil and not touchesSkills(build.spec, touched)
		-- With the party tab's "export buffs" option on, CalcPerform computes
		-- the MAIN pass differently from the CALCULATOR pass (only MAIN collects
		-- buff exports, and that branch can apply non-unique flasks to a minion
		-- through a link skill), so the calculator is not trusted then. PoB
		-- neither saves nor loads the option in build XML and the bridge never
		-- sets it, so this cannot happen through the MCP tools today.
		if build.partyTab and build.partyTab.enableExportBuffs then
			reason = reason or "the party tab's export-buffs option is on"
		end
		local modLines = checkModLines(variant)
		if #modLines > 0 and reason then
			userError("modLines cannot be combined with a change that needs a full recalculation (" .. reason .. ")")
		end
		return {
			addList = addList, removeList = removeList, items = parsedItems, config = config, gems = gems,
			nodeSet = nodeSet, adding = adding, fallbackReason = reason, treeOnly = treeOnly, modLines = modLines,
			masteries = masteries, swap = swap, mainSkill = mainSkill,
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
			if #checked.modLines > 0 then undos[#undos + 1] = applyModLines(checked.modLines) end
			if #checked.gems > 0 then undos[#undos + 1] = applyGems(checked.gems) end
			if #checked.items > 0 then undos[#undos + 1] = applyItems(checked.items) end
			if checked.mainSkill then undos[#undos + 1] = applyMainSkill(checked.mainSkill) end
			local override = { }
			local result = { }
			if checked.swap then
				override.addNodes = { [checked.swap.add] = true }
				override.removeNodes = { [checked.swap.remove] = true }
			elseif checked.nodeSet then
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

	-- The committed build's stats, read from the last full recalc.
	local function committedStats(keys)
		local mainOutput = build.calcsTab.mainOutput
		if type(mainOutput) ~= "table" then error("Path of Building's calculator is not available (no calculation output yet)") end
		return readStats(mainOutput, keys, false)
	end

	function M.probe(cmd)
		flushPendingRecalc()
		if cmd.candidates ~= nil then return M.listCandidates(cmd) end
		-- `fingerprint`: the committed state by value (see fingerprint), which
		-- the caller compares before and after a fallback variant's restore.
		if cmd.fingerprint then return { fingerprint = fingerprint(true) } end
		if cmd.supportsFor ~= nil then return M.listSupports(cmd.supportsFor) end
		if cmd.parseModLines ~= nil then return M.parseModLines(cmd.parseModLines) end
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
					results[i] = { fallback = true, reason = res.fallbackReason, treeOnly = res.treeOnly or nil }
				else
					results[i] = { fallback = false }
				end
			end
			-- The base too, so a call whose variants all need the fallback
			-- never builds a calculator just to read it.
			return { base = committedStats(keys), results = results }
		end
		if #variants == 0 then
			-- Base only: no calculator is built.
			return { base = committedStats(keys), results = { } }
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
						return { fallback = true, reason = checked.fallbackReason, treeOnly = checked.treeOnly or nil }
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

	-- ------------------------------------------------------------------
	-- Node search candidates
	-- ------------------------------------------------------------------

	-- `probe` with `candidates`: the nodes a tree search evaluates and what a
	-- one-node variant of each would change (nothing is computed):
	--   "allocate": every unallocated node that is not an ascendancy node, a
	--     class start or a mastery, that a path reaches, whose `allocate`
	--     variant costs at most `maxPoints` points; `nodes` is that path, from
	--     the allocated tree out to the node;
	--   "deallocate": every allocated node except ascendancy nodes, class
	--     starts, masteries and jewel sockets holding a jewel; `nodes` is the
	--     node, then the nodes that depend on it (what `deallocate` removes).
	-- `points` is what the variant's pointsAdded / pointsRemoved will be and
	-- `fallback` the reason it needs a full recalculation, if it does.
	-- `names` maps every listed node id to its name.
	function M.listCandidates(cmd)
		local spec = build.spec
		local adding = cmd.candidates == "allocate"
		if not adding and cmd.candidates ~= "deallocate" then userError("candidates must be \"allocate\" or \"deallocate\"") end
		local maxPoints = cmd.maxPoints
		if adding and not isInt(maxPoints, 1) then userError("maxPoints must be a positive integer") end
		local out, named, names = { }, { }, { }
		local function name(node)
			if not named[node.id] then
				named[node.id] = true
				names[#names + 1] = { id = node.id, name = node.dn or "" }
			end
			return node.id
		end
		for _, node in pairs(spec.nodes) do
			local eligible = not node.ascendancyName and node.type ~= "ClassStart"
				and node.type ~= "AscendClassStart" and node.type ~= "Mastery"
			local set = nil
			if eligible and adding then
				if not node.alloc and node.path and #node.path > 0 then set = allocSet(node) end
			elseif eligible and node.alloc and not holdsJewel(spec, node) then
				set = deallocSet(node)
			end
			local points = 0
			if set then
				for n in pairs(set) do
					if countsAsPoint(n) then points = points + 1 end
				end
			end
			if set and (not adding or points <= maxPoints) then
				local ids = { }
				if adding and not set[node.path[#node.path]] then
					ids[1] = name(node) -- allocated through an Intuitive Leap-like jewel: the node alone
				elseif adding then
					for i = #node.path, 1, -1 do ids[#ids + 1] = name(node.path[i]) end
				else
					ids[1] = name(node)
					local deps = { }
					for dep in pairs(set) do
						if dep ~= node then deps[#deps + 1] = dep end
					end
					table.sort(deps, function(a, b) return a.id < b.id end)
					for _, dep in ipairs(deps) do ids[#ids + 1] = name(dep) end
				end
				local sd = { }
				for _, line in ipairs(node.sd or { }) do
					if type(line) == "string" then sd[#sd + 1] = line end
				end
				out[#out + 1] = {
					id = node.id, name = node.dn or "", type = node.type, stats = sd, nodes = ids, points = points,
					fallback = nodeFallbackReason(spec, set, adding),
				}
			end
		end
		table.sort(out, function(a, b) return a.id < b.id end)
		return { nodes = out, names = names }
	end

	-- ------------------------------------------------------------------
	-- Supports for an active skill
	-- ------------------------------------------------------------------

	-- `probe` with `supportsFor = { active, locked }`: every support gem that
	-- PoB's own check (calcLib.canGrantedEffectSupportActiveSkill, what its
	-- gem selector and calcs.createActiveSkill use) lets support the active
	-- skill once the locked supports have added their skill types (applied
	-- until none adds more, as calcs.createActiveSkill does), with the
	-- player actor of the last full recalc. Returns each support's name,
	-- natural maximum level and whether it is an Awakened gem; a check that
	-- throws is listed in `errors` instead.
	function M.listSupports(spec)
		if type(spec) ~= "table" or type(spec.active) ~= "string" then
			userError("supportsFor must be { active = <gem name>, locked = [<gem names>] }")
		end
		local locked = optArray(spec.locked, "supportsFor.locked", M.MAX_GEM_CHANGES)
		local activeData = lookupGem(spec.active, "supportsFor.active")
		local activeEffect = activeData.grantedEffect
		if not activeEffect or activeEffect.support then userError("'" .. activeData.name .. "' is not an active skill gem") end
		local env = build.calcsTab.mainEnv
		local actor = env and env.player
		if not actor then error("Path of Building's calculator is not available (no calculation output yet)") end
		local activeSkill = {
			activeEffect = { grantedEffect = activeEffect, gemData = activeData, level = 20, quality = 20 },
			actor = actor,
			skillTypes = copyTable(activeEffect.skillTypes or { }),
			minionSkillTypes = activeEffect.minionSkillTypes and copyTable(activeEffect.minionSkillTypes) or nil,
			skillData = { },
		}
		local pending = { }
		for i, name in ipairs(locked) do
			if type(name) ~= "string" then userError("supportsFor.locked[" .. i .. "] must be a gem name") end
			pending[#pending + 1] = lookupGem(name, "supportsFor.locked[" .. i .. "]").grantedEffect
		end
		repeat
			local added = false
			for i = #pending, 1, -1 do
				local support = pending[i]
				if support and support.support and calcLib.canGrantedEffectSupportActiveSkill(support, activeSkill) then
					for _, skillType in pairs(support.addSkillTypes or { }) do activeSkill.skillTypes[skillType] = true end
					table.remove(pending, i)
					added = true
				end
			end
		until not added
		local out, errors, seen = { }, { }, { }
		for _, gemData in pairs(data.gems) do
			local support = gemData.grantedEffect
			if support and support.support and gemData.name and not seen[gemData.name] then
				local ok, res = pcall(calcLib.canGrantedEffectSupportActiveSkill, support, activeSkill)
				if not ok then
					seen[gemData.name] = true
					errors[#errors + 1] = { name = gemData.name, error = tostring(res) }
				elseif res then
					seen[gemData.name] = true
					out[#out + 1] = {
						name = gemData.name,
						naturalMaxLevel = gemData.naturalMaxLevel,
						isAwakened = gemData.name:find("^Awakened ") ~= nil,
					}
				end
			end
		end
		table.sort(out, function(a, b) return a.name < b.name end)
		table.sort(errors, function(a, b) return a.name < b.name end)
		return { active = activeData.name, supports = out, errors = errors }
	end

	-- Items of a checked variant equipped (or slots emptied) for real, as
	-- the bridge's equipItem / unequipItem commands do.
	local function commitItems(parsed)
		for _, p in ipairs(parsed) do
			if p.unequip then
				-- As the bridge's unequipItem command does.
				p.slot:SetSelItemId(0)
				build.buildFlag = true
				build.itemsTab:PopulateSlots()
				runCallback("OnFrame")
			else
				ctx.equipItemInSlot(p.slot.slotName, p.itemText)
			end
		end
	end

	-- A fallback variant, applied for real: the caller snapshots the whole
	-- build before and restores it exactly after (BuildSession.probe).
	function M.probeCommit(cmd)
		flushPendingRecalc()
		local keys = statKeyList(cmd.stats)
		if cmd.useFullDPS ~= nil and type(cmd.useFullDPS) ~= "boolean" then userError("useFullDPS must be a boolean") end
		local checked = checkVariant(cmd.variant)
		if #checked.modLines > 0 then userError("modLines are only evaluated through the calculator") end
		local beforeIds = { }
		for id in pairs(build.spec.allocNodes) do beforeIds[id] = true end
		if checked.config then
			-- The restore that follows puts the committed tables back.
			local _, orig = applyConfig(checked.config)
			ctx.stashCommittedConfigTables(cmd.configToken, orig, build.configTab.input)
		end
		if #checked.gems > 0 then applyGems(checked.gems) end
		commitItems(checked.items)
		local function ids(list)
			local out = { }
			for i, node in ipairs(list) do out[i] = node.id end
			return out
		end
		if #checked.removeList > 0 then ctx.deallocNodesBatch(ids(checked.removeList)) end
		if #checked.addList > 0 or #checked.masteries > 0 then
			ctx.allocNodesBatch(ids(checked.addList), false, checked.masteries)
		end
		if checked.mainSkill then commitMainSkill(checked.mainSkill) end
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

	-- apply_changes: one variant applied for real and kept (BuildSession
	-- takes a full snapshot first, for undo and to roll back a change that
	-- fails part-way). Everything that can be checked against the committed
	-- build is checked before anything changes: the variant as `probe` checks
	-- it, and the gem changes by applying them to copies and undoing them.
	-- Then, in the probe's order: config (as set_config sets it), gems (as
	-- `probe` changes them; the copies stay), items (as equip_item /
	-- unequip_item), deallocations, allocations (as the node batches),
	-- recorded in ctx.buildEdit (see bridge.lua) once started and once
	-- applied. Returns the nodes added (the allocation's nodes in the order
	-- they joined the tree first) and removed, as nodeBatch.describe tables,
	-- plus what a crash replay needs: `allocOrder` (the ids the allocation
	-- added, in join order) and `gemNames` (each gem change's gem as PoB
	-- names it, or null).
	-- With `replay` (a crash replay of a committed apply_changes) the node
	-- lists are applied as recorded: `deallocate` as requested, `allocate` in
	-- join order, so every node is next to the tree when it is allocated and
	-- the replay never depends on which of several equally short paths PoB
	-- would pick.
	function M.applyChanges(cmd)
		flushPendingRecalc()
		local edit, nodeBatch = ctx.buildEdit, ctx.nodeBatch
		local variant = cmd.variant
		if type(variant) ~= "table" or (next(variant) ~= nil and isArray(variant)) then userError("variant must be an object") end
		if variant.modLines ~= nil then userError("modLines are only available to read-only probes (stat_weights)") end
		local items, config, gems, allocIds, deallocIds, masteries, mainSkill
		if cmd.replay == true then
			items = M.checkItems(variant)
			config = checkConfig(variant)
			gems = variant.gems or { }
			allocIds, deallocIds = variant.allocate or { }, variant.deallocate or { }
			masteries = ctx.nodeBatch.resolveMasteries(variant.masteries, { replay = true })
			mainSkill = M.checkMainSkill(variant)
		else
			local checked = checkVariant(variant)
			items, config, gems, masteries, mainSkill = checked.items, checked.config, checked.gems, checked.masteries, checked.mainSkill
			allocIds, deallocIds = { }, { }
			for i, node in ipairs(checked.addList) do allocIds[i] = node.id end
			for i, node in ipairs(checked.removeList) do deallocIds[i] = node.id end
		end
		local gemNames = { }
		if #gems > 0 or mainSkill then
			-- Gem changes are tried on copies and undone; the main skill's
			-- active skills are counted with them applied.
			local ok, err = pcall(function()
				local undo = #gems > 0 and applyGems(gems) or function() end
				local cok, cerr = pcall(function()
					if mainSkill then M.mainSkillGroup(mainSkill) end
				end)
				undo()
				if not cok then error(cerr, 0) end
			end)
			if not ok then
				-- applyGems undoes its own failed changes; anything but a refusal
				-- may have left the gem lists different: roll back.
				if not isUserErr(err) then edit.started() end
				error(err, 0)
			end
			for i, ch in ipairs(gems) do
				gemNames[i] = ch.name ~= nil and lookupGem(ch.name, "gems[" .. i .. "]").name or jsonNull
			end
		end

		local before = nodeBatch.captureAllocated()
		edit.started()
		if config then
			-- Options that already hold their value change nothing: no copies.
			local input, changes = build.configTab.input, false
			for key, value in pairs(config) do
				if not ctx.sameConfigValue(input[key], value) then
					changes = true
					break
				end
			end
			if not changes then config = nil end
		end
		if config then
			-- As set_config sets the options, but on copies of the config
			-- tables (as probeCommit does), which stay live once the change is
			-- committed; the committed tables are remembered unwritten under
			-- the caller's `configToken` (stashCommittedConfigTables), so the
			-- rollback or the undo of this change, sent with that token
			-- (ConfigTables.restoreInput), puts them back with their pairs()
			-- order. Writing keys into them and deleting them again may not
			-- keep it (the string hash seed differs per process).
			local orig = ctx.detachConfigTables(config)
			ctx.stashCommittedConfigTables(cmd.configToken, orig, build.configTab.input)
			build.configTab:BuildModList()
			build.buildFlag = true
		end
		if #gems > 0 then
			applyGems(gems)
			build.buildFlag = true
		end
		edit.testFaultMidway(cmd.replay == true)
		commitItems(items)
		if #deallocIds > 0 then ctx.deallocNodesBatch(deallocIds) end
		local allocOrder, masteryReport = { }, nil
		if #allocIds > 0 or #masteries > 0 then
			local res = ctx.allocNodesBatch(allocIds, false, masteries)
			for i, node in ipairs(res.added) do allocOrder[i] = node.id end
			masteryReport = res.masteries
		end
		if mainSkill then commitMainSkill(mainSkill) end
		build.buildFlag = true

		local added, listed = { }, { }
		for _, id in ipairs(allocOrder) do
			local node = build.spec.allocNodes[id]
			if node and not before[id] then
				added[#added + 1] = nodeBatch.describe(node)
				listed[id] = true
			end
		end
		local extra = { }
		for id in pairs(build.spec.allocNodes) do
			if not before[id] and not listed[id] then extra[#extra + 1] = id end
		end
		table.sort(extra)
		for _, id in ipairs(extra) do added[#added + 1] = nodeBatch.describe(build.spec.allocNodes[id]) end
		local result = { added = added, removed = nodeBatch.lostSince(before), allocOrder = allocOrder, gemNames = gemNames,
			masteries = masteryReport, mainSkill = mainSkill }
		edit.applied(result, cmd.replay == true)
		runCallback("OnFrame")
		return result
	end

	return M
end
