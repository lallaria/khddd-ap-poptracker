"""Generates scripts/autotracking/location_mapping.lua from the apworld's Locations.py.

Usage: <source>/Archipelago/venv/Scripts/python gen/gen_location_mapping.py

Run it with the venv inside the Archipelago checkout that holds worlds/khddd.
"""
import atexit
import os
import random
import re
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(sys.prefix).parent))  # the venv sits in the Archipelago checkout

from worlds import khddd

atexit.unregister(input)  # some apworlds register an exit prompt on import

BOARD_ROOT = "Link Boards"
OPEN_SEGMENT = "Open"


class GateRecorder:
    """Stands in for KHDDDWorld while its gate code runs; on apworlds before Rules.gated_nodes, records the nodes
    each KHDDDWorld.set_gate_rules call covers."""

    player = 0
    re_gen_gate_reqs = regen_gate_reqs = []  # only set when UT regenerates a seed

    def __init__(self):
        value = SimpleNamespace(value=1)
        self.options = SimpleNamespace(character=value, min_gate_req=value, max_gate_req=value)
        self.random = random.Random(0)
        self.ids_for_gates = list(khddd.Items.SPIRITLIST.values())
        self.nodes = {}  # (spirit id, gate number from 1) -> location names
        self.gate_rules = {}

    def set_gate_rules(self, spirit_name, gate_index, character, world_req):
        self.gate_rules = {}
        khddd.KHDDDWorld.set_gate_rules(self, spirit_name, gate_index, character, world_req)
        self.nodes[(khddd.Items.SPIRITLIST[spirit_name], gate_index + 1)] = list(self.gate_rules)


def gate_nodes():
    """{(spirit id, gate number from 1): link board node names} for the gates KHDDDWorld.get_gate_requirements rolls,
    covering the nodes Rules.gated_nodes puts behind each."""
    recorder = GateRecorder()
    gate_reqs = khddd.KHDDDWorld.get_gate_requirements(recorder)
    try:
        gated_nodes = khddd.Rules.gated_nodes
    except AttributeError:
        return recorder.nodes
    nodes = {}
    for spirit_id, _, *world_reqs in gate_reqs:
        spirit = khddd.Items.get_spirit_by_id(spirit_id)
        for gate in range(len(world_reqs)):
            nodes[(spirit_id, gate + 1)] = [f"{spirit} Node {node + 1:02d}" for node in gated_nodes(spirit, gate)]
    return nodes


def location_name(ap_name, region):
    """Tracker location name for an AP location: the AP name without world prefix and character tags."""
    world = re.sub(r"\s*\[(?:Sora|Riku)\]$", "", region).strip()
    name = ap_name
    if name.startswith(world + " "):
        name = name[len(world) + 1:]
    name = re.sub(r"\s*\[Sora\]\s*\[Riku\]\s*$", "", name)
    name = re.sub(r"\s*\[(?:Sora|Riku)\]\s*$", "", name)
    return name.strip()


def get_category(code, region, name):
    if 2680000 <= code < 2690000:
        return "Secret Portals"
    if 2690000 <= code < 2700000:
        return "Link Boards"
    if region == "Levels":
        return "Levels"
    if "Lord Kyroo" in name:
        return "Lord Kyroo"
    if "Traverse Town 2" in region:
        return "TT2 Rewards"
    if region.startswith("World Map"):
        return "Special Rewards"
    if 2670000 <= code < 2680000:
        if "[Sora]" in region or region == "Destiny Islands":
            return "Sora Events"
        return "Riku Events"
    if 2650000 <= code < 2660000:
        if "[Riku]" in region:
            return "Riku Chests"
        return "Sora Chests"
    return "Other"


def tracker_path(ap_name, region, category, segments):
    """@Region/Location/Section for an AP location; link board nodes are sections of their gate segment,
    @Link Boards/<Spirit>/<Segment>/<Node>.

    Sections keep the exact AP name: Universal Tracker matches them to AP locations by it.
    """
    if category == "Link Boards":
        spirit = ap_name.rpartition(" Node ")[0]
        return f"@{BOARD_ROOT}/{spirit}/{segments.get(ap_name, OPEN_SEGMENT)}/{ap_name}"
    return f"@{region}/{location_name(ap_name, region)}/{ap_name}"


CATEGORY_ORDER = [
    "Secret Portals",
    "Sora Events",
    "Riku Events",
    "TT2 Rewards",
    "Special Rewards",
    "Sora Chests",
    "Riku Chests",
    "Lord Kyroo",
    "Levels",
    "Link Boards",
    "Other",
]


def main():
    segments = {name: f"Gate {gate}" for (_, gate), names in gate_nodes().items() for name in names}
    categories = {}
    for ap_name, data in khddd.location_data_table.items():
        if data.code is None:  # events have no AP id
            continue
        category = get_category(data.code, data.region, ap_name)
        path = tracker_path(ap_name, data.region, category, segments)
        categories.setdefault(category, []).append((data.code, path))

    lines = [
        "-- use this file to map the AP location ids to your locations",
        "-- first value is the code of the target location/item and the second is the item type override",
        "-- to reference a location in Pop use @ in the beginning and then path to the section",
        "-- path format: @Region/Section Name",
        "-- (more info: https://github.com/black-sliver/PopTracker/blob/master/doc/PACKS.md#locations)",
        "",
        "BASE_LOCATION_ID = 0",
        "LOCATION_MAPPING = {",
    ]
    for category in CATEGORY_ORDER:
        if category not in categories:
            continue
        pad_inner = 40 - len(category) - 2
        pad_left = pad_inner // 2
        border = "-- " + "#" * 40
        lines.append("\t" + border)
        lines.append("\t-- " + "#" * pad_left + f" {category} " + "#" * (pad_inner - pad_left))
        lines.append("\t" + border)
        for code, path in sorted(categories[category]):
            lines.append(f'\t[{code}] = {{ {{ "{path}" }} }},')
        lines.append("")
    lines.append("}")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_path = os.path.join(repo_root, "scripts", "autotracking", "location_mapping.lua")
    with open(output_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Generated {sum(len(v) for v in categories.values())} location mappings -> {output_path}")
    for category in CATEGORY_ORDER:
        if category in categories:
            print(f"  {category}: {len(categories[category])} entries")


if __name__ == "__main__":
    main()
