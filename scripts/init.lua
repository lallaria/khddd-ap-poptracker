-- entry point for all lua code of the pack
-- more info on the lua API: https://github.com/black-sliver/PopTracker/blob/master/doc/PACKS.md#lua-interface
ENABLE_DEBUG_LOG = true
local variant = Tracker.ActiveVariantUID
IS_ITEMS_ONLY = variant == "var_itemsonly"
-- variant uids are fixed by manifest.json; each variant's layouts/root.json picks its root layout
HAS_LINK_BOARDS = variant == "standard" or variant == "var_linkboards"

print("-- Example Tracker --")
print("Loaded variant: ", variant)
if ENABLE_DEBUG_LOG then
    print("Debug logging is enabled!")
end

-- Utility Script for helper functions etc.
ScriptHost:LoadScript("scripts/utils.lua")

-- Logic
ScriptHost:LoadScript("scripts/logic/logic.lua")

-- Custom Items
ScriptHost:LoadScript("scripts/custom_items/class.lua")
ScriptHost:LoadScript("scripts/custom_items/progressiveTogglePlus.lua")
ScriptHost:LoadScript("scripts/custom_items/progressiveTogglePlusWrapper.lua")

-- Items
Tracker:AddItems("items/items.json")
Tracker:AddItems("items/settings.json")
ScriptHost:LoadScript("scripts/settings.lua")
ScriptHost:LoadScript("scripts/traverse_town.lua")

if not IS_ITEMS_ONLY then -- <--- use variant info to optimize loading
    -- Maps
    Tracker:AddMaps("maps/maps.json")
    -- Locations
    Tracker:AddLocations("locations/locations.json")
    ScriptHost:LoadScript("scripts/world_indicators.lua")
    if HAS_LINK_BOARDS then
        ScriptHost:LoadScript("scripts/link_board_grid.lua")
        Tracker:AddLayouts("layouts/link_boards.json")
    end
end

-- Layout
Tracker:AddLayouts("layouts/items.json")
Tracker:AddLayouts("layouts/tracker.json")
Tracker:AddLayouts("layouts/items_bottom.json")
Tracker:AddLayouts("layouts/root.json")
Tracker:AddLayouts("layouts/settings.json")
Tracker:AddLayouts("layouts/broadcast.jsonc")

-- AutoTracking for Poptracker
ScriptHost:LoadScript("scripts/autotracking.lua")
