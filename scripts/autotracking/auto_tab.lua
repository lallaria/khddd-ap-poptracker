-- follows the player's position pushed to data storage by the game client (set_data_storage in
-- worlds/khddd/Client.py); the opt_auto_tab toggle lets the user turn it off
AUTO_TAB_KEY = nil

local CHARACTER_TABS = {
	[0] = "Sora",
	[1] = "Riku",
}

-- world byte (WorldFlags.*.worldNo in DDDAPConnector.lua) -> tab title per character;
-- 0x01 Destiny Islands and 0x0B World Map have no map tab
local WORLD_TABS = {
	[0x03] = { [0] = "Traverse Town", [1] = "Traverse Town" },
	[0x04] = { [0] = "Country of the Musketeers", [1] = "Country of the Musketeers" },
	[0x05] = { [0] = "Symphony of Sorcery", [1] = "Symphony of Sorcery" },
	[0x06] = { [0] = "Prankster's Paradise", [1] = "Prankster's Paradise (Monstro)" },
	[0x08] = { [0] = "La Cité des Cloches", [1] = "La Cité des Cloches" },
	[0x09] = { [0] = "The Grid", [1] = "The Grid" },
	[0x0A] = { [0] = "TWTNW (Dark City)", [1] = "TWTNW (Castle)" },
}

local last_world = nil
local last_character = nil

local function onAutoTabClear()
	last_world = nil
	last_character = nil
	AUTO_TAB_KEY = nil
	local team = Archipelago.TeamNumber
	local slot = Archipelago.PlayerNumber
	if team == nil or team < 0 or slot == nil or slot < 0 then
		if AUTOTRACKER_ENABLE_DEBUG_LOGGING_AP then
			print("onAutoTabClear: not connected, skipping data storage subscription")
		end
		return
	end
	AUTO_TAB_KEY = string.format("khddd_%d_%d_room", team, slot)
	if AUTOTRACKER_ENABLE_DEBUG_LOGGING_AP then
		print(string.format("onAutoTabClear: subscribing to %s", AUTO_TAB_KEY))
	end
	Archipelago:SetNotify({ AUTO_TAB_KEY })
	Archipelago:Get({ AUTO_TAB_KEY })
end

local function onRoomUpdate(key, value)
	if key ~= AUTO_TAB_KEY or type(value) ~= "table" then
		return
	end
	local toggle = Tracker:FindObjectForCode("opt_auto_tab")
	if not toggle or not toggle.Active then
		return
	end
	local world = tonumber(value.world)
	local character = tonumber(value.character)
	if world == nil or character == nil then
		if AUTOTRACKER_ENABLE_DEBUG_LOGGING_AP then
			print(string.format("onRoomUpdate: malformed value %s", dump_table(value)))
		end
		return
	end
	if world == last_world and character == last_character then
		return
	end
	last_world = world
	last_character = character
	local character_tab = CHARACTER_TABS[character]
	local world_tab = WORLD_TABS[world] and WORLD_TABS[world][character]
	if AUTOTRACKER_ENABLE_DEBUG_LOGGING_AP then
		print(string.format("onRoomUpdate: world 0x%02X, character %d -> %s / %s", world, character,
			tostring(character_tab), tostring(world_tab)))
	end
	if not character_tab or not world_tab then
		return
	end
	Tracker:UiHint("ActivateTab", character_tab)
	Tracker:UiHint("ActivateTab", world_tab)
end

Archipelago:AddClearHandler("auto tab clear", onAutoTabClear)
Archipelago:AddRetrievedHandler("auto tab retrieved", onRoomUpdate)
Archipelago:AddSetReplyHandler("auto tab set reply", onRoomUpdate)
