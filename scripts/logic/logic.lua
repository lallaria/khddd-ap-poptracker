-- $ functions used by the rules that gen/gen_access_rules.py writes into the locations files
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

-- helpers with a logic option return an AccessibilityLevel (^$): out of logic while the option is off
local function with_logic_option(code, possible)
    if not possible then
        return AccessibilityLevel.None
    end
    return has(code) and AccessibilityLevel.Normal or AccessibilityLevel.SequenceBreak
end

function can_sliding_dash()
    return with_logic_option("opt_slidedash", has("sliding_dash") or has("thunder_dash"))
end

function has_vertical_mobility()
    return has("high_jump") or has("flowmotion") or can_infinite_jump()
end

function has_horizontal_mobility()
    if has("air_slide") or has("flowmotion") or can_infinite_jump() then
        return AccessibilityLevel.Normal
    end
    return can_sliding_dash()
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

local function count_owned(codes)
    local count = 0
    for _, code in ipairs(codes) do
        if has(code) then
            count = count + 1
        end
    end
    return count
end

function has_sora_worlds(n)
    return count_owned(SORA_WORLDS) >= tonumber(n)
end

function has_riku_worlds(n)
    return count_owned(RIKU_WORLDS) >= tonumber(n)
end

-- recipes by style from the apworld's Items.py, for the styles has_rising_wing counts; gen_access_rules.py checks them
local RECIPE_STYLES = {
    Aqua = {
        "sir_kyroo_recipe", "fin_fatale_recipe", "tatsu_steed_recipe", "icequin_ace_recipe",
        "escarglow_recipe", "wheeflower_recipe", "zolephant_recipe", "juggle_pup_recipe",
        "r_and_r_seal_recipe", "beatalike_recipe", "tubguin_ace_recipe",
    },
    Dark = {
        "komory_bat_recipe", "toximander_recipe", "necho_cat_recipe", "peepsta_hoo_recipe",
        "ghostabocky_recipe", "fishbone_recipe", "woeflower_recipe", "skelterwild_recipe",
        "keeba_tiger_recipe", "frootz_cat_recipe",
    },
    Fire = {
        "yoggy_ram_recipe", "hebby_rep_recipe", "ko_kabuto_recipe", "staggerceps_recipe",
        "chef_kyroo_recipe", "tatsu_blaze_recipe", "eaglider_recipe", "tyranto_rex_recipe",
        "ryu_dragon_recipe", "drak_quack_recipe", "sudo_neku_recipe", "kab_kannon_recipe",
    },
    Physical = {
        "meow_wow_recipe", "tama_sheep_recipe", "pricklemane_recipe", "kooma_panda_recipe",
        "halbird_recipe", "flowbermeow_recipe", "drill_sye_recipe", "cera_terror_recipe",
        "ducky_goose_recipe", "aura_lion_recipe", "meowjesty_recipe", "ursa_circus_recipe",
        "catanuki_recipe",
    },
}

function has_rising_wing()
    local aqua = count_owned(RECIPE_STYLES.Aqua)
    local links = aqua + count_owned(RECIPE_STYLES.Dark) + count_owned(RECIPE_STYLES.Fire)
        + count_owned(RECIPE_STYLES.Physical)
    return with_logic_option("opt_riku_links", aqua >= 1 and links >= 2)
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

