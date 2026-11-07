-- $ functions used by the rules that gen/gen_access_rules.py writes into locations/locations.json
local function has(code)
    return Tracker:ProviderCountForCode(code) > 0
end

function can_infinite_jump()
    return has("flowmotion") or (has("wall_kick") and has("super_jump"))
end

function can_pole_jump()
    return has("air_slide") and (has("flowmotion") or (has("pole_swing") and has("super_jump")))
end

function can_glide()
    return has("flowmotion") or has("glide") or has("superglide")
end

function post_office_access()
    return has("flowmotion") or has("wall_kick") or has("glide") or has("rail_slide")
end

-- the worlds counted by has_x_sora_worlds / has_x_riku_worlds in the apworld's Rules.py
local SORA_WORLDS = {
    "world_traverse_town_sora",
    "world_la_cite_des_cloches_sora",
    "world_the_grid_sora",
    "world_pranksters_paradise_sora",
    "world_country_of_the_musketeers_sora",
    "world_symphony_of_sorcery_sora",
}
local RIKU_WORLDS = {
    "world_traverse_town_riku",
    "world_la_cite_des_cloches_riku",
    "world_the_grid_riku",
    "world_pranksters_paradise_riku",
    "world_country_of_the_musketeers_riku",
    "world_symphony_of_sorcery_riku",
}

local function count_worlds(codes)
    local count = 0
    for _, code in ipairs(codes) do
        if has(code) then
            count = count + 1
        end
    end
    return count
end

function has_sora_worlds(n)
    return count_worlds(SORA_WORLDS) >= tonumber(n)
end

function has_riku_worlds(n)
    return count_worlds(RIKU_WORLDS) >= tonumber(n)
end

-- spirit id -> { character = 1 sora / 2 riku, world count per gate } from slot_data gate_reqs; nil until AP connects
local board_gates = nil
-- rule results stay cached until an item changes, so gate updates touch this hidden item
local board_gates_item = ScriptHost:CreateLuaItem()
board_gates_item.Name = "Link Board Gates"
local board_gates_revision = 0

function set_board_gates(gates)
    board_gates = gates
    board_gates_revision = board_gates_revision + 1
    board_gates_item:Set("revision", board_gates_revision)
end

function recipe_in_pool(id)
    return board_gates == nil or board_gates[tonumber(id)] ~= nil
end

function recipe_not_in_pool(id)
    return not recipe_in_pool(id)
end

-- the events counted by beat_x_sora_worlds / beat_x_riku_worlds in the apworld's Rules.py, by gate character
local WORLD_EVENTS = {
    {
        "@Traverse Town [Sora]/Cleared/Traverse Town Cleared [Sora]",
        "@La Cite des Cloches [Sora]/Cleared/La Cite des Cloches Cleared [Sora]",
        "@The Grid [Sora]/Cleared/The Grid Cleared [Sora]",
        "@Prankster's Paradise [Sora]/Cleared/Prankster's Paradise Cleared [Sora]",
        "@Country of the Musketeers [Sora]/Cleared/Country of the Musketeers Cleared [Sora]",
        "@Symphony of Sorcery [Sora]/Cleared/Symphony of Sorcery Cleared [Sora]",
        "@The World That Never Was [Sora]/Cleared/The World That Never Was Cleared [Sora]",
    },
    {
        "@Traverse Town [Riku]/Cleared/Traverse Town Cleared [Riku]",
        "@La Cite des Cloches [Riku]/Cleared/La Cite des Cloches Cleared [Riku]",
        "@The Grid [Riku]/Cleared/The Grid Cleared [Riku]",
        "@Prankster's Paradise [Riku]/Cleared/Prankster's Paradise Cleared [Riku]",
        "@Country of the Musketeers [Riku]/Cleared/Country of the Musketeers Cleared [Riku]",
        "@Symphony of Sorcery [Riku]/Cleared/Symphony of Sorcery Cleared [Riku]",
        "@The World That Never Was [Riku]/Cleared/The World That Never Was Cleared [Riku]",
    },
}

-- Cleared events the character reaches in logic, and those reachable only with sequence breaks
local function reachable_worlds(character)
    local normal, sequence_break = 0, 0
    for _, path in ipairs(WORLD_EVENTS[character] or {}) do
        local section = Tracker:FindObjectForCode(path)
        local level = section and section.AccessibilityLevel or AccessibilityLevel.None
        if level >= AccessibilityLevel.Normal then
            normal = normal + 1
        elseif level >= AccessibilityLevel.SequenceBreak then
            sequence_break = sequence_break + 1
        end
    end
    return normal, sequence_break
end

-- open while the gate's character can reach as many Cleared events as the gate needs
function board_gate(id, gate)
    local gates = board_gates and board_gates[tonumber(id)]
    local needed = gates and gates[tonumber(gate)]
    if not needed then
        return AccessibilityLevel.Normal
    end
    local normal, sequence_break = reachable_worlds(gates.character)
    if normal >= needed then
        return AccessibilityLevel.Normal
    elseif normal + sequence_break >= needed then
        return AccessibilityLevel.SequenceBreak
    end
    return AccessibilityLevel.None
end

-- how many of the spirit's first gate_count gates are open in logic; worlds caches reachable_worlds by character
function open_board_gates(id, gate_count, worlds)
    local gates = board_gates and board_gates[tonumber(id)]
    if not gates then
        return gate_count
    end
    worlds[gates.character] = worlds[gates.character] or reachable_worlds(gates.character)
    local open = 0
    for gate = 1, gate_count do
        if not gates[gate] or gates[gate] <= worlds[gates.character] then
            open = open + 1
        end
    end
    return open
end

local function has_opt_count(code, opt_code)
    local opt = Tracker:FindObjectForCode(opt_code)
    return Tracker:ProviderCountForCode(code) >= (opt and opt.AcquiredCount or 0)
end

function has_recipes()
    return has_opt_count("recipe_total", "opt_recipe_reqs")
end

function has_emblems()
    return has_opt_count("lucky_emblem", "opt_emblem_reqs")
end

-- true while a setting toggle is off or a setting count is 0
function opt_off(code)
    return Tracker:ProviderCountForCode(code) == 0
end
