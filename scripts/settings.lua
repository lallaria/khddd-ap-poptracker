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
