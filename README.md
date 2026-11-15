# khddd-ap-tracker

Poptracker pack for Kingdom Hearts Dream Drop Distance with Archipelago auto-tracking support.

## Installation

Download the zip folder from the latest release and place it in the `packs` folder of your Poptracker installation.

## Variants

Pick one when loading the pack: Maps, Items & Link Boards (the default), Maps & Items, Items Only, or
Link Boards Only. The variants with items show them in a column on the left, or along the bottom
with the "Items along the bottom" setting, which Reset leaves alone.

## Settings

The Sora and Riku pictures above the world icons pick the characters in play. The settings button
(gear icon) opens the other seed options: goal, superboss checks, Lord Kyroo, Destiny Islands, Armored
Ventus Nightmare, level checks, link board checks, fast go mode, recipes required and Lucky Emblems
required. Chest logic and which locations are shown following these settings. When connected to
Archipelago they should be filled automatically.

The Logic group in the same window holds the apworld's logic options: Slide Dash logic, Rising Wing
logic and glitched logic. With one off, checks that need it show yellow: possible, but out of logic.

The green number on a world icon counts that world's unchecked checks that are in logic, including
ones without a map pin.

## Logic

Access rules are generated from the apworld's `Rules.py` and `Regions.py`, so the tracker should match
Universal Tracker right now. The Link Boards tab is an item grid of the spirits and it will be greyed
out until you receive the recipe. It will also show the gates open or closed, and through some trickery
has a single location group for all of the nodes.

## Universal Tracker

The release zip also works as the map pack for Universal Tracker in the KHDDD client: select it when
the client asks for a pack. Universal Tracker reads only the maps and locations, and takes its logic
from the apworld. It matches sections by name, so every section keeps its exact AP location name.
It reads its maps from `maps/ut_maps.json`, a copy of `maps.json` whose Link Boards image has the
spirit names and portraits drawn in, since Universal Tracker can't draw it the same way.  I may port
this into kivy instead at some point, but leaving it for now.

## Development

None of the generators are included in the pack, they're only in source.

The generators in `gen/` will regenerate logic if it's changed. They import `worlds.khddd` from the
Archipelago checkout, so run them with that checkout's venv:
```bash
<source>/Archipelago/venv/Scripts/python gen/gen_location_mapping.py
<source>/Archipelago/venv/Scripts/python gen/gen_access_rules.py
```

The first regenerates `scripts/autotracking/location_mapping.lua`; the second rewrites the
`access_rules` and `visibility_rules` in the locations files, adding nodes for new locations
(without map positions) and moving sections whose path changed, such as a board node whose gate did.
A location whose checks all move to another region takes its map positions along; otherwise renamed
locations need their node renamed by hand first so map positions are kept.

Like the apworld, each AP region is its own top-level location, gated on its whole entrance chain:
Traverse Town Plaza [Sora] sits between Traverse Town [Sora] and Traverse Town 2 [Sora]. A world's
regions share one file, `locations/<sora|riku>/<world>.json`, and Destiny Islands, Levels, Link
Boards and Overworld have their own. `scripts/init.lua` loads each file, and the apworld's
`tracker_world["map_page_locations"]` lists them for Universal Tracker; the generator warns when
either is missing one.

`gen/gen_link_board_grid.py` builds the Link Boards grid: the `Link Boards` map image and
its markers, the gate overlays in `images/spirits`, `layouts/link_boards.json` and
`scripts/link_board_spirits.lua`, plus Universal Tracker's labelled copy of the image and
`maps/ut_maps.json`. It shouldn't need to be rerun ever but keeping just in case.