-- the events counted by beat_x_sora_worlds / beat_x_riku_worlds in the apworld's Rules.py, by gate character;
-- clears are the AP checks sent as the world is cleared: its boss and keyblade (TWTNW: its last check)
local WORLD_EVENTS = {
    {
        { event = "@Traverse Town Plaza [Sora]/Cleared/Traverse Town Cleared [Sora]",
          clears = { "Traverse Town Hockomonkey Bonus Slot 1 [Sora]", "Traverse Town Hockomonkey Bonus Slot 2 [Sora]",
                     "Traverse Town Skull Noise Reward [Sora]" } },
        { event = "@La Cite des Cloches [Sora]/Cleared/La Cite des Cloches Cleared [Sora]",
          clears = { "La Cite des Cloches Wargoyle Bonus Slot 1 [Sora]", "La Cite des Cloches Guardian Bell Reward [Sora]",
                     "La Cite des Cloches Chronicle BBS Reward [Sora]" } },
        { event = "@The Grid Throughput [Sora]/Cleared/The Grid Cleared [Sora]",
          clears = { "The Grid Rinzler Bonus Slot 1 [Sora]", "The Grid Rinzler Bonus Slot 2 [Sora]",
                     "The Grid Dual Disc Reward [Sora]" } },
        { event = "@Prankster's Paradise [Sora]/Cleared/Prankster's Paradise Cleared [Sora]",
          clears = { "Prankster's Paradise Chill Clawbster Bonus Slot 1 [Sora]", "Prankster's Paradise Ferris Gear Reward [Sora]" } },
        { event = "@Country of the Musketeers [Sora]/Cleared/Country of the Musketeers Cleared [Sora]",
          clears = { "Country of the Musketeers Pete Bonus Slot 1 [Sora]", "Country of the Musketeers All For One Reward [Sora]" } },
        { event = "@Symphony of Sorcery [Sora]/Cleared/Symphony of Sorcery Cleared [Sora]",
          clears = { "Symphony of Sorcery Spellican Bonus Slot 1 [Sora]", "Symphony of Sorcery Spellican Bonus Slot 2 [Sora]",
                     "Symphony of Sorcery Counterpoint Reward [Sora]" } },
        { event = "@Traverse Town 2 [Sora]/Cleared/Traverse Town 2 Cleared [Sora]",
          clears = { "Traverse Town 2 Boss Gauntlet Bonus Slot 1 [Sora]", "Traverse Town 2 Boss Gauntlet Bonus Slot 2 [Sora]",
                     "Traverse Town 2 Boss Gauntlet Reward [Sora]", "Traverse Town 2 Knockout Punch Reward [Sora]" } },
        { event = "@The World That Never Was [Sora]/Cleared/The World That Never Was Cleared [Sora]",
          clears = { "The World That Never Was Glossary: Hearts Tied to Sora Reward [Sora]" } },
    },
    {
        { event = "@Traverse Town [Riku]/Cleared/Traverse Town Cleared [Riku]",
          clears = { "Traverse Town Hockomonkey Bonus Slot 1 [Riku]", "Traverse Town Hockomonkey Bonus Slot 2 [Riku]",
                     "Traverse Town Skull Noise Reward [Riku]" } },
        { event = "@La Cite des Cloches [Riku]/Cleared/La Cite des Cloches Cleared [Riku]",
          clears = { "La Cite des Cloches Wargoyle Bonus Slot 1 [Riku]", "La Cite des Cloches Wargoyle Bonus Slot 2 [Riku]",
                     "La Cite des Cloches Guardian Bell Reward [Riku]", "La Cite des Cloches Chronicle: Kingdom Hearts Reward [Riku]" } },
        { event = "@The Grid [Riku]/Cleared/The Grid Cleared [Riku]",
          clears = { "The Grid Commantis Bonus Slot 1 [Riku]", "The Grid Dual Disc Reward [Riku]" } },
        { event = "@Prankster's Paradise [Riku]/Cleared/Prankster's Paradise Cleared [Riku]",
          clears = { "Prankster's Paradise Char Clobster Bonus Slot 1 [Riku]", "Prankster's Paradise Ocean's Rage Reward [Riku]" } },
        { event = "@Country of the Musketeers Green Room [Riku]/Cleared/Country of the Musketeers Cleared [Riku]",
          clears = { "Country of the Musketeers Holey Moley Bonus Slot 1 [Riku]", "Country of the Musketeers All For One Reward [Riku]" } },
        { event = "@Symphony of Sorcery Snowgleam Wood [Riku]/Cleared/Symphony of Sorcery Cleared [Riku]",
          clears = { "Symphony of Sorcery Chernobog Bonus Slot 1 [Riku]", "Symphony of Sorcery Chernobog Bonus Slot 2 [Riku]",
                     "Symphony of Sorcery Counterpoint Reward [Riku]" } },
        { event = "@Traverse Town 2 [Riku]/Cleared/Traverse Town 2 Cleared [Riku]",
          clears = { "Traverse Town 2 Cera Terror Battle Bonus Slot 1 [Riku]", "Traverse Town 2 Cera Terror Battle Bonus Slot 2 [Riku]",
                     "Traverse Town 2 Knockout Punch Reward [Riku]" } },
        { event = "@The World That Never Was [Riku]/Cleared/The World That Never Was Cleared [Riku]",
          clears = { "The World That Never Was Ansem II Defeated [Riku]" } },
    },
}

-- AP location name -> section code, from location_mapping.lua (loaded after this file)
local check_sections = nil

local function check_section(name)
    if not check_sections then
        check_sections = {}
        for _, targets in pairs(LOCATION_MAPPING or {}) do
            local code = targets[1] and targets[1][1]
            if code and code:sub(1, 1) == "@" then
                check_sections[code:match("[^/]+$")] = code
            end
        end
    end
    local code = check_sections[name]
    return code and Tracker:FindObjectForCode(code)
end

local function world_cleared(world)
    for _, name in ipairs(world.clears) do
        local section = check_section(name)
        if section and section.AvailableChestCount == 0 then
            return true
        end
    end
    return false
end

-- the character's worlds already cleared, then the rest by whether their Cleared event is in logic or a sequence break
local function count_worlds(character)
    local cleared, normal, sequence_break = 0, 0, 0
    for _, world in ipairs(WORLD_EVENTS[character] or {}) do
        if world_cleared(world) then
            cleared = cleared + 1
        else
            local section = Tracker:FindObjectForCode(world.event)
            local level = section and section.AccessibilityLevel or AccessibilityLevel.None
            if level >= AccessibilityLevel.Normal then
                normal = normal + 1
            elseif level >= AccessibilityLevel.SequenceBreak then
                sequence_break = sequence_break + 1
            end
        end
    end
    return cleared, normal, sequence_break
end

-- green once enough worlds are cleared, blue while enough more are in logic to clear
function board_gate(id, gate)
    local gates = board_gates and board_gates[tonumber(id)]
    local needed = gates and gates[tonumber(gate)]
    if not needed then
        return AccessibilityLevel.Normal
    end
    local cleared, normal, sequence_break = count_worlds(gates.character)
    if cleared >= needed then
        return AccessibilityLevel.Normal
    elseif cleared + normal >= needed then
        return AccessibilityLevel.Inspect
    elseif cleared + normal + sequence_break >= needed then
        return AccessibilityLevel.SequenceBreak
    end
    return AccessibilityLevel.None
end

-- how many of the spirit's first gate_count gates are open in logic; worlds caches that count by character
function open_board_gates(id, gate_count, worlds)
    local gates = board_gates and board_gates[tonumber(id)]
    if not gates then
        return gate_count
    end
    if not worlds[gates.character] then
        local cleared, normal = count_worlds(gates.character)
        worlds[gates.character] = cleared + normal
    end
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
