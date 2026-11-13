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
`access_rules` and `visibility_rules` in `locations/locations.json`, adding nodes for new locations
(without map positions) and moving sections whose path changed, such as a board node whose gate did.
Renamed locations need their node renamed by hand first so map positions are kept.

`gen/gen_link_board_grid.py` builds the Link Boards grid: the `Link Boards` map image and
its markers, the gate overlays in `images/spirits`, `layouts/link_boards.json` and
`scripts/link_board_spirits.lua`, plus Universal Tracker's labelled copy of the image and
`maps/ut_maps.json`. It shouldn't need to be rerun ever but keeping just in case.

### Map editor

I vibecoded the **** out of this tool.  It is **NOT** included in any poptracker pack.  It exists
so that I didn't have to open up paint to move a check, like one of those crappy old school html editors.
It changes **ONLY** `locations/locations.json` and `maps/maps.json`, and I have verified that it doesn't look like crap.

`tools/mapper` is a local web UI for placing locations on maps.  It requires node.js

```bash
node tools/mapper/server.mjs
```

It opens in the browser. Pick a map (listed by layout tab), pick a location, and click the map to
set its `map_locations`; Save writes `maps/maps.json` and `locations/locations.json` in the
generators' format, onto whatever is on disk at that moment. "Replace image…" swaps a map's image
and moves its markers along: drag and scale the old image over the new one, or click matching
landmarks on both. "Add map…" appends a map to `maps.json` and can give it a tab. "Edit tabs" adds,
reorders, renames, moves and removes layout tabs, including sub-tabs under a tab; it rewrites
`layouts/tracker.json` in its current style and refuses files with comments. "Add summary
location…" makes one location per world (or any tab) whose sections `ref` that world's checks, for
an overworld map: its marker shows whether anything there is available. Summaries live in their
own top-level location (`Overworld` by default), which the generators and world counters leave
alone; rebuild them after the generators add checks. For chests on top of each other, Ctrl+click
or Shift+click several locations, then click the map: that makes one location beside them whose
sections `ref` their checks, and their own markers on that map go. The checks stay where the
generators put them, so a regen keeps the group. Press `?` in the tool for its shortcuts.

Rules that are wrong get fixed in the apworld, not here. A location's details end with its Logic:
what its parent locations need and what each check adds. "Fix rule…" records the rule a check
should have, plus a note, without touching the pack. Fixes go to `rule-fixes.json` beside the pack
(`--fixes <file>` puts them elsewhere), and `rule-fixes.md` next to it is the handoff to give a
session working on the apworld; "Rule fixes" in the toolbar shows and copies it. The handoff asks
that session to change only the apworld, on the branch checked out there, then commit and reply with
the commit ID. Both files are gitignored. Once a regen gives a check the fixed rule, the mapper marks
that fix done and can clear it.
Tests: `node --test "tools/mapper/test/*.test.mjs"`.