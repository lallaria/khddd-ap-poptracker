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
