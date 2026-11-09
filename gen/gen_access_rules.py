"""Generates access_rules and visibility_rules in locations/locations.json from the apworld's Rules.py.

Usage: <source>/Archipelago/venv/Scripts/python gen/gen_access_rules.py

Run it with the venv inside the Archipelago checkout that holds worlds/khddd.
"""
from __future__ import annotations

import ast
import atexit
import functools
import inspect
import itertools
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(sys.prefix).parent))  # the venv sits in the Archipelago checkout

from worlds import khddd
from gen_location_mapping import BOARD_ROOT, OPEN_SEGMENT, gate_nodes, tracker_regions

atexit.unregister(input)  # some apworlds register an exit prompt on import

REPO = Path(__file__).resolve().parent.parent
LOCATIONS_JSON = REPO / "locations" / "locations.json"
LOCATION_MAPPING = REPO / "scripts" / "autotracking" / "location_mapping.lua"
ITEM_MAPPING = REPO / "scripts" / "autotracking" / "item_mapping.lua"
LOGIC_LUA = REPO / "scripts" / "logic" / "logic.lua"
EVENT_LOCATION = "Cleared"

# option -> value domain; emblem_reqs is folded to 0 / "1 or more"
OPTIONS = {
    "character": (0, 1, 2),
    "goal": (0, 1, 2),
    "superbosses": (0, 1),
    "lord_kyroo": (0, 1),
    "armored_ventus_nightmare": (0, 1),
    "fast_go_mode": (0, 1),
    "play_destiny_islands": (0, 1),
    "link_board_sanity": (0, 1),
    "stats_on_levels": (0, 1, 2, 3),
    "emblem_reqs": (0, 1),
}
ENUM_CODES = {
    "goal": {0: "opt_goal_final_boss", 1: "opt_goal_superbosses", 2: "opt_goal_lucky_emblems"},
}
# character (0 both, 1 sora, 2 riku) is two toggles; at least one is always on
CHARACTER_CODES = {
    frozenset({0}): [["opt_sora", "opt_riku"]],
    frozenset({1}): [["opt_sora", "$opt_off|opt_riku"]],
    frozenset({2}): [["opt_riku", "$opt_off|opt_sora"]],
    frozenset({0, 1}): [["opt_sora"]],
    frozenset({0, 2}): [["opt_riku"]],
    frozenset({1, 2}): [["$opt_off|opt_sora"], ["$opt_off|opt_riku"]],
}
TOGGLE_CODES = {
    "superbosses": "opt_superbosses",
    "lord_kyroo": "opt_lord_kyroo",
    "armored_ventus_nightmare": "opt_avn",
    "fast_go_mode": "opt_fast_go_mode",
    "play_destiny_islands": "opt_destiny_islands",
    "link_board_sanity": "opt_link_boards",
}
COUNT_OPTION_CODES = {"emblem_reqs": "opt_emblem_reqs", "recipe_reqs": "opt_recipe_reqs"}
# (item, option) count comparisons with a dedicated Lua function
COUNT_HELPERS = {("Lucky Emblem", "emblem_reqs"): "$has_emblems"}
# Rules.py helper -> Lua $ function; other helpers are inlined from their body
HELPERS = {
    "can_infinite_jump": "$can_infinite_jump",
    "can_pole_jump": "$can_pole_jump",
    "can_glide": "$can_glide",
    "post_office_access": "$post_office_access",
    "has_required_recipes": "$has_recipes",
}
COUNTING_HELPERS = {"has_x_sora_worlds": "$has_sora_worlds", "has_x_riku_worlds": "$has_riku_worlds"}
# Rules.py helper returning {node: rule} for the rolled link board gates; gate_contributions adds those rules
GATE_RULES_HELPER = "gate_rules"
GATE_RULES = object()
# per-seed facts from slot_data, guarded like options with domain (0, 1): fact -> (Lua $ when true, when false)
SEED_FACT_CODES = {"recipe_in_pool": ("$recipe_in_pool", "$recipe_not_in_pool")}

ALL_OPTION_COMBOS = [dict(zip(OPTIONS, values)) for values in itertools.product(*OPTIONS.values())]
CODE_OPTION_VALUE = {code: (option, value) for option, codes in ENUM_CODES.items() for value, code in codes.items()}

WARNINGS = []


def warn(message):
    WARNINGS.append(message)
    print("warning:", message)


