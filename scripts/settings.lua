-- the Sora/Riku portraits pick the characters in play; never let both be off
local function keep_one_character(code)
	local sora = Tracker:FindObjectForCode("opt_sora")
	local riku = Tracker:FindObjectForCode("opt_riku")
	if sora and riku and not sora.Active and not riku.Active then
		if code == "opt_sora" then
			riku.Active = true
		else
			sora.Active = true
		end
	end
end

ScriptHost:AddWatchForCode("keep one character (sora)", "opt_sora", keep_one_character)
ScriptHost:AddWatchForCode("keep one character (riku)", "opt_riku", keep_one_character)

-- each file points tracker_full, tracker_maps and tracker_items at one item placement; init.lua loads the left one
local PLACEMENT_FILES = { [false] = "layouts/items_left.json", [true] = "layouts/items_bottom.json" }
local placement_file = PLACEMENT_FILES[false]
local items_bottom = false
-- Reset reloads a snapshot saved right after init.lua, before the first frame; saving nothing into it keeps the choice
local started = false

local placement = ScriptHost:CreateLuaItem()
placement.Name = "Items along the bottom"
placement.PotentialCodes = { "opt_items_bottom" }

local function set_items_bottom(bottom)
	items_bottom = bottom
	placement.Icon = ImageReference:FromPackRelativePath(bottom and "images/items/switch_on.png" or "images/items/switch_off.png")
end

set_items_bottom(false)
placement.OnLeftClickFunc = function()
	set_items_bottom(true)
end
placement.OnRightClickFunc = function()
	set_items_bottom(false)
end
placement.OnMiddleClickFunc = function()
	set_items_bottom(not items_bottom)
end
placement.SaveFunc = function()
	if started then
		return { bottom = items_bottom }
	end
end
placement.LoadFunc = function(_, data)
	if data.bottom ~= nil then
		set_items_bottom(data.bottom)
	end
end

-- AddLayouts rebuilds every view, including the popup holding the switch, so it waits a frame
ScriptHost:AddOnFrameHandler("item placement", function()
	started = true
	local file = PLACEMENT_FILES[items_bottom]
	if file ~= placement_file then
		placement_file = file
		Tracker:AddLayouts(file)
	end
end)
