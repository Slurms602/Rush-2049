#!/usr/bin/env python3
"""Build and validate an original custom track, then write its integrity manifest."""
import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path as FilePath
import struct
import tempfile

# Set before NumPy loads BLAS; thread-dependent float32 sums change VQ textures.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
import numpy as np
from lzs import decode
from pathfile import Path
from roadfile import Road
from trackfile import Track
from worldsfile import Worlds
from trackbuilder import build, resample, frames, PVS_PREFIX_COUNT, PVS_PADDING_NAME
import shortcuts


def validate_description(desc):
    points = desc.get("points", [])
    if not 4 <= len(points) <= 128:
        raise ValueError("Use 4 to 128 control points in a closed loop (do not repeat the first point).")
    if desc.get("slot", 1) != 1:
        raise ValueError("The browser's custom track mode currently uses slot 1.")
    if desc.get("theme", "neon") not in ("neon", "chemical"):
        raise ValueError("Supported themes are neon and chemical.")
    for i, p in enumerate(points):
        for key in ("x", "y", "z"):
            v = p.get(key)
            if not isinstance(v, (float, int)) or not math.isfinite(v) or abs(v) > 16000:
                raise ValueError(f"Point {i}: {key} must be a finite coordinate within +/-16000 ft.")
        if not 40 <= p.get("width", 60) <= 200:
            raise ValueError(f"Point {i}: width must be between 40 and 200 ft.")
        if not -60 <= p.get("bank", 0) <= 60:
            raise ValueError(f"Point {i}: bank must be between -60 and 60 degrees.")
        q = points[(i + 1) % len(points)]
        if sum((p[k] - q[k]) ** 2 for k in ("x", "y", "z")) < 1:
            raise ValueError(f"Point {i}: consecutive points must be at least 1 ft apart.")
    if points[0].get("gap") or points[-1].get("gap"):
        raise ValueError("Keep the start/finish and grid on solid road.")
    if "max_objects" in desc:
        raise ValueError("max_objects is a debugging option and must not be used for playable tracks.")
    sec, total = resample(desc)
    if not 1500 <= total <= 10000:
        raise ValueError("The supported track length is 1500 to 10000 ft.")
    frames(sec)
    shortcuts.validate(desc, sec)
    if any(not np.isfinite(s["L"]).all() or not np.isfinite(s["R"]).all() for s in sec):
        raise ValueError("The road contains a vertical or degenerate cross-section.")
    # Grid slots are derived from checkpoint zero; reserve the opening straight.
    if any(s["gap"] for s in sec[:15] + sec[-15:]):
        raise ValueError("Keep 150 ft of solid road on either side of the start/finish.")
    # Distinct road branches may cross in X/Z, but need room for the slab and
    # a car beneath the bridge. Broad-phase arrays avoid an expensive pair loop.
    positions = np.array([s["pos"] for s in sec])
    ends = np.roll(positions, -1, axis=0)
    lo, hi = np.minimum(positions[:, [0, 2]], ends[:, [0, 2]]), np.maximum(positions[:, [0, 2]], ends[:, [0, 2]])
    indices = np.arange(len(sec))
    cross = lambda a, b: a[0] * b[1] - a[1] * b[0]
    for i, a in enumerate(positions):
        candidates = np.where((indices > i + 15) & (indices < i + len(sec) - 15)
                              & np.all(hi >= lo[i], axis=1) & np.all(lo <= hi[i], axis=1))[0]
        ab = (ends[i] - a)[[0, 2]]
        for j in candidates:
            cd = (ends[j] - positions[j])[[0, 2]]
            det = cross(ab, cd)
            if abs(det) < 1e-8: continue
            ac = (positions[j] - a)[[0, 2]]
            u, v = cross(ac, cd) / det, cross(ac, ab) / det
            if 0 <= u <= 1 and 0 <= v <= 1:
                y0 = a[1] + u * (ends[i, 1] - a[1])
                y1 = positions[j, 1] + v * (ends[j, 1] - positions[j, 1])
                if abs(y0 - y1) < 32:
                    raise ValueError("Road crossings need at least 32 ft of vertical clearance.")
    return sec, total