# --- guards: boolean trees over option pieces ------------------------------------------------------

def option_domain(option):
    return OPTIONS.get(option, (0, 1))


def piece(option, allowed):
    return ("piece", option, frozenset(allowed) & set(option_domain(option)))


def recipe_in_pool(spirit_id):
    return piece(("recipe_in_pool", spirit_id), {1})


def guard_and(*parts):
    flat = []
    for part in parts:
        if part is False:
            return False
        if part is True:
            continue
        flat.extend(part[1] if part[0] == "and" else (part,))
    if not flat:
        return True
    return flat[0] if len(flat) == 1 else ("and", tuple(flat))


def guard_or(*parts):
    flat = []
    for part in parts:
        if part is True:
            return True
        if part is False:
            continue
        flat.extend(part[1] if part[0] == "or" else (part,))
    if not flat:
        return False
    return flat[0] if len(flat) == 1 else ("or", tuple(flat))


def guard_not(guard):
    if isinstance(guard, bool):
        return not guard
    return ("not", guard)


def guard_eval(guard, opts):
    if isinstance(guard, bool):
        return guard
    kind = guard[0]
    if kind == "piece":
        return opts[guard[1]] in guard[2]
    if kind == "not":
        return not guard_eval(guard[1], opts)
    if kind == "and":
        return all(guard_eval(part, opts) for part in guard[1])
    return any(guard_eval(part, opts) for part in guard[1])


def merge_option_branch(a, b):
    merged = dict(a)
    for option, allowed in b.items():
        merged[option] = merged.get(option, frozenset(option_domain(option))) & allowed
        if not merged[option]:
            return None
    return merged


def simplify_option_combo(branches):
    cleaned = []
    for branch in branches:
        branch = {option: allowed for option, allowed in branch.items()
                  if allowed != frozenset(option_domain(option))}
        if branch not in cleaned:
            cleaned.append(branch)
    result = []
    for branch in cleaned:
        absorbed = any(other is not branch and all(
            option in branch and branch[option] <= allowed for option, allowed in other.items())
            for other in cleaned)
        if not absorbed:
            result.append(branch)
    return result


def guard_combo(guard, negate=False):
    """combo as a list of option values."""
    if isinstance(guard, bool):
        return [{}] if guard != negate else []
    kind = guard[0]
    if kind == "piece":
        allowed = guard[2] if not negate else frozenset(option_domain(guard[1])) - guard[2]
        return [{guard[1]: allowed}] if allowed else []
    if kind == "not":
        return guard_combo(guard[1], not negate)
    if (kind == "and") != negate:
        result = [{}]
        for part in guard[1]:
            merged = (merge_option_branch(a, b) for a in result for b in guard_combo(part, negate))
            result = [branch for branch in merged if branch is not None]
        return simplify_option_combo(result)
    return simplify_option_combo([branch for part in guard[1] for branch in guard_combo(part, negate)])


def option_codes(option, allowed):
    """Rule combinations for `option in allowed`."""
    domain = frozenset(option_domain(option))
    if allowed == domain:
        return [[]]
    if not allowed:
        return []
    if isinstance(option, tuple):
        fact, argument = option
        when_true, when_false = SEED_FACT_CODES[fact]
        return [[f"{when_true if 1 in allowed else when_false}|{argument}"]]
    if option == "character":
        return CHARACTER_CODES[frozenset(allowed)]
    if option in ENUM_CODES:
        return [[ENUM_CODES[option][value]] for value in sorted(allowed)]
    if option in TOGGLE_CODES:
        code = TOGGLE_CODES[option]
        return [[code]] if allowed == {1} else [[f"$opt_off|{code}"]]
    if option == "stats_on_levels":
        if allowed == {0, 1, 2}:
            return [["opt_levels"]]
        if allowed == {3}:
            return [["$opt_off|opt_levels"]]
    if option == "emblem_reqs":
        return [["opt_emblem_reqs:1"]] if allowed == {1} else [["$opt_off|opt_emblem_reqs"]]
    raise ValueError(f"cannot express {option} in {sorted(allowed)} with setting codes")


def seed_facts(guard):
    if isinstance(guard, bool):
        return set()
    if guard[0] == "piece":
        return set() if guard[1] in OPTIONS else {guard[1]}
    if guard[0] == "not":
        return seed_facts(guard[1])
    return set().union(*map(seed_facts, guard[1]))


