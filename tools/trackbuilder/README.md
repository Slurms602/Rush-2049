# Rush 2049 track builder

Builds original track meshes, textures, collision, checkpoints, AI racing lines and coin
placements for the Dreamcast game. No game assets are used by the builder. The browser
loads these files through its disc override hook; the player's disc image stays intact.

## Build Neon Skyway

From the repository root, with Python 3.10 or later:

```sh
python3 -m pip install -r tools/trackbuilder/requirements.txt
python3 tools/trackbuilder/build.py tracks/neon-skyway/track.json --out tracks/neon-skyway --version 3
```

The command writes five `.LZS` files, `manifest.json` with SHA-256 checksums, and an SVG
layout preview. It checks the complete bundle before replacing the existing files. The
checked-in bundle is ready to play; Python is needed only to edit and rebuild tracks.

Chemical Circuit uses the same builder with a separate layout and artwork theme:

```sh
python3 tools/trackbuilder/build.py tracks/chemical-circuit/track.json --id chemical-circuit --out tracks/chemical-circuit --version 2
```

Set `"theme": "chemical"` to generate blue steel, hazard stripes, orange pipework,
factory skylines and a purple liquid basin. Its nine scenery regions batch the pools,
tanks and gantries to fit the native placement budget. The theme changes artwork and
the fall-reset floor height; the driving surface remains pavement with exact contact
planes. Road crossovers require at least 32 feet of vertical clearance.

## Optional flying shortcuts

Neon Skyway and Chemical Circuit use separate green launch lanes that skip bends
and land back on the main road. Doodle Dimension uses integrated road materials
and scenery cues instead. `shortcuts` contains its `id`, `name`, `entry`,
`rejoin`, open-ended `ramp` points, an optional `landing` deck, and `openings` in
the main road's side rails. Landing points use the same fields as ramp points.
Progress values such as `24.5` mean halfway between control points 24 and 25.
An opening specifies `from`, `to` and side `L` or `R`, relative to forward travel.

The ramp uses the same pavement/contact-plane code as the main road. Its green
arrows and landing posts are decorative. Ramps are batched into existing road
meshes, preserving the protected visibility prefix and native placement budget.
The ramp and optional landing add collision; the flight between them has no deck.
AI cars continue to use the main loop.

Tracks with shortcuts must specify six ordered `checkpoints`, starting at progress
zero. The validator rejects a shortcut that bypasses any required checkpoint.
Forward and reverse checkpoint orders are emitted separately. Flying routes and
the main loop both need a fresh-boot lap test; a geometric shortcut alone does not
prove a legal or achievable lap. Green dashed lines in `preview.svg` show the cuts.

## Edit a track

Copy `tracks/neon-skyway/track.json` and edit its `points` array. Each point has `x`, `y`,
`z` in feet, with Y pointing up. The builder fits a smooth closed curve through the points;
do not repeat the first point at the end. Optional fields:

| Field | Meaning |
| --- | --- |
| `width` | Full road width in feet, default 60; supported range 40–200. |
| `bank` | Bank angle in degrees, default 0; positive raises the `cross(forward, up)` side. Keep banks mild and transition gradually. |
| `gap` | If true, omit the road from this point to the next. The racing line continues through the jump. |
| `rails` | Side walls, default true. Set false for open edges. |

Keep the grid and first 150 feet either side of the start on solid, fairly flat road.
The supported circuit length is 1,500–10,000 feet; both compressed and decoded files must
fit the original slot's allocations. Wide curves are easier for both players and the AI.
Keep jumps straight and provide a wide landing. The builder does not prove a jump is
drivable: test it in the game after every layout change.

Collision triangles use their actual geometric plane. The native tire query assumes
all surface-local vertices have Y=0; averaging road-section normals can create contact
steps as a bank or grade changes. The validator rejects those off-plane vertices.
Even correct collision can unload the tires over a sharp crest. Neon Skyway's revised
layout uses flat cross-sections and gentle grades outside its intentional jump.

Collision tree cells are filtered against actual polygons, including at elevated
crossovers. Leaves are capped at 32 surfaces to stay within native contact-query
scratch buffers; oversized lists can corrupt the game's stack. The builder splits
dense cells further and rejects a layout that still cannot fit.

For the browser selections, keep the bundle ID `neon-skyway`, `chemical-circuit` or `doodle-dimension` and
slot 1. Rebuild into its matching `tracks/` directory; increment `--version` when
publishing a changed track. The
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

## Doodle Dimension

```sh
python3 tools/trackbuilder/build.py tracks/doodle-dimension/track.json --id doodle-dimension --out tracks/doodle-dimension
```

The `doodle` theme restores the original saturated tiles, cream bubble sky,
illustrated murals, arches and colorful pools from the first release. Scenery
beside flight corridors is kept clear. Nine scenery batches fit the native
placement budget. Two optional shortcuts use gentle launch grades, natural
approach tangents and landing decks up to 200 feet wide.

`"markings": "integrated"` retains ROAD/RAIL materials and omits FLYMARK overlays,
main-road arrow decals and green rejoin posts. Existing circuits retain their
default green markers. Shortcut deck widths support the same 40–200-foot range
as the main road. Racing-speed checks are documented in `tools/tests/README.md`.

The soundtrack is a native Sega Audio64 `.STR` stream, built entirely from the
supplied audio. Rebuild it with FFmpeg installed:

```sh
python3 tools/trackbuilder/music.py track.webm --out tracks/doodle-dimension/SOUNDTRACK.STR
python3 tools/trackbuilder/build.py tracks/doodle-dimension/track.json --id doodle-dimension --out tracks/doodle-dimension --version 4
```

The format is 44.1 kHz stereo PCM16 with 16 KiB channel blocks, a 2 KiB header
and two lead-in blocks. `SOUNDTRACK.json` records its integrity and native stream
aliases; geometry rebuilds include it in `manifest.json`. The loader verifies
its hash before boot, includes it and its aliases in the room fingerprint, and
patches one disc extent shared by the game's 18 music selections. Menus and
races therefore use the supplied music during this custom-track boot. Original
mode retains the original music. The game's own mixer and Music volume control
handle playback; no browser audio element is used.

Format references: FFmpeg `libavformat/dcstr.c` and vgmstream
`src/meta/str_sega.c`, corroborated against the owner's US v1.001 disc headers.
