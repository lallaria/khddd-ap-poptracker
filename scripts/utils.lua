-- from https://stackoverflow.com/questions/9168058/how-to-dump-a-table-to-console
-- dumps a table in a readable string
function dump_table(o, depth)
    if depth == nil then
        depth = 0
    end
    if type(o) == 'table' then
        local tabs = ('\t'):rep(depth)
        local tabs2 = ('\t'):rep(depth + 1)
        local s = '{\n'
        for k, v in pairs(o) do
            local kc = k
            if type(k) ~= 'number' then
                kc = '"' .. k .. '"'
            end
            s = s .. tabs2 .. '[' .. kc .. '] = ' .. dump_table(v, depth + 1) .. ',\n'
        end
        return s .. tabs .. '}'
    else
        return tostring(o)
    end
end

local JSON_ESCAPES = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

-- decodes strict JSON (no comments or trailing commas); raises an error on malformed input
function decode_json(text)
    local pos = 1

    local function fail(expected)
        error(string.format("decode_json: expected %s at byte %d", expected, pos))
    end

    local function peek()
        pos = text:find("%S", pos) or #text + 1
        return text:sub(pos, pos)
    end

    local function expect(char)
        if peek() ~= char then
            fail("'" .. char .. "'")
        end
        pos = pos + 1
    end

    local function parse_string()
        expect('"')
        local parts = {}
        while true do
            local stop = text:find('["\\]', pos) or fail("closing quote")
            parts[#parts + 1] = text:sub(pos, stop - 1)
            if text:sub(stop, stop) == '"' then
                pos = stop + 1
                return table.concat(parts)
            end
            local escape = text:sub(stop + 1, stop + 1)
            if escape == "u" then
                parts[#parts + 1] = utf8.char(tonumber(text:sub(stop + 2, stop + 5), 16))
                pos = stop + 6
            else
                parts[#parts + 1] = JSON_ESCAPES[escape] or escape
                pos = stop + 2
            end
        end
    end

    local function parse_list(close, parse_entry)
        pos = pos + 1
        if peek() == close then
            pos = pos + 1
            return
        end
        while true do
            parse_entry()
            local delimiter = peek()
            if delimiter == close then
                pos = pos + 1
                return
            end
            expect(",")
        end
    end

    local function parse_value()
        local char = peek()
        if char == "{" then
            local object = {}
            parse_list("}", function()
                local key = parse_string()
                expect(":")
                object[key] = parse_value()
            end)
            return object
        elseif char == "[" then
            local array = {}
            parse_list("]", function()
                array[#array + 1] = parse_value()
            end)
            return array
        elseif char == '"' then
            return parse_string()
        end
        local literal = text:match("^[%w.+-]+", pos) or fail("a value")
        pos = pos + #literal
        if literal == "true" then
            return true
        elseif literal == "false" then
            return false
        elseif literal == "null" then
            return nil
        end
        return tonumber(literal) or fail("a number")
    end

    local value = parse_value()
    if peek() ~= "" then
        fail("end of input")
    end
    return value
end