@functools.cache
def assuming(guard, assumption):
    """Simplifies guard to its meaning under assumption: drops entailed pieces and impossible branches.

    Seed facts the assumption does not mention are left unconstrained.
    """
    facts = sorted(seed_facts(assumption))
    combos = []
    for opts in ALL_OPTION_COMBOS:
        for values in itertools.product((0, 1), repeat=len(facts)):
            combo = {**opts, **dict(zip(facts, values))}
            if guard_eval(assumption, combo):
                combos.append(combo)
    feasible = {option: frozenset(opts[option] for opts in combos) for option in [*OPTIONS, *facts]}
    result = []
    for branch in guard_combo(guard):
        if not any(all(opts[option] in allowed for option, allowed in branch.items() if option in opts)
                   for opts in combos):
            continue
        kept = {}
        for option, allowed in branch.items():
            possible = feasible.get(option, frozenset(option_domain(option)))
            if not possible <= allowed:
                kept[option] = allowed & possible
        result.append(kept)
    return simplify_option_combo(result)


def option_combo_to_rules(branches):
    rules = []
    for branch in branches:
        expanded = [[]]
        for option, allowed in branch.items():
            expanded = [a + b for a in expanded for b in option_codes(option, allowed)]
        rules.extend(expanded)
    return simplify(rules)


# --- rule combo over piece strings -------------------------------------------------------------------

def split_piece(text):
    if text.startswith(("$", "^", "@")):
        return text, None
    code, _, count = text.partition(":")
    return code, int(count) if count else 1


def normalize(branch):
    """Canonical piece tuple, or None when the branch contradicts itself."""
    counts = {}
    opaque = []
    for text in branch:
        code, count = split_piece(text)
        if count is None:
            if text not in opaque:
                opaque.append(text)
        else:
            counts[code] = max(counts.get(code, 0), count)
    seen = {}
    for code in counts:
        if code in CODE_OPTION_VALUE:
            option, value = CODE_OPTION_VALUE[code]
            if seen.setdefault(option, value) != value:
                return None
    for text in opaque:
        if text.startswith("$opt_off|") and text[len("$opt_off|"):] in counts:
            return None
    pieces = [code if count == 1 else f"{code}:{count}" for code, count in counts.items()]
    return tuple(pieces + opaque)


def satisfies(strong, weak):
    """True when every piece of weak is implied by strong."""
    strong_counts = {code: count for code, count in map(split_piece, strong) if count is not None}
    for text in weak:
        code, count = split_piece(text)
        if count is None:
            if text not in strong:
                return False
        elif strong_counts.get(code, 0) < count:
            return False
    return True


def simplify(branches):
    normalized = []
    seen = set()
    for branch in branches:
        canonical = normalize(branch)
        if canonical is not None and frozenset(canonical) not in seen:
            seen.add(frozenset(canonical))
            normalized.append(canonical)
    return [list(branch) for branch in normalized
            if not any(frozenset(other) != frozenset(branch) and satisfies(branch, other) for other in normalized)]


def product(a, b):
    return simplify([x + y for x in a for y in b])


def union(a, b):
    return simplify(list(a) + list(b))


# --- translating Rules.py --------------------------------------------------------------------------

