"""Generates the Link Boards grid: its map image, gate overlays, canvas layout, spirit table and map markers.

Also writes Universal Tracker's copy of the grid, with names and portraits drawn in since UT can't draw the canvas,
and `maps/ut_maps.json`, which the apworld reads in place of `maps/maps.json`.

Usage: <source>/Archipelago/venv/Scripts/python gen/gen_link_board_grid.py

Run it with the venv inside the Archipelago checkout that holds worlds/khddd.
"""
import json
import re

from PIL import Image, ImageDraw, ImageFont

from gen_access_rules import ITEM_MAPPING, LOCATIONS_JSON, REPO, dumps, khddd, load_mapping
from gen_location_mapping import BOARD_ROOT

MAPS_JSON = REPO / "maps" / "maps.json"
UT_MAPS_JSON = REPO / "maps" / "ut_maps.json"
GRID_IMAGE = REPO / "images" / "maps" / "Link_Boards.png"
UT_GRID_IMAGE = REPO / "images" / "maps" / "Link_Boards_UT.png"
SPIRITS = REPO / "images" / "spirits"
LAYOUT = REPO / "layouts" / "link_boards.json"
SPIRIT_TABLE = REPO / "scripts" / "link_board_spirits.lua"
LAYOUT_KEY = "link_board_grid"

COLUMNS = 7
CELL_WIDTH, CELL_HEIGHT = 116, 102
LINE_WIDTH = 2
BACKGROUND, LINE = "#040c24", "#2c3e66"
NAME_OFFSET, NAME_SIZE, NAME_COLOUR = (6, 4), 14, "white"
PORTRAIT_OFFSET, PORTRAIT_SIZE = (28, 22), 72
# marker centre; PopTracker draws its border outside the square, so it needs room from the grid lines
MARKER_OFFSET, MARKER_SIZE, MARKER_BORDER = (14, 86), 16, 2
GATE_SIZE, GATE_PADDING = 56, 2


def overlay_name(gates, open_gates):
    """Matches the overlay names `scripts/link_board_grid.lua` builds."""
    parts = [f"{open_gates}_open"] if open_gates else []
    if gates > open_gates:
        parts.append(f"{gates - open_gates}_closed")
    return "_".join(parts)


def spirits(boards):
    """[(spirit id, name, recipe code, gate count)] in spirit id order; gates are the spirit's `Gate N` segments."""
    item_codes = load_mapping(ITEM_MAPPING, r'^\s*\[(\d+)\]\s*=\s*\{\s*\{\s*"([^"]+)"')
    return [(spirit_id, name, item_codes[khddd.Items.item_table[f"{name} Recipe"]],
             sum(1 for child in boards[name]["children"] if re.fullmatch(r"Gate \d+", child["name"])))
            for name, spirit_id in sorted(khddd.Items.SPIRITLIST.items(), key=lambda pair: pair[1])]


def cell(index):
    return index % COLUMNS * CELL_WIDTH, index // COLUMNS * CELL_HEIGHT


