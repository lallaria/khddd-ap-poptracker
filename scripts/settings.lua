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

-- each file points tracker_full, tracker_maps and tracker_items at one item placement;
-- init.lua loads items_bottom.json to match the toggle's initial state
local placement_file = "layouts/items_bottom.json"
local placement_dirty = false

ScriptHost:AddWatchForCode("item placement", "opt_items_bottom", function()
	placement_dirty = true
end)
-- AddLayouts rebuilds every view, including the popup whose toggle fired the watch, so it waits a frame
ScriptHost:AddOnFrameHandler("item placement", function()
	if not placement_dirty then
		return
	end
	placement_dirty = false
	local bottom = Tracker:FindObjectForCode("opt_items_bottom").Active
	local file = bottom and "layouts/items_bottom.json" or "layouts/items_left.json"
	if file ~= placement_file then
		placement_file = file
		Tracker:AddLayouts(file)
	end
end)