class Translator:
    def __init__(self, item_codes, location_paths):
        self.item_codes = item_codes
        self.location_paths = location_paths
        rules = ast.parse(inspect.getsource(khddd.Rules), "Rules.py")
        self.functions = {node.name: node for node in rules.body if isinstance(node, ast.FunctionDef)}
        self.contributions = defaultdict(list)  # target -> [(guard, rule combo)]

    def concrete(self, node, env):
        namespace = {**vars(khddd.Rules), "str": str, "range": range, "len": len, **env}
        return eval(compile(ast.Expression(node), "Rules.py", "eval"), {"__builtins__": {}}, namespace)

    @staticmethod
    def uses_seed(node):
        return any(isinstance(child, ast.Name) and child.id in ("options", "khdddworld") for child in ast.walk(node))

    @staticmethod
    def option_name(node):
        if isinstance(node, ast.Attribute) and node.attr == "value":
            node = node.value
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "options":
            return node.attr
        return None

    def guard(self, node, env):
        """Guard tree for a test expression; concrete sub-expressions collapse to booleans."""
        if not self.uses_seed(node):
            return bool(self.concrete(node, env))
        if isinstance(node, ast.BoolOp):
            parts = [self.guard(value, env) for value in node.values]
            return guard_and(*parts) if isinstance(node.op, ast.And) else guard_or(*parts)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return guard_not(self.guard(node.operand, env))
        option = self.option_name(node)
        if option:
            return piece(option, [value for value in OPTIONS[option] if value])
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            option = self.option_name(node.left)
            other = node.comparators[0]
            if option and not self.uses_seed(other):
                value = self.concrete(other, env)
                tests = {ast.Eq: lambda v: v == value, ast.NotEq: lambda v: v != value, ast.Lt: lambda v: v < value,
                         ast.LtE: lambda v: v <= value, ast.Gt: lambda v: v > value, ast.GtE: lambda v: v >= value}
                return piece(option, [v for v in OPTIONS[option] if tests[type(node.ops[0])](v)])
            if (ast.unparse(other) == "khdddworld.ids_for_gates" and isinstance(node.ops[0], (ast.In, ast.NotIn))
                    and not self.uses_seed(node.left)):
                fact = recipe_in_pool(self.concrete(node.left, env))
                return fact if isinstance(node.ops[0], ast.In) else guard_not(fact)
        raise ValueError(f"unsupported option test: {ast.unparse(node)}")

    def item_code(self, name):
        data = khddd.item_data_table.get(name)
        code = self.item_codes.get(data.code) if data else None
        if code is None:
            warn(f"no tracker item for {name!r}; treating it as never obtainable")
        return code

    def location_ref(self, name):
        path = self.location_paths.get(name)
        if path is None:
            warn(f"no tracker location for {name!r}; treating it as unreachable")
            return []
        return [["@" + path]]

    def rule(self, node, env):
        """Rule combo for a rule_builder expression."""
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.BitAnd, ast.BitOr)):
            combine = product if isinstance(node.op, ast.BitAnd) else union
            return combine(self.rule(node.left, env), self.rule(node.right, env))
        if isinstance(node, ast.Call):
            return self.call_rule(node, env)
        raise ValueError(f"unsupported rule expression: {ast.unparse(node)}")

    def count_rule(self, name, node, env):
        """Rule combo for owning as many of the item as node says."""
        option = self.option_name(node)
        if option:
            helper = COUNT_HELPERS.get((name, option))
            if helper:
                return [[helper]]
            code = self.item_code(name)
            return [[f"$has_opt_count|{code}|{COUNT_OPTION_CODES[option]}"]] if code else []
        needed = self.concrete(node, env)
        code = self.item_code(name)
        return [[f"{code}:{needed}" if needed > 1 else code]] if code else []

    @staticmethod
    def is_gate_rules(node, env):
        """True for the {node: gate rule} dict: a gate_rules result, or KHDDDWorld.gate_rules before Rules.gate_rules."""
        if isinstance(node, ast.Name):
            return env.get(node.id) is GATE_RULES
        return ast.unparse(node) == "khdddworld.gate_rules"

    def call_rule(self, node, env):
        if isinstance(node.func, ast.Attribute) and node.func.attr == "get" and self.is_gate_rules(node.func.value, env):
            return [[]]
        if not isinstance(node.func, ast.Name) or node.keywords:
            raise ValueError(f"unsupported call: {ast.unparse(node)}")
        name = node.func.id
        args = node.args
        if name == "True_":
            return [[]]
        if name == "Has":
            code = self.item_code(self.concrete(args[0], env))
            return [[code]] if code else []
        if name in ("HasAny", "HasAll"):
            codes = [self.item_code(self.concrete(arg, env)) for arg in args]
            if name == "HasAny":
                return simplify([[code] for code in codes if code])
            return [] if None in codes else [codes]
        if name == "HasAllCounts":
            result = [[]]
            for key, value in zip(args[0].keys, args[0].values):
                result = product(result, self.count_rule(self.concrete(key, env), value, env))
            return result
        if name == "CanReachLocation":
            return self.location_ref(self.concrete(args[0], env))
        if name == "AtLeast":
            rules = [self.rule(arg, env) for arg in args[1:]]
            result = []
            for chosen in itertools.combinations(rules, self.concrete(args[0], env)):
                result = union(result, functools.reduce(product, chosen))
            return result
        return self.helper_rule(node, env)

    def helper_rule(self, node, env):
        name = node.func.id
        if name in HELPERS:
            return [[HELPERS[name]]]
        if name in COUNTING_HELPERS:
            return [[f"{COUNTING_HELPERS[name]}|{self.concrete(node.args[0], env)}"]]
        function = self.functions.get(name)
        if function is None:
            raise ValueError(f"unknown helper {name}")
        if len(function.body) != 1 or not isinstance(function.body[0], ast.Return):
            raise ValueError(f"helper {name} needs an entry in HELPERS")
        return self.rule(function.body[0].value, env)

    def collect(self):
        self.block(self.functions["set_rules"].body, {}, True)

    def block(self, statements, env, guard):
        """Walks statements under a path guard; returns the guard under which execution falls through."""
        for statement in statements:
            if guard is False:
                break
            if isinstance(statement, ast.If):
                guard = self.if_statement(statement, env, guard)
            elif isinstance(statement, ast.For):
                targets = statement.target.elts if isinstance(statement.target, ast.Tuple) else [statement.target]
                for value in self.concrete(statement.iter, env):
                    scope = dict(env)
                    for target, item in zip(targets, value if len(targets) > 1 else [value]):
                        scope[target.id] = item
                    self.block(statement.body, scope, guard)
            elif isinstance(statement, ast.Continue):
                return False
            elif isinstance(statement, ast.Assign) and isinstance(statement.targets[0], ast.Name):
                target = statement.targets[0].id
                if not self.uses_seed(statement.value):
                    if guard is not True:
                        raise ValueError(f"assignment under an option test: {ast.unparse(statement)}")
                    env[target] = self.concrete(statement.value, env)
                elif isinstance(statement.value, ast.Call) and ast.unparse(statement.value.func) == GATE_RULES_HELPER:
                    env[target] = GATE_RULES
                elif isinstance(statement.value, (ast.Call, ast.BinOp)):
                    env[target] = [(guard, self.rule(statement.value, env))]
            elif isinstance(statement, ast.AugAssign) and isinstance(statement.op, ast.BitAnd):
                env[statement.target.id] = env[statement.target.id] + [(guard, self.rule(statement.value, env))]
            elif isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                self.call_statement(statement.value, env, guard)
        return guard

    def if_statement(self, statement, env, guard):
        test = self.guard(statement.test, env)
        if isinstance(test, bool):
            return self.block(statement.body if test else statement.orelse, env, guard)
        body_guard = guard_and(guard, test)
        else_guard = guard_and(guard, guard_not(test))
        after_body = self.block(statement.body, env, body_guard)
        after_else = self.block(statement.orelse, env, else_guard)
        if after_body is body_guard and after_else is else_guard:
            return guard
        return guard_or(after_body, after_else)

    def call_statement(self, call, env, guard):
        if not (isinstance(call.func, ast.Attribute) and call.func.attr == "set_rule"):
            return
        target_call, rule = call.args
        kind = target_call.func.attr
        name = self.concrete(target_call.args[0], env)
        if kind == "get_location":
            target = ("location", name)
        elif kind == "get_entrance":
            target = ("entrance", name)
        else:
            raise ValueError(f"unsupported set_rule target: {ast.unparse(target_call)}")
        parts = env[rule.id] if isinstance(rule, ast.Name) else [(guard, self.rule(rule, env))]
        # set_rule replaces, so an earlier rule only holds where this statement does not run
        kept = [(guard_and(old, guard_not(guard)), combo) for old, combo in self.contributions[target]]
        self.contributions[target] = [(old, combo) for old, combo in kept if old is not False] + parts


