-- $ functions used by the rules that gen/gen_access_rules.py writes into locations/locations.json
local function has(code)
    return Tracker:ProviderCountForCode(code) > 0
end

function can_infinite_jump()
    return has("flowmotion") or (has("wall_kick") and has("super_jump"))
end

function can_pole_jump()
    return has("flowmotion") or (has("pole_swing") and has("super_jump") and has("air_slide"))
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

-- the locations counted by beat_x_sora_worlds / beat_x_riku_worlds in the apworld's Rules.py, by gate character
local COMPLETION_LOCATIONS = {
    {
        "@Traverse Town [Sora]/Skull Noise Reward/Skull Noise Reward",
        "@La Cite des Cloches [Sora]/Guardian Bell Reward/Guardian Bell Reward",
        "@The Grid [Sora]/Dual Disc Reward/Dual Disc Reward",
        "@Prankster's Paradise [Sora]/Ferris Gear Reward/Ferris Gear Reward",
        "@Country of the Musketeers [Sora]/All For One Reward/All For One Reward",
        "@Symphony of Sorcery [Sora]/Counterpoint Reward/Counterpoint Reward",
        "@The World That Never Was [Sora]/Xemnas Bonus Slot 1/Xemnas Bonus Slot 1",
    },
    {
        "@Traverse Town [Riku]/Skull Noise Reward/Skull Noise Reward",
        "@La Cite des Cloches [Riku]/Guardian Bell Reward/Guardian Bell Reward",
        "@The Grid [Riku]/Dual Disc Reward/Dual Disc Reward",
        "@Prankster's Paradise [Riku]/Ocean's Rage Reward/Ocean's Rage Reward",
        "@Country of the Musketeers [Riku]/All For One Reward/All For One Reward",
        "@Symphony of Sorcery [Riku]/Counterpoint Reward/Counterpoint Reward",
        "@The World That Never Was [Riku]/Ansem II Defeated/Ansem II Defeated",
    },
}

-- open while the gate's character can reach as many completion locations as the gate needs
function board_gate(id, gate)
    local gates = board_gates and board_gates[tonumber(id)]
    local needed = gates and gates[tonumber(gate)]
    if not needed then
        return AccessibilityLevel.Normal
    end
    local normal, sequence_break = 0, 0
    for _, path in ipairs(COMPLETION_LOCATIONS[gates.character] or {}) do
        local section = Tracker:FindObjectForCode(path)
        local level = section and section.AccessibilityLevel or AccessibilityLevel.None
        if level >= AccessibilityLevel.Normal then
            normal = normal + 1
        elseif level >= AccessibilityLevel.SequenceBreak then
            sequence_break = sequence_break + 1
        end
    end
    if normal >= needed then
        return AccessibilityLevel.Normal
    elseif normal + sequence_break >= needed then
        return AccessibilityLevel.SequenceBreak
    end
    return AccessibilityLevel.None
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
