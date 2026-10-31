"""Cuts the settings, movement and spirit icons, spirit portraits and the link board map out of the game's UI atlases.

Usage: .venv/Scripts/python gen/gen_icons.py path/to/atlas/folder [path/to/LuckyEmblem.dds]

"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "images" / "items"
LINK_BOARDS_MAP = REPO / "images" / "maps" / "Link_Boards.png"
SPIRITS = REPO / "images" / "spirits"
FONT = "C:/Windows/Fonts/KHMenu.otf"
TILE = 128
SPIRIT_CELL = 160
SPIRIT_COLUMNS = 12
SPIRIT_COUNT = 54
GATE_TILE = 64
GATE_OPEN_COLOR = (225, 40, 40, 255)
GATE_CLOSED_COLOR = (150, 150, 160, 255)

SPRITES = {
    "switch_on": ("US_pt_status.png", (332, 392, 375, 435)),
    "switch_off": ("US_pt_status.png", (393, 392, 440, 435)),
    "sword": ("US_pt_status.png", (460, 392, 503, 435)),
    "dark_star": ("US_pt_status.png", (908, 392, 951, 435)),
    "sora": ("US_shop.png", (864, 211, 1006, 348)),
    "riku": ("US_shop.png", (877, 385, 991, 505)),
    "boot": ("US_icon.dds", (411, 153, 490, 236)),
    "flow_arrow": ("US_icon.dds", (789, 152, 883, 238)),
    "recipe": ("US_icon.dds", (23, 279, 110, 366)),
    # spirit portraits in 160 px cells, spirit id = cell index; Link Boards map_locations assume this origin
    "link_boards": ("US_de_kao0.png", (0, 0, 1920, 800)),
}
MOVEMENT = {
    "flowmotion": ("flow_arrow", "Flow\nmotion"),
    "high_jump": ("boot", "High\nJump"),
    "wall_kick": ("flow_arrow", "Wall\nKick"),
    "super_jump": ("flow_arrow", "Super\nJump"),
    "pole_spin": ("flow_arrow", "Pole\nSpin"),
    "pole_swing": ("flow_arrow", "Pole\nSwing"),
    "rail_slide": ("flow_arrow", "Rail\nSlide"),
    "air_slide": ("boot", "Air\nSlide"),
    "glide": ("boot", "Glide"),
    "superglide": ("boot", "Super\nGlide"),
    "double_flight": ("boot", "Double\nFlight"),
}
GOALS = {
    "goal_final_boss": ("sword", "Final\nBoss"),
    "goal_superbosses": ("dark_star", "Super\nBosses"),
    "goal_emblem_hunt": ("lucky_emblem", "Lucky\nEmblem"),
}


def load(atlases, folder, name):
    if name not in atlases:
        image = Image.open(folder / name)
        image.load()
        atlases[name] = image.convert("RGBA")
    return atlases[name]


def sprite(atlases, folder, key):
    name, box = SPRITES[key]
    return load(atlases, folder, name).crop(box)


def fit(image, size):
    scale = min(size / image.width, size / image.height)
    return image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)


def canvas(image, size):
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    return result


def faded(image, opacity):
    alpha = image.getchannel("A").point(lambda value: int(value * opacity))
    result = image.copy()
    result.putalpha(alpha)
    return result


def label_tile(icon, text):
    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle((0, 0, TILE - 1, TILE - 1), radius=16, fill=(28, 34, 48, 235), outline=(110, 125, 160, 255), width=2)
    watermark = faded(fit(icon, TILE - 24), 0.90)
    tile.alpha_composite(watermark, ((TILE - watermark.width) // 2, (TILE - watermark.height) // 2))
    lines = text.split("\n")
    font = ImageFont.truetype(FONT, 30 if len(lines) > 1 else 34)
    line_height = 34
    y = (TILE - line_height * len(lines)) // 2
    for line in lines:
        width = draw.textlength(line, font=font)
        draw.text(((TILE - width) / 2, y), line, font=font, fill=(255, 255, 255, 255),
                  stroke_width=3, stroke_fill=(0, 0, 0, 255))
        y += line_height
    return tile


def gate_tile(color):
    """Padlock placeholder until the game's gate tile is sourced."""
    tile = Image.new("RGBA", (GATE_TILE, GATE_TILE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle((0, 0, GATE_TILE - 1, GATE_TILE - 1), radius=8, fill=(28, 34, 48, 235), outline=color, width=2)
    draw.arc((20, 12, 44, 40), 180, 360, fill=color, width=4)
    draw.line((20, 26, 20, 32), fill=color, width=4)
    draw.line((43, 26, 43, 32), fill=color, width=4)
    draw.rounded_rectangle((14, 30, 49, 52), radius=4, fill=color)
    return tile


def spirit_images(atlas):
    """Writes the portraits the client's link board grid loads from the pack, named by spirit id."""
    SPIRITS.mkdir(exist_ok=True)
    for spirit_id in range(1, SPIRIT_COUNT + 1):
        row, column = divmod(spirit_id, SPIRIT_COLUMNS)
        box = (column * SPIRIT_CELL, row * SPIRIT_CELL, (column + 1) * SPIRIT_CELL, (row + 1) * SPIRIT_CELL)
        atlas.crop(box).save(SPIRITS / f"{spirit_id}.png", optimize=True)
    gate_tile(GATE_OPEN_COLOR).save(SPIRITS / "gate_open.png", optimize=True)
    gate_tile(GATE_CLOSED_COLOR).save(SPIRITS / "gate_closed.png", optimize=True)


def main(folder, lucky_emblem_path=None):
    folder = Path(folder)
    atlases = {}
    (OUT / "movement").mkdir(exist_ok=True)
    (OUT / "spirits").mkdir(exist_ok=True)
    for key in ("switch_on", "switch_off"):
        canvas(sprite(atlases, folder, key), 48).save(OUT / f"{key}.png")
    sora = fit(sprite(atlases, folder, "sora"), TILE - 8)
    riku = fit(sprite(atlases, folder, "riku"), TILE - 8)
    canvas(sora, TILE).save(OUT / "sora.png")
    canvas(riku, TILE).save(OUT / "riku.png")
    canvas(fit(sprite(atlases, folder, "recipe"), TILE - 8), TILE).save(OUT / "recipe.png")
    if lucky_emblem_path:
        emblem = Image.open(lucky_emblem_path)
        emblem.load()
        emblem = emblem.convert("RGBA")
        emblem = emblem.crop(emblem.getbbox())
        canvas(fit(emblem, TILE - 8), TILE).save(OUT / "lucky_emblem.png")
    for code, (icon, text) in GOALS.items():
        image = Image.open(OUT / "lucky_emblem.png").convert("RGBA") if icon == "lucky_emblem" else sprite(atlases, folder, icon)
        label_tile(image, text).save(OUT / f"{code}.png")
    for code, (icon, text) in MOVEMENT.items():
        label_tile(sprite(atlases, folder, icon), text).save(OUT / "movement" / f"{code}.png")
    link_boards = sprite(atlases, folder, "link_boards")
    link_boards.save(LINK_BOARDS_MAP, optimize=True)
    spirit_images(link_boards)
    print(f"wrote icons to {OUT}, {SPIRITS} and {LINK_BOARDS_MAP.name}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(*sys.argv[1:])