# --- link board gates ----------------------------------------------------------------------------

def gate_contributions():
    """(location, guard, rule combo) for the gates the apworld puts on link board nodes.

    The world count of each gate is rolled per seed and reaches the tracker as slot_data gate_reqs.
    """
    for (spirit_id, gate), names in gate_nodes().items():
        for name in names:
            yield name, recipe_in_pool(spirit_id), [[f"^$board_gate|{spirit_id}|{gate}"]]


# --- existence of locations and regions per seed options -----------------------------------------

def is_superboss(name):
    return any(part in name for part in ("Secret Portal", "Ultima Weapon", "Unbound"))


def region_guard(region):
    if region.startswith("World Map"):
        return True
    if region == "Destiny Islands":
        return guard_and(piece("play_destiny_islands", {1}), piece("character", {0, 1}))
    if region == "Levels":
        return piece("stats_on_levels", {0, 1, 2})
    if "[Sora]" in region:
        return piece("character", {0, 1})
    if "[Riku]" in region:
        return piece("character", {0, 2})
    return True


def existence_guard(name, data):
    """Mirrors the skip conditions of Regions.create_regions; board nodes count as skipped without link_board_sanity,
    since place_board_filler fills them with local filler."""
    parts = []
    if data.category == "Board":
        parts.append(piece("link_board_sanity", {1}))
    if data.region == "Destiny Islands":
        parts += [piece("play_destiny_islands", {1}), piece("character", {0, 1})]
    if "Superbosses" not in name:
        character = guard_and(piece("character", {0, 2}) if "Sora" not in name else True,
                              piece("character", {0, 1}) if "Riku" not in name else True)
        if "Node" in name:
            character = guard_or(character, recipe_in_pool(khddd.Items.SPIRITLIST[name[:-8]]))
        parts.append(character)
    if "Ventus" in name:
        parts += [piece("armored_ventus_nightmare", {1}), piece("goal", {0, 2})]
    if is_superboss(name):
        parts.append(guard_or(piece("goal", {1}), piece("superbosses", {1})))
    if "All Superbosses Defeated" in name:
        parts.append(piece("goal", {1}))
    if "Lucky Emblems" in name:
        parts.append(guard_or(piece("emblem_reqs", {1}), piece("goal", {2})))
    if "Young Xehanort Defeated" in name:
        parts.append(piece("goal", {0, 2}))
    if "Lord Kyroo" in name and data.category != "Board":
        parts.append(piece("lord_kyroo", {1}))
    if "Level" in name:
        parts.append(piece("stats_on_levels", {0, 1, 2}))
    return guard_and(*parts)


