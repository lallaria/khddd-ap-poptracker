# khddd-ap-tracker

Poptracker pack for Kingdom Hearts Dream Drop Distance with Archipelago auto-tracking support.

## Installation

Download the zip folder from the latest release and place it in the `packs` folder of your Poptracker installation.

## Settings

The Sora and Riku pictures above the world icons pick the characters in play. The settings button
(gear icon) opens the other seed options: goal, superboss checks, Lord Kyroo, Destiny Islands, Armored
Ventus Nightmare, level checks, fast go mode, recipes required and Lucky Emblems required. Chest logic
and which locations are shown following these settings. When connected to Archipelago they should be 
filled automatically.

## Logic

Access rules are generated from the apworld's `Rules.py` and `Regions.py`, so the tracker should match
Universal Tracker right now.

## Development

The generators in `gen/` will regenerate logic if it's changed. They import `worlds.khddd` from the
Archipelago checkout, so run them with that checkout's venv:
```bash
<source>/Archipelago/venv/Scripts/python gen/gen_location_mapping.py
<source>/Archipelago/venv/Scripts/python gen/gen_access_rules.py
```

The first regenerates `scripts/autotracking/location_mapping.lua`; the second rewrites the
`access_rules` and `visibility_rules` in `locations/locations.json`, adding nodes for new locations
(without map positions). Renamed locations need their node renamed by hand first so map positions
are kept.

The venv has to sit inside `<source>/Archipelago/` (`venv` or `.venv`): the scripts put its parent
folder on the import path to find `worlds`.