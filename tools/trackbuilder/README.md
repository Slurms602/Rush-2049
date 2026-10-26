# Rush 2049 track builder

Builds original track meshes, textures, collision, checkpoints, AI racing lines and coin
placements for the Dreamcast game. No game assets are used by the builder. The browser
loads these files through its disc override hook; the player's disc image stays intact.

## Build Neon Skyway

From the repository root, with Python 3.10 or later:

```sh
python3 -m pip install -r tools/trackbuilder/requirements.txt
python3 tools/trackbuilder/build.py tracks/neon-skyway/track.json --out tracks/neon-skyway
```

The command writes five `.LZS` files, `manifest.json` with SHA-256 checksums, and an SVG
layout preview. It checks the complete bundle before replacing the existing files. The
checked-in bundle is ready to play; Python is needed only to edit and rebuild tracks.

## Edit a track

Copy `tracks/neon-skyway/track.json` and edit its `points` array. Each point has `x`, `y`,
`z` in feet, with Y pointing up. The builder fits a smooth closed curve through the points;
do not repeat the first point at the end. Optional fields:

| Field | Meaning |
| --- | --- |
| `width` | Full road width in feet, default 60; supported range 40–200. |
| `bank` | Bank angle in degrees, default 0; positive raises the `cross(forward, up)` side. Use negative values for the turns in the supplied layout. |
| `gap` | If true, omit the road from this point to the next. The racing line continues through the jump. |
| `rails` | Side walls, default true. Set false for open edges. |

Keep the grid and first 150 feet either side of the start on solid, fairly flat road.
The supported circuit length is 1,500–10,000 feet; both compressed and decoded files must
fit the original slot's allocations. Wide curves are easier for both players and the AI.
Keep jumps straight and provide a wide landing. The builder does not prove a jump is
drivable: test it in the game after every layout change.

For the existing browser selection, keep the bundle ID `neon-skyway` and slot 1. Rebuild
into `tracks/neon-skyway`; increment `--version` when publishing a changed track. The
browser also verifies the actual file hashes, so different builds cannot join the same
online match even if their version numbers match.

## Current limits

This is a JSON builder, with no browser editor yet. The custom mode replaces **Marina
(Track 1)** for that boot. Original mode restores the normal disc reads on reload. A
separate seventh entry in the game's own menu still needs executable/menu work.

The game requires 8 gold and 8 silver coins, named reflection/prop textures, alphabetically
sorted object/texture tables, mesh cache indices below 128, valid world-tree links and
collision indices. These are emitted and checked by the build. AI may still miss jumps and is not a substitute for a player
test. The reverse route has its own racing lines but a ramp designed for forward travel
may be unsuitable backward.

## Format references

`trackfile.py`, `roadfile.py`, `pathfile.py` and `worldsfile.py` decode the files used by
the validator. Their comments record the observed file structures and loader addresses.
`lzs.py` handles the game's compression. `gdifs.py` is a local extraction utility for
inspecting the owner's GDI; extracted game files must stay outside the repository.

Marina's visibility code (`0x8c06602e`) always modifies 117 consecutive scenery handles
using its original track's visibility masks. The builder reserves 117 inert placements
before the authored road, keeping that operation away from the new road and cars.
Removing the reservation can make car bodies and road pieces disappear.

The mesh renderer has 128 reusable vertex-cache slots, rather than a 128-vertex limit
on an entire object. The builder reuses those slots between strips, allowing fewer
road placements and leaving room for the reservation. The executable's decoded file
size table (`0x8c0b8db4`) imposes a separate memory limit: WORLDS must fit 17,040 bytes
under the builder's conservative cap. Fitting the compressed disc slot alone is
insufficient because the native decompressor does not check its output capacity.

When testing, install custom files **before the first emulated frame** and navigate from
a fresh boot. The title screen's attract sequence can cache Marina's original data;
loading a save state made in original mode can therefore mix original and custom assets.

See [runtime checks](../tests/README.md) for fresh-boot driving and two-client online tests.