def contribution_rule(guard, rule, existence):
    """`not guard or rule`, with the guard read under the location's existence conditions."""
    negated = assuming(guard_not(guard), existence)
    if negated == [{}]:
        return [[]]
    return union(option_combo_to_rules(negated), rule)


def region_chain(regions, target, start="World"):
    """Entrance names from start to target."""
    paths = {start: []}
    queue = [start]
    while queue:
        region = queue.pop(0)
        if region == target:
            return paths[region]
        for exit_name in regions[region].region_exits or []:
            if exit_name not in paths:
                paths[exit_name] = paths[region] + [exit_name]
                queue.append(exit_name)
    return None


def region_rules(region, ap_regions, translator, start="World"):
    """(access, visibility) of an AP region: its entrance chain from start and the options that create it."""
    existence = region_guard(region)
    access = [[]]
    for entrance in region_chain(ap_regions, region, start) if region in ap_regions else []:
        for guard, rule in translator.contributions.get(("entrance", entrance), []):
            access = product(access, contribution_rule(guard, rule, existence))
    return access, option_combo_to_rules(guard_combo(existence))


# --- locations.json ------------------------------------------------------------------------------

def load_mapping(path, pattern):
    return {int(m.group(1)): m.group(2) for m in re.finditer(pattern, path.read_text(encoding="utf-8"), re.M)}


def dumps(value, indent=0):
    pad = " " * indent
    inner = " " * (indent + 4)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f"{inner}{json.dumps(key, ensure_ascii=False)}: {dumps(item, indent + 4)}"
                 for key, item in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(isinstance(item, (str, int, float)) for item in value):
            return "[" + ", ".join(json.dumps(item, ensure_ascii=False) for item in value) + "]"
        return "[\n" + ",\n".join(inner + dumps(item, indent + 4) for item in value) + "\n" + pad + "]"
    return json.dumps(value, ensure_ascii=False)


def rules_json(branches):
    if any("," in text for branch in branches for text in branch):
        return [list(branch) for branch in branches]
    return [",".join(branch) for branch in branches]


MIXED = object()


def shared_rules(node, path, section_rules, shared):
    """Fills shared[path], per rule kind (access, visibility), with the rules every generated section under node has:
    None without generated sections, MIXED when they differ."""
    found = ([], [])
    for rules in section_rules.get(path, {}).values():
        for kind in (0, 1):
            found[kind].append(rules[kind])
    for child in node.get("children", []):
        child_path = path + (child["name"],)
        shared_rules(child, child_path, section_rules, shared)
        for kind in (0, 1):
            if shared[child_path][kind] is not None:
                found[kind].append(shared[child_path][kind])
    shared[path] = tuple(
        None if not values else values[0] if all(value is not MIXED and value == values[0] for value in values)
        else MIXED
        for values in found)


