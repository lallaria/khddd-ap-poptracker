# khddd-ap-tracker

Poptracker pack for Kingdom Hearts Dream Drop Distance with Archipelago auto-tracking support.

## Installation

Download the zip folder from the latest release and place it in the `packs` folder of your Poptracker installation.

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
Universal Tracker right now. The Link Boards tab has a square per spirit holding its 16 board nodes.
In `locations.json` each spirit under `Link Boards` splits its nodes into `Open`, `Gate 1` and `Gate 2`
as the apworld gates them; the square is a sibling overview location whose sections reference those.
Link board gates and the recipes in the pool are rolled per seed, so until the tracker is connected to
Archipelago every board is shown and its gates count as open.

## Universal Tracker

The release zip also works as the map pack for Universal Tracker in the KHDDD client: select it when
the client asks for a pack. Universal Tracker reads only the maps and locations, and takes its logic
from the apworld. It matches sections by name, so every section keeps its exact AP location name.

## Development

The generators in `gen/` will regenerate logic if it's changed. They import `worlds.khddd` from the
Archipelago checkout, so run them with that checkout's venv:
```bash
<source>/Archipelago/venv/Scripts/python gen/gen_location_mapping.py
<source>/Archipelago/venv/Scripts/python gen/gen_access_rules.py
```

The first regenerates `scripts/autotracking/location_mapping.lua`; the second rewrites the
`access_rules` and `visibility_rules` in `locations/locations.json`, adding nodes for new locations
(without map positions) and moving sections whose path changed, such as a board node whose gate did.
Renamed locations need their node renamed by hand first so map positions are kept. The apworld's `Cleared` events become hidden `Cleared` nodes, which link board gates count.

The venv has to sit inside `<source>/Archipelago/` (`venv` or `.venv`): the scripts put its parent
folder on the import path to find `worlds`.

### Map editor

`tools/mapper` is a local web UI for placing locations on maps. It needs only Node 18 or newer:
```bash
node tools/mapper/server.mjs
```
It opens in the browser. Pick a map (listed by layout tab), pick a location, and click the map to
set its `map_locations`; Save writes `maps/maps.json` and `locations/locations.json` in the
generators' format, onto whatever is on disk at that moment. "Replace image…" swaps a map's image
and moves its markers along: drag and scale the old image over the new one, or click matching
landmarks on both. "Add map…" appends a map to `maps.json`, which still needs a layout tab by hand.
Press `?` in the tool for its shortcuts. Tests: `node --test "tools/mapper/test/*.test.mjs"`.