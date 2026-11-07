-- Traverse Town's world items are consumables (the second copy opens TT2), and PopTracker draws a consumable's own
-- count over any overlay text; the layouts show these stand-ins so world_indicators.lua's check count shows instead
local TITLES = { "Traverse Town", "Traverse Town 2" }

for character, label in pairs({ sora = "[Sora]", riku = "[Riku]" }) do
    local code = "world_traverse_town_" .. character
    local world = Tracker:FindObjectForCode(code)
    local item = ScriptHost:CreateLuaItem()
    item.Icon = ImageReference:FromPackRelativePath("images/items/worlds/Traverse Town.png")
    item.PotentialCodes = { code .. "_shown" }
    item.OnLeftClickFunc = function()
        world.AcquiredCount = math.min(world.AcquiredCount + 1, world.MaxCount)
    end
    item.OnRightClickFunc = function()
        world.AcquiredCount = math.max(world.AcquiredCount - 1, 0)
    end
    item.SaveFunc = function()
        return {}
    end
    item.LoadFunc = function() end
    local function refresh()
        item.IconMods = world.AcquiredCount > 0 and "" or "@disabled"
        item.Name = TITLES[math.max(world.AcquiredCount, 1)] .. " " .. label
    end
    ScriptHost:AddWatchForCode("traverse town " .. character, code, refresh)
    refresh()
end