def place_rules(node, path, section_rules, shared, held=(False, False)):
    """Puts each generated rule on the highest location below the top level whose generated sections all share it."""
    rules = [None, None]
    held = list(held)
    for kind in (0, 1):
        if not held[kind] and shared[path][kind] not in (None, MIXED):
            rules[kind] = nontrivial(shared[path][kind])
            held[kind] = True
    set_rules(node, *rules)
    for section in node.get("sections", []):
        own = section_rules.get(path, {}).get(section.get("name"))
        if own is not None:
            set_rules(section, *(None if held[kind] else nontrivial(own[kind]) for kind in (0, 1)))
    for child in node.get("children", []):
        place_rules(child, path + (child["name"],), section_rules, shared, held)


def nontrivial(rules):
    return None if rules == [[]] else rules


def set_rules(node, access, visibility):
    """Rebuilds node with rule keys right after name; None removes the key."""
    rebuilt = {"name": node["name"]}
    if access:
        rebuilt["access_rules"] = rules_json(access)
    if visibility:
        rebuilt["visibility_rules"] = rules_json(visibility)
    for key, value in node.items():
        if key not in ("name", "access_rules", "visibility_rules"):
            rebuilt[key] = value
    node.clear()
    node.update(rebuilt)


def level_sort_key(node):
    match = re.fullmatch(r"(Sora|Riku) Level (\d+)", node["name"])
    return (0 if match.group(1) == "Sora" else 1, int(match.group(2))) if match else (2, 0)


def child_sort_key(parent):
    """Order for the children of the location at path parent when one is added; None keeps insertion order."""
    if parent == ["Levels"]:
        return level_sort_key
    if len(parent) == 2 and parent[0] == BOARD_ROOT:  # the spirit's overview, then its gate segments
        return lambda node: (node["name"] != parent[1], node["name"] != OPEN_SEGMENT, node["name"])
    return None


def tree_node(tree, names):
    """The location at path names, adding missing ones."""
    siblings = tree
    for depth, name in enumerate(names):
        node = next((child for child in siblings if child["name"] == name), None)
        if node is None:
            print(f"adding {'/'.join(names[:depth + 1])}")
            node = {"name": name}
            siblings.append(node)
            if key := child_sort_key(names[:depth]):
                siblings.sort(key=key)
        if depth + 1 < len(names):
            siblings = node.setdefault("children", [])
    return node


def board_overviews(location_paths):
    """Ref sections for each spirit's overview location, named by AP name so Universal Tracker matches them."""
    overviews = defaultdict(list)
    for name, path in location_paths.items():
        root, spirit, *_ = path.split("/")
        if root == BOARD_ROOT:
            overviews[(root, spirit, spirit)].append({"name": name, "ref": path})
    return overviews


def remove_stale_sections(nodes, location_paths, prefix=""):
    """Drops AP-named sections away from their mapped path, which Universal Tracker would match as well, and the
    locations they leave empty unless those hold map_locations; returns the dropped section paths."""
    removed = []
    for node in list(nodes):
        path = prefix + node["name"]
        sections = node.get("sections", [])
        kept = [section for section in sections if "ref" in section or section.get("name") not in location_paths
                or location_paths[section["name"]] == f"{path}/{section['name']}"]
        removed += [f"{path}/{section['name']}" for section in sections if section not in kept]
        removed += remove_stale_sections(node.get("children", []), location_paths, path + "/")
        if len(kept) < len(sections):
            node["sections"] = kept
            if not kept and not node.get("children"):
                if "map_locations" in node:
                    warn(f"{path!r} lost all its sections but keeps map_locations; move them by hand")
                else:
                    nodes.remove(node)
    return removed


def descendants(nodes):
    for node in nodes:
        yield node
        yield from descendants(node.get("children", []))