def validate_files(files):
    decoded = {name: decode(data) for name, data in files.items()}
    track = Track(decoded["TRACK1.LZS"])
    object_names = [name for _, name, _, _ in track.objects()]
    texture_names = [name for _, name, *_ in track.textures()]
    if object_names != sorted(set(object_names)) or texture_names != sorted(set(texture_names)):
        raise ValueError("Object and texture tables must contain unique names in alphabetical order.")
    names = set()
    for _, name, _, parts in track.objects():
        names.add(name)
        for flags, _, off in parts:
            # The decoder checks the 128 cache slots. Strips may overwrite slots;
            # the total number of emitted vertices in an object can exceed 128.
            track.mesh(off, bool(flags & 0x10))
    world = Worlds(decoded["TRACK1WORLDS.LZS"])
    # The native culler assumes Marina has 117 consecutive scenery allocations.
    # Reserve that complete sibling chain before any authored road or interactive
    # objects, so its original visibility masks cannot change their render flags.
    if len(world.records) <= PVS_PREFIX_COUNT:
        raise ValueError("Missing the protected Marina visibility prefix.")
    for i, r in enumerate(world.records[:PVS_PREFIX_COUNT]):
        nxt, child, _, object_id = struct.unpack_from("<HHII", world.data, r["off"] + 68)
        if (r["name"] != PVS_PADDING_NAME or nxt != i + 1
                or child != 0xffff or object_id != 0xffffffff):
            raise ValueError("Invalid Marina visibility prefix: reserve 117 leading scenery siblings.")
    if any(r["name"] == PVS_PADDING_NAME for r in world.records[PVS_PREFIX_COUNT:]):
        raise ValueError("Visibility padding must precede all authored scenery.")
    coins = [r["name"] for r in world.records if r["name"] in ("GOLDCOIN", "SILVERCOIN")]
    if coins.count("GOLDCOIN") != 8 or coins.count("SILVERCOIN") != 8:
        raise ValueError("The game requires exactly eight gold and eight silver coins.")
    for r in world.records:
        if r["name"] not in names and r["name"] not in coins:
            raise ValueError(f"Missing placed object: {r['name']}")
        nxt, child = struct.unpack_from("<HH", world.data, r["off"] + 68)
        if any(x != 0xffff and x >= len(world.records) for x in (nxt, child)):
            raise ValueError("Invalid world sibling or child link.")
    road = Road(decoded["TRACK1ROAD.LZS"])
    list(road.leaves())  # Reject oversized native stack queries and invalid surface references.
    for i in range(road.counts[2]):
        if any(v >= road.counts[3] for v in road.surface_indices(i)):
            raise ValueError("Invalid collision vertex index.")
        # Only the first vertex is world-space; all remaining vertices are
        # surface-local. The game's tire query assumes their plane is y=0.
        if any(abs(v[1]) > 1 / 32 for v in road.surface_vertices(i)[1:]):
            raise ValueError("Collision vertices do not lie on their contact plane.")
    for name in ("TRACK1PATH.LZS", "TRACK1PATHBACK.LZS"):
        p = Path(decoded[name])
        if p.end != len(p.data) or p.ncp < 2 or len(p.lines) != 4:
            raise ValueError(f"{name}: incomplete checkpoint or AI path data.")
    # Slot 1 allocations on the supported US v1.001 GD-ROM (allow no expansion).
    budgets = {"TRACK1.LZS": 2217301, "TRACK1ROAD.LZS": 291330,
               "TRACK1PATH.LZS": 26319, "TRACK1PATHBACK.LZS": 24939,
               "TRACK1WORLDS.LZS": 6995}
    for name, data in files.items():
        if len(data) > budgets[name]:
            raise ValueError(f"{name} is {len(data)} bytes; slot 1 allows {budgets[name]}.")
    # The executable also hardcodes decompressed sizes (US v1.001, table at
    # 0x8c0b8db4). A small compressed file can still overflow its destination:
    # e.g. the WORLDS loader reserves 17040 bytes, rounded to 18432, and its LZS
    # decoder has no output-capacity argument. Stay within the stock sizes.
    decoded_budgets = {"TRACK1.LZS": 3043644, "TRACK1ROAD.LZS": 350889,
                       "TRACK1PATH.LZS": 30626, "TRACK1PATHBACK.LZS": 28758,
                       "TRACK1WORLDS.LZS": 17040}
    for name, data in decoded.items():
        if len(data) > decoded_budgets[name]:
            raise ValueError(f"{name} expands to {len(data)} bytes; slot 1 allows {decoded_budgets[name]}.")