def grid_image(rows):
    width, height = COLUMNS * CELL_WIDTH, rows * CELL_HEIGHT
    image = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(image)
    for column in range(COLUMNS + 1):
        x = min(max(column * CELL_WIDTH - LINE_WIDTH // 2, 0), width - LINE_WIDTH)
        draw.rectangle((x, 0, x + LINE_WIDTH - 1, height - 1), fill=LINE)
    for row in range(rows + 1):
        y = min(max(row * CELL_HEIGHT - LINE_WIDTH // 2, 0), height - LINE_WIDTH)
        draw.rectangle((0, y, width - 1, y + LINE_WIDTH - 1), fill=LINE)
    return image


def ut_grid_image(table, rows):
    image = grid_image(rows).convert("RGBA")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(NAME_SIZE)
    for index, (spirit_id, name, _, _) in enumerate(table):
        x, y = cell(index)
        draw.text((x + NAME_OFFSET[0], y + NAME_OFFSET[1]), name, fill=NAME_COLOUR, font=font)
        portrait = Image.open(SPIRITS / f"{spirit_id}.png").convert("RGBA")
        image.alpha_composite(portrait.resize((PORTRAIT_SIZE, PORTRAIT_SIZE), Image.LANCZOS),
                              (x + PORTRAIT_OFFSET[0], y + PORTRAIT_OFFSET[1]))
    return image.convert("RGB")


def gate_overlays(gate_counts):
    """Portrait-sized transparent images with the gates in the bottom-right corner, open gates first.

    PopTracker's overlay mod pastes the image unscaled at the portrait's origin, so it must match the portrait size.
    """
    size = Image.open(SPIRITS / "1.png").size
    tiles = {state: Image.open(SPIRITS / f"gate_{state}.png").convert("RGBA").resize((GATE_SIZE, GATE_SIZE), Image.LANCZOS)
             for state in ("open", "closed")}
    for gates in gate_counts:
        for open_gates in range(gates + 1):
            states = ["open"] * open_gates + ["closed"] * (gates - open_gates)
            image = Image.new("RGBA", size, (0, 0, 0, 0))
            for slot, state in enumerate(reversed(states)):
                left = size[0] - (slot + 1) * (GATE_SIZE + GATE_PADDING)
                image.alpha_composite(tiles[state], (left, size[1] - GATE_SIZE - GATE_PADDING))
            image.save(SPIRITS / f"gates_{overlay_name(gates, open_gates)}.png", optimize=True)


def layout(table, rows):
    """The grid canvas, docked so no parent stretches it: the map would scale while the items stay in place."""
    content = [{"type": "map", "maps": [BOARD_ROOT]}]
    for index, (spirit_id, name, _, _) in enumerate(table):
        x, y = cell(index)
        content.append({"type": "text", "text": name,
                        "canvas_left": x + NAME_OFFSET[0], "canvas_top": y + NAME_OFFSET[1]})
        content.append({"type": "item", "item": f"link_board_spirit_{spirit_id}",
                        "canvas_left": x + PORTRAIT_OFFSET[0], "canvas_top": y + PORTRAIT_OFFSET[1],
                        "width": PORTRAIT_SIZE, "height": PORTRAIT_SIZE})
    canvas = {"type": "canvas", "dock": "left", "width": COLUMNS * CELL_WIDTH, "height": rows * CELL_HEIGHT,
              "content": content}
    filler = {"type": "text", "text": ""}
    return {LAYOUT_KEY: {"type": "dock", "content": [{"type": "dock", "dock": "top", "content": [canvas, filler]},
                                                     filler]}}


def place_markers(table, boards):
    """One marker per spirit, on its overview location; gate segments are only reached through its refs."""
    for index, (_, name, _, _) in enumerate(table):
        x, y = cell(index)
        for child in boards[name]["children"]:
            if child["name"] == name:
                child["map_locations"] = [{"map": BOARD_ROOT, "x": x + MARKER_OFFSET[0], "y": y + MARKER_OFFSET[1]}]
            else:
                child.pop("map_locations", None)


def set_map():
    maps = json.loads(MAPS_JSON.read_text(encoding="utf-8"))
    board_map = next(entry for entry in maps if entry["name"] == BOARD_ROOT)
    board_map.update(location_size=MARKER_SIZE, location_border_thickness=MARKER_BORDER, location_shape="rect",
                     img=GRID_IMAGE.relative_to(REPO).as_posix())
    MAPS_JSON.write_text(dumps(maps) + "\n", encoding="utf-8", newline="\n")
    board_map["img"] = UT_GRID_IMAGE.relative_to(REPO).as_posix()
    UT_MAPS_JSON.write_text(dumps(maps) + "\n", encoding="utf-8", newline="\n")


def spirit_table(table):
    rows = [f"    {{ id = {spirit_id}, name = {json.dumps(name)}, recipe = {json.dumps(recipe)}, gates = {gates} }},"
            for spirit_id, name, recipe, gates in table]
    return "-- generated by gen/gen_link_board_grid.py\nLINK_BOARD_SPIRITS = {\n" + "\n".join(rows) + "\n}\n"


def main():
    tree = json.loads(LOCATIONS_JSON.read_text(encoding="utf-8"))
    boards = {node["name"]: node for node in next(n for n in tree if n["name"] == BOARD_ROOT)["children"]}
    table = spirits(boards)
    rows = -(-len(table) // COLUMNS)
    grid_image(rows).save(GRID_IMAGE, optimize=True)
    ut_grid_image(table, rows).save(UT_GRID_IMAGE, optimize=True)
    gate_overlays(sorted({gates for *_, gates in table}))
    LAYOUT.write_text(dumps(layout(table, rows)) + "\n", encoding="utf-8", newline="\n")
    SPIRIT_TABLE.write_text(spirit_table(table), encoding="utf-8", newline="\n")
    place_markers(table, boards)
    LOCATIONS_JSON.write_text(dumps(tree) + "\n", encoding="utf-8", newline="\n")
    set_map()
    print(f"wrote the Link Boards grid: {len(table)} spirits in {rows} rows of {COLUMNS}")


if __name__ == "__main__":
    main()
