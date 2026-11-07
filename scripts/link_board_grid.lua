-- Link Boards grid portraits: greyed without the spirit's recipe, with its gates overlaid open or closed
ScriptHost:LoadScript("scripts/link_board_spirits.lua")

local portraits = {}

-- matches overlay_name in gen/gen_link_board_grid.py
local function overlay_name(gates, open)
    local parts = {}
    if open > 0 then
        parts[#parts + 1] = open .. "_open"
    end
    if gates > open then
        parts[#parts + 1] = (gates - open) .. "_closed"
    end
    return table.concat(parts, "_")
end

local function icon_mods(spirit, worlds)
    local mods = {}
    local recipe = Tracker:FindObjectForCode(spirit.recipe)
    if not (recipe and recipe.Active) then
        mods[#mods + 1] = "@disabled"
    end
    if spirit.gates > 0 then
        local open = open_board_gates(spirit.id, spirit.gates, worlds)
        mods[#mods + 1] = "overlay|images/spirits/gates_" .. overlay_name(spirit.gates, open) .. ".png"
    end
    return table.concat(mods, ", ")
end

local function refresh()
    local worlds = {}
    for _, spirit in ipairs(LINK_BOARD_SPIRITS) do
        portraits[spirit.id].IconMods = icon_mods(spirit, worlds)
    end
end

for _, spirit in ipairs(LINK_BOARD_SPIRITS) do
    local item = ScriptHost:CreateLuaItem()
    item.Name = spirit.name
    item.Icon = ImageReference:FromPackRelativePath("images/spirits/" .. spirit.id .. ".png")
    item.PotentialCodes = { "link_board_spirit_" .. spirit.id }
    item.OnLeftClickFunc = function()
        local recipe = Tracker:FindObjectForCode(spirit.recipe)
        recipe.Active = not recipe.Active
    end
    item.SaveFunc = function()
        return {}
    end
    item.LoadFunc = function() end
    portraits[spirit.id] = item
end

ScriptHost:AddWatchForCode("link_board_grid", "*", refresh)
refresh()
