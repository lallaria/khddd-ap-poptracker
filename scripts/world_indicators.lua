-- overlays each world icon with the number of unchecked, logically reachable (green) checks in that world
local REACHABLE_COLOR = "#20FF20" -- PopTracker's default map colour for reachable

-- code of the item the layouts show for each world -> the locations file holding that world's regions
local WORLD_FILES = {
    world_traverse_town_sora_shown = "locations/sora/traverse_town.json",
    world_traverse_town_riku_shown = "locations/riku/traverse_town.json",
    world_la_cite_des_cloches_sora = "locations/sora/la_cite_des_cloches.json",
    world_la_cite_des_cloches_riku = "locations/riku/la_cite_des_cloches.json",
    world_the_grid_sora = "locations/sora/the_grid.json",
    world_the_grid_riku = "locations/riku/the_grid.json",
    world_pranksters_paradise_sora = "locations/sora/pranksters_paradise.json",
    world_pranksters_paradise_riku = "locations/riku/pranksters_paradise.json",
    world_country_of_the_musketeers_sora = "locations/sora/country_of_the_musketeers.json",
    world_country_of_the_musketeers_riku = "locations/riku/country_of_the_musketeers.json",
    world_symphony_of_sorcery_sora = "locations/sora/symphony_of_sorcery.json",
    world_symphony_of_sorcery_riku = "locations/riku/symphony_of_sorcery.json",
    world_the_world_that_never_was_sora = "locations/sora/the_world_that_never_was.json",
    world_the_world_that_never_was_riku = "locations/riku/the_world_that_never_was.json",
}

-- Lua has no access to PopTracker's visibility results, so visibility_rules are re-evaluated here;
-- they only hold item codes, code:N and $functions
local function parse_atom(atom)
    local code, count = atom:match("^(.+):(%d+)$")
    return { code = code or atom, count = tonumber(count) or 1 }
end

local function compile_rules(rules)
    if type(rules) == "string" then
        rules = { rules }
    end
    local compiled = {}
    for _, rule in ipairs(rules) do
        local atoms = {}
        if type(rule) == "table" then
            for _, atom in ipairs(rule) do
                atoms[#atoms + 1] = parse_atom(atom)
            end
        else
            for atom in rule:gmatch("[^,]+") do
                atoms[#atoms + 1] = parse_atom(atom)
            end
        end
        compiled[#compiled + 1] = atoms
    end
    return compiled
end

local function rules_pass(compiled)
    for _, atoms in ipairs(compiled) do
        local pass = true
        for _, atom in ipairs(atoms) do
            if Tracker:ProviderCountForCode(atom.code) < atom.count then
                pass = false
                break
            end
        end
        if pass then
            return true
        end
    end
    return false
end

-- children and sections inherit their ancestors' visibility_rules
local function with_rules(chain, rules)
    if rules == nil or #rules == 0 then
        return chain
    end
    local extended = { table.unpack(chain) }
    extended[#extended + 1] = compile_rules(rules)
    return extended
end

local function collect_sections(node, parent_id, chain, out)
    -- Cleared sections are logic events for board_gate, not checks
    if node.name == "Cleared" then
        return
    end
    local id = parent_id and (parent_id .. "/" .. node.name) or node.name
    chain = with_rules(chain, node.visibility_rules)
    for _, section in ipairs(node.sections or {}) do
        -- a ref section repeats a check counted where it lives
        if section.ref == nil then
            local code = "@" .. id .. "/" .. (section.name or "")
            local object = Tracker:FindObjectForCode(code)
            if object then
                out[#out + 1] = { object = object, visibility = with_rules(chain, section.visibility_rules) }
            else
                print("world indicators: no section " .. code)
            end
        end
    end
    for _, child in ipairs(node.children or {}) do
        collect_sections(child, id, chain, out)
    end
end

local function load_world_sections()
    local sections = {}
    for code, path in pairs(WORLD_FILES) do
        sections[code] = {}
        local file = io.open(path, "rb")
        if file then
            local locations = decode_json(file:read("*all"))
            file:close()
            for _, top in ipairs(locations) do
                collect_sections(top, nil, {}, sections[code])
            end
        else
            print("world indicators: no locations file " .. path)
        end
    end
    return sections
end

local WORLD_SECTIONS = load_world_sections()
local WORLD_ITEMS = {}
for code in pairs(WORLD_FILES) do
    local item = Tracker:FindObjectForCode(code)
    item:SetOverlayBackground("#000000")
    item:SetOverlayFontSize(20)
    if item.SetOverlayColor then -- 0.31.0+
        item:SetOverlayColor(REACHABLE_COLOR)
    end
    WORLD_ITEMS[code] = item
end

local function count_reachable(sections, visible)
    local count = 0
    for _, section in ipairs(sections) do
        if section.object.AccessibilityLevel == AccessibilityLevel.Normal then
            local shown = true
            for _, rules in ipairs(section.visibility) do
                if visible[rules] == nil then
                    visible[rules] = rules_pass(rules)
                end
                if not visible[rules] then
                    shown = false
                    break
                end
            end
            if shown then
                count = count + 1
            end
        end
    end
    return count
end

local dirty = true
local writing = false

-- counts everything before writing: each overlay change marks logic stale
local function update_overlays()
    local visible = {}
    local counts = {}
    for code, sections in pairs(WORLD_SECTIONS) do
        counts[code] = count_reachable(sections, visible)
    end
    for code, count in pairs(counts) do
        WORLD_ITEMS[code]:SetOverlay(count > 0 and tostring(count) or "")
    end
end

-- overlay writes fire the "*" watch synchronously; `writing` keeps them from re-marking dirty
local function mark_dirty()
    if not writing then
        dirty = true
    end
end

ScriptHost:AddWatchForCode("world indicators", "*", mark_dirty)
if ScriptHost.AddOnLocationSectionChangedHandler then -- 0.26.2+
    ScriptHost:AddOnLocationSectionChangedHandler("world indicators", mark_dirty)
end
ScriptHost:AddOnFrameHandler("world indicators", function()
    if not dirty then
        return
    end
    dirty = false
    writing = true
    local ok, err = pcall(update_overlays)
    writing = false
    if not ok then
        print("world indicators: " .. tostring(err))
    end
end)
