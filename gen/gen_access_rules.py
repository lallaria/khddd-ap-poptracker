"""Generates access_rules and visibility_rules in locations/locations.json from the apworld's Rules.py.

Usage: <source>/Archipelago/venv/Scripts/python gen/gen_access_rules.py

Run it with the venv inside the Archipelago checkout that holds worlds/khddd.
"""
from __future__ import annotations

import ast
import atexit
import inspect
import itertools
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(sys.prefix).parent))  # the venv sits in the Archipelago checkout

from worlds import khddd

atexit.unregister(input)  # some apworlds register an exit prompt on import

REPO = Path(__file__).resolve().parent.parent
LOCATIONS_JSON = REPO / "locations" / "locations.json"
LOCATION_MAPPING = REPO / "scripts" / "autotracking" / "location_mapping.lua"
ITEM_MAPPING = REPO / "scripts" / "autotracking" / "item_mapping.lua"

# option -> value domain; emblem_reqs is folded to 0 / "1 or more"
OPTIONS = {
    "character": (0, 1, 2),
    "goal": (0, 1, 2),
    "superbosses": (0, 1),
    "lord_kyroo": (0, 1),
    "armored_ventus_nightmare": (0, 1),
    "fast_go_mode": (0, 1),
    "play_destiny_islands": (0, 1),
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
# helpers whose body iterates a list of location names that must all be reachable
REACH_ALL_HELPERS = {"can_access_sora_portals", "can_access_riku_portals"}

ALL_OPTION_COMBOS = [dict(zip(OPTIONS, values)) for values in itertools.product(*OPTIONS.values())]
CODE_OPTION_VALUE = {code: (option, value) for option, codes in ENUM_CODES.items() for value, code in codes.items()}

WARNINGS = []


def warn(message):
    WARNINGS.append(message)
    print("warning:", message)


# --- guards: boolean trees over option pieces ------------------------------------------------------

def piece(option, allowed):
    return ("piece", option, frozenset(allowed) & set(OPTIONS[option]))


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
        merged[option] = merged.get(option, frozenset(OPTIONS[option])) & allowed
        if not merged[option]:
            return None
    return merged


def simplify_option_combo(branches):
    cleaned = []
    for branch in branches:
        branch = {option: allowed for option, allowed in branch.items() if allowed != frozenset(OPTIONS[option])}
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
        allowed = guard[2] if not negate else frozenset(OPTIONS[guard[1]]) - guard[2]
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
    domain = frozenset(OPTIONS[option])
    if allowed == domain:
        return [[]]
    if not allowed:
        return []
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


def assuming(guard, assumption):
    """Simplifies guard to its meaning under assumption: drops entailed pieces and impossible branches."""
    combos = [opts for opts in ALL_OPTION_COMBOS if guard_eval(assumption, opts)]
    feasible = {option: frozenset(opts[option] for opts in combos) for option in OPTIONS}
    result = []
    for branch in guard_combo(guard):
        if not any(all(opts[option] in allowed for option, allowed in branch.items()) for opts in combos):
            continue
        kept = {}
        for option, allowed in branch.items():
            if not feasible[option] <= allowed:
                kept[option] = allowed & feasible[option]
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
    if text.startswith(("$", "@")):
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
        namespace = {"location_data_table": khddd.location_data_table, "str": str, "range": range, "len": len}
        namespace.update(env)
        return eval(compile(ast.Expression(node), "Rules.py", "eval"), {"__builtins__": {}}, namespace)

    @staticmethod
    def uses_options(node):
        return any(isinstance(child, ast.Name) and child.id == "options" for child in ast.walk(node))

    @staticmethod
    def option_name(node):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "options":
            return node.attr
        return None

    def guard(self, node, env):
        """Guard tree for a test expression; concrete sub-expressions collapse to booleans."""
        if not self.uses_options(node):
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
            if option and not self.uses_options(other):
                value = self.concrete(other, env)
                tests = {ast.Eq: lambda v: v == value, ast.NotEq: lambda v: v != value, ast.Lt: lambda v: v < value,
                         ast.LtE: lambda v: v <= value, ast.Gt: lambda v: v > value, ast.GtE: lambda v: v >= value}
                return piece(option, [v for v in OPTIONS[option] if tests[type(node.ops[0])](v)])
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
        """Rule combo for a lambda body or helper return expression."""
        if isinstance(node, ast.BoolOp):
            parts = [self.rule(value, env) for value in node.values]
            result = parts[0]
            for part in parts[1:]:
                result = product(result, part) if isinstance(node.op, ast.And) else union(result, part)
            return result
        if isinstance(node, ast.Constant) and isinstance(node.value, bool):
            return [[]] if node.value else []
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            return self.count_rule(node, env)
        if isinstance(node, ast.Call):
            return self.call_rule(node, env)
        raise ValueError(f"unsupported rule expression: {ast.unparse(node)}")

    def count_rule(self, node, env):
        call = node.left
        if not (isinstance(call, ast.Call) and self.method_name(call) == "count"):
            raise ValueError(f"unsupported comparison: {ast.unparse(node)}")
        name = self.concrete(call.args[0], env)
        other = node.comparators[0]
        op = node.ops[0]
        option = self.option_name(other)
        if option:
            if not isinstance(op, ast.GtE):
                raise ValueError(f"unsupported option comparison: {ast.unparse(node)}")
            helper = COUNT_HELPERS.get((name, option))
            if helper:
                return [[helper]]
            code = self.item_code(name)
            return [[f"$has_opt_count|{code}|{COUNT_OPTION_CODES[option]}"]] if code else []
        value = self.concrete(other, env)
        if isinstance(op, ast.Gt):
            needed = value + 1
        elif isinstance(op, ast.GtE):
            needed = value
        else:
            raise ValueError(f"unsupported comparison: {ast.unparse(node)}")
        code = self.item_code(name)
        return [[f"{code}:{needed}" if needed > 1 else code]] if code else []

    def names(self, node, env):
        """Item names of a set/list literal in source order (set iteration order is randomized)."""
        if isinstance(node, (ast.Set, ast.List, ast.Tuple)):
            return [self.concrete(element, env) for element in node.elts]
        return sorted(self.concrete(node, env))

    @staticmethod
    def method_name(call):
        func = call.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "state":
            return func.attr
        return None

    def call_rule(self, node, env):
        method = self.method_name(node)
        if method == "has":
            code = self.item_code(self.concrete(node.args[0], env))
            return [[code]] if code else []
        if method in ("has_any", "has_all"):
            codes = [self.item_code(name) for name in self.names(node.args[0], env)]
            if method == "has_any":
                return simplify([[code] for code in codes if code])
            return [] if None in codes else [codes]
        if method == "can_reach_location":
            return self.location_ref(self.concrete(node.args[0], env))
        if method == "can_reach":
            target = node.args[0]
            if isinstance(target, ast.Call) and isinstance(target.func, ast.Attribute) and target.func.attr == "get_location":
                return self.location_ref(self.concrete(target.args[0], env))
        if isinstance(node.func, ast.Name):
            return self.helper_rule(node, env)
        raise ValueError(f"unsupported call: {ast.unparse(node)}")

    def helper_rule(self, node, env):
        name = node.func.id
        if name in HELPERS:
            return [[HELPERS[name]]]
        if name in COUNTING_HELPERS:
            return [[f"{COUNTING_HELPERS[name]}|{self.concrete(node.args[2], env)}"]]
        function = self.functions.get(name)
        if function is None:
            raise ValueError(f"unknown helper {name}")
        if name in REACH_ALL_HELPERS:
            names = next(self.concrete(child, {}) for child in ast.walk(function)
                         if isinstance(child, ast.List) and child.elts
                         and all(isinstance(element, ast.Constant) for element in child.elts))
            result = [[]]
            for location in names:
                result = product(result, self.location_ref(location))
            return result
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
        if not (isinstance(call.func, ast.Name) and call.func.id == "add_rule"):
            return
        target_call, rule = call.args
        kind = target_call.func.attr
        name = self.concrete(target_call.args[0], env)
        if kind == "get_location":
            target = ("location", name)
        elif kind == "get_entrance":
            target = ("entrance", name)
        else:
            raise ValueError(f"unsupported add_rule target: {ast.unparse(target_call)}")
        self.contributions[target].append((guard, self.rule(rule.body, env)))


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


def existence_guard(name, region):
    """Mirrors the skip conditions of Regions.create_regions."""
    parts = []
    if region == "Destiny Islands":
        parts += [piece("play_destiny_islands", {1}), piece("character", {0, 1})]
    if "Superbosses" not in name:
        if "Sora" not in name:
            parts.append(piece("character", {0, 2}))
        if "Riku" not in name:
            parts.append(piece("character", {0, 1}))
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
    if "Lord Kyroo" in name:
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


def region_chain(regions, target):
    """Entrance names from the origin region to target."""
    paths = {"World": []}
    queue = ["World"]
    while queue:
        region = queue.pop(0)
        if region == target:
            return paths[region]
        for exit_name in regions[region].region_exits or []:
            if exit_name not in paths:
                paths[exit_name] = paths[region] + [exit_name]
                queue.append(exit_name)
    return None


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


def main():
    khddd.Regions.set_region_table()
    ap_regions = khddd.Regions.region_data_table  # rebound by set_region_table; the package's copy stays empty
    item_codes = load_mapping(ITEM_MAPPING, r'^\s*\[(\d+)\]\s*=\s*\{\s*\{\s*"([^"]+)"')
    section_paths = load_mapping(LOCATION_MAPPING, r'^\s*\[(\d+)\]\s*=\s*\{\s*\{\s*"@([^"]+)"')
    location_paths = {}
    for name, data in khddd.location_data_table.items():
        path = section_paths.get(data.code)
        if path is None:
            warn(f"{name!r} ({data.code}) is missing from location_mapping.lua; rerun gen_location_mapping.py")
        else:
            location_paths[name] = path

    tree = json.loads(LOCATIONS_JSON.read_text(encoding="utf-8"))
    regions = {node["name"]: node for node in tree}
    for name in location_paths:
        region_name, node_name = location_paths[name].split("/")[:2]
        if region_name not in regions:
            regions[region_name] = {"name": region_name, "children": []}
            tree.append(regions[region_name])
        children = regions[region_name].setdefault("children", [])
        if not any(child["name"] == node_name for child in children):
            print(f"adding {region_name}/{node_name}")
            children.append({"name": node_name, "sections": [{"name": node_name}]})
            if region_name == "Levels":
                children.sort(key=level_sort_key)

    translator = Translator(item_codes, location_paths)
    translator.collect()

    for node in tree:
        region_name = node["name"]
        chain = region_chain(ap_regions, region_name) if region_name in ap_regions else []
        existence = region_guard(region_name)
        access = [[]]
        for entrance in chain:
            for guard, rule in translator.contributions.get(("entrance", entrance), []):
                access = product(access, contribution_rule(guard, rule, existence))
        visibility = option_combo_to_rules(guard_combo(existence))
        set_rules(node, access if access != [[]] else None, visibility if visibility != [[]] else None)

    nodes_by_path = {(node["name"], child["name"]): child for node in tree for child in node.get("children", [])}
    for node in nodes_by_path.values():
        set_rules(node, None, None)
    handled = set()
    for name, data in khddd.location_data_table.items():
        path = location_paths.get(name)
        if path is None:
            continue
        key = tuple(path.split("/")[:2])
        if key in handled:
            warn(f"{name!r} shares the tracker node {key} with another location; rules are ANDed")
        handled.add(key)
        existence = existence_guard(name, data.region)
        access = [[]]
        for guard, rule in translator.contributions.get(("location", name), []):
            access = product(access, contribution_rule(guard, rule, existence))
        if not access:
            raise ValueError(f"{name!r} ended up unreachable under every option")
        visibility = option_combo_to_rules(assuming(existence, region_guard(data.region)))
        node = nodes_by_path[key]
        set_rules(node, access if access != [[]] else node.get("access_rules"),
                  visibility if visibility != [[]] else node.get("visibility_rules"))

    for kind, name in translator.contributions:
        if kind == "location" and name not in location_paths:
            warn(f"rules for {name!r} were dropped (no tracker location)")
        if kind == "entrance" and name not in regions:
            warn(f"rules for entrance {name!r} were dropped (no top-level node)")

    LOCATIONS_JSON.write_text(dumps(tree) + "\n", encoding="utf-8", newline="\n")
    rule_count = sum(1 for node in tree for child in node.get("children", []) if "access_rules" in child)
    print(f"wrote {LOCATIONS_JSON.name}: {rule_count} locations with access rules, {len(WARNINGS)} warnings")


if __name__ == "__main__":
    main()