def main():
    khddd.Regions.set_region_table()
    ap_regions = khddd.Regions.region_data_table  # rebound by set_region_table; the package's copy stays empty
    item_codes = load_mapping(ITEM_MAPPING, r'^\s*\[(\d+)\]\s*=\s*\{\s*\{\s*"([^"]+)"')
    section_paths = load_mapping(LOCATION_MAPPING, r'^\s*\[(\d+)\]\s*=\s*\{\s*\{\s*"@([^"]+)"')
    folded = tracker_regions()
    location_paths = {}
    for name, data in khddd.location_data_table.items():
        if data.code is None:  # no AP id; hidden sections that board_gate counts
            location_paths[name] = f"{folded[data.region]}/{EVENT_LOCATION}/{name}"
            continue
        path = section_paths.get(data.code)
        if path is None:
            warn(f"{name!r} ({data.code}) is missing from location_mapping.lua; rerun gen_location_mapping.py")
        else:
            location_paths[name] = path
    world_events = {location_paths[name]
                    for name in khddd.location_name_groups["Sora Worlds"] | khddd.location_name_groups["Riku Worlds"]}
    listed = set(re.findall(rf'"@([^"]+/{EVENT_LOCATION}/[^"]+)"', LOGIC_LUA.read_text(encoding="utf-8")))
    for path in sorted(world_events - listed):
        warn(f"{path!r} is missing from WORLD_EVENTS in logic.lua")
    for path in sorted(listed - world_events):
        warn(f"{path!r} is in WORLD_EVENTS in logic.lua but not the apworld's world groups")

    tree = json.loads(LOCATIONS_JSON.read_text(encoding="utf-8"))
    for path in remove_stale_sections(tree, location_paths):
        print(f"removing {path}")
    for path in location_paths.values():
        *names, section_name = path.split("/")
        sections = tree_node(tree, names).setdefault("sections", [])
        if not any(section.get("name") == section_name for section in sections):
            sections.append({"name": section_name})
    for names, refs in board_overviews(location_paths).items():
        tree_node(tree, list(names))["sections"] = refs

    translator = Translator(item_codes, location_paths)
    translator.collect()
    for name, guard, rule in gate_contributions():
        translator.contributions[("location", name)].append((guard, rule))

    top_level = {node["name"] for node in tree}
    regions = {region: region_rules(region, ap_regions, translator) for region in top_level}
    for node in tree:
        access, visibility = regions[node["name"]]
        set_rules(node, nontrivial(access), nontrivial(visibility))

    section_rules = defaultdict(dict)  # location path -> section -> (access, visibility)
    for name, data in khddd.location_data_table.items():
        path = location_paths.get(name)
        if path is None:
            continue
        *names, section_name = path.split("/")
        existence = existence_guard(name, data)
        access = [[]]
        for guard, rule in translator.contributions.get(("location", name), []):
            access = product(access, contribution_rule(guard, rule, existence))
        if not access:
            raise ValueError(f"{name!r} ended up unreachable under every option")
        if names[0] == data.region:
            visibility = option_combo_to_rules(assuming(existence, region_guard(data.region)))
        else:  # the top-level location carries only the rules down to start, an enclosing region or World
            start = names[0] if folded[data.region] == names[0] else "World"
            access = product(region_rules(data.region, ap_regions, translator, start)[0], access)
            visibility = option_combo_to_rules(
                assuming(guard_and(region_guard(data.region), existence), region_guard(start)))
        sections = section_rules[tuple(names)]
        if section_name in sections:
            warn(f"{name!r} shares the tracker section {path} with another location; rules are ANDed")
            other_access, other_visibility = sections[section_name]
            access, visibility = product(other_access, access), union(other_visibility, visibility)
        sections[section_name] = (access, visibility)
    shared = {}
    for node in tree:
        for child in node.get("children", []):
            path = (node["name"], child["name"])
            shared_rules(child, path, section_rules, shared)
            place_rules(child, path, section_rules, shared)

    chained = {entrance for region in top_level | {data.region for data in khddd.location_data_table.values()}
               if region in ap_regions for entrance in region_chain(ap_regions, region)}
    for kind, name in translator.contributions:
        if kind == "location" and name not in location_paths:
            warn(f"rules for {name!r} were dropped (no tracker location)")
        if kind == "entrance" and name not in chained:
            warn(f"rules for entrance {name!r} were dropped (no tracker location behind it)")

    LOCATIONS_JSON.write_text(dumps(tree) + "\n", encoding="utf-8", newline="\n")
    rule_count = sum("access_rules" in child for node in tree for child in descendants(node.get("children", [])))
    print(f"wrote {LOCATIONS_JSON.name}: {rule_count} locations with access rules, {len(WARNINGS)} warnings")


if __name__ == "__main__":
    main()