def preview(sec, total, target, name="Neon Skyway", desc=None):
    x = [s["pos"][0] for s in sec]; z = [s["pos"][2] for s in sec]
    lo_x, lo_z = min(x) - 220, min(z) - 220
    width, height = max(x) - lo_x + 220, max(z) - lo_z + 220
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{lo_x} {lo_z} {width} {height}" role="img" aria-label="{html.escape(name, quote=True)} track layout">',
             f'<rect x="{lo_x}" y="{lo_z}" width="{width}" height="{height}" fill="#101427"/>']
    for i, a in enumerate(sec):
        b = sec[(i + 1) % len(sec)]
        pts = [a["L"], a["R"], b["R"], b["L"]]
        corners = " ".join(f'{p[0]:.1f},{p[2]:.1f}' for p in pts)
        color = "#ff62c9" if a["gap"] else "#3a5478"
        parts.append(f'<polygon points="{corners}" fill="{color}" opacity="{0.25 if a["gap"] else 1}"/>')
        if not a["gap"]:
            for side in ("L", "R"):
                p, q = a[side], b[side]
                parts.append(f'<path d="M{p[0]:.1f},{p[2]:.1f} L{q[0]:.1f},{q[2]:.1f}" stroke="#78e9ff" stroke-width="4"/>')
    if desc:
        for branch in shortcuts.prepare(desc, sec):
            points = [q["pos"] for q in branch["sections"] + branch["landing"]] + [sec[branch["rejoin"]]["pos"]]
            coords = " ".join(f'{p[0]:.1f},{p[2]:.1f}' for p in points)
            parts.append(f'<polyline points="{coords}" fill="none" stroke="#abff4c" stroke-width="14" stroke-dasharray="24 14"/>')
    indices = shortcuts.checkpoint_indices(desc, sec) if desc else None
    for i, idx in enumerate(indices or [int(i * len(sec) / 6) for i in range(6)]):
        p = sec[idx]["pos"]
        parts.append(f'<circle cx="{p[0]:.1f}" cy="{p[2]:.1f}" r="32" fill="#{"ffffff" if i == 0 else "ffba62"}"/>')
        parts.append(f'<text x="{p[0]:.1f}" y="{p[2] + 12:.1f}" text-anchor="middle" font-size="36" font-family="sans-serif" fill="#101427">{i + 1}</text>')
    legend = " · green = optional flight" if desc and desc.get("shortcuts") else ""
    parts.append(f'<text x="{lo_x + 60:.1f}" y="{lo_z + height - 55:.1f}" fill="#b4c6e3" font-size="36" font-family="sans-serif">{total:.0f} ft · pink = wing jump{legend}</text></svg>')
    target.write_text("\n".join(parts), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("description", type=FilePath)
    parser.add_argument("--out", type=FilePath, required=True)
    parser.add_argument("--id", default="neon-skyway")
    parser.add_argument("--version", type=int, default=1)
    args = parser.parse_args()
    desc = json.loads(args.description.read_text())
    sec, total = validate_description(desc)
    # Build in a temporary folder; a failed validation leaves the installed bundle intact.
    with tempfile.TemporaryDirectory(prefix="rush-track-") as tmp:
        build(desc, tmp)
        files = {p.name: p.read_bytes() for p in FilePath(tmp).glob("*.LZS")}
        validate_files(files)
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = dict(id=args.id, name=desc["name"], version=args.version, slot=1,
                    lengthFeet=round(total), files=[])
    for name, data in sorted(files.items()):
        (args.out / name).write_bytes(data)
        manifest["files"].append(dict(name=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    preview(sec, total, args.out / "preview.svg", desc["name"], desc)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Validated bundle: {args.out / 'manifest.json'}")


if __name__ == "__main__":
    main()
