"""Generates scripts/autotracking/location_mapping.lua from the apworld's Locations.py.

Usage: <source>/Archipelago/venv/Scripts/python gen/gen_location_mapping.py

Run it with the venv inside the Archipelago checkout that holds worlds/khddd.
"""
import atexit
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.prefix).parent))  # the venv sits in the Archipelago checkout

from worlds import khddd

atexit.unregister(input)  # some apworlds register an exit prompt on import


def section_name(ap_name, region):
    """Tracker section name for an AP location: the AP name without world prefix and character tags."""
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
    "Other",
]


def main():
    categories = {}
    for ap_name, data in khddd.location_data_table.items():
        section = section_name(ap_name, data.region)
        categories.setdefault(get_category(data.code, data.region, ap_name), []).append(
            (data.code, data.region, section))

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
        for code, region, section in sorted(categories[category]):
            lines.append(f'\t[{code}] = {{ {{ "@{region}/{section}/{section}" }} }},')
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
