"""Regression checks for file-format mistakes that can hang or crash the game."""
import copy
import json
from pathlib import Path
import struct
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "trackbuilder"))
from build import validate_description, validate_files
from lzs import decode, encode
from roadfile import Road
from trackbuilder import Mesh, PVS_PREFIX_COUNT, road_file, resample, frames, ribbon_collision, path_file
from trackfile import Track
from worldsfile import Worlds
from pathfile import Path as TrackPath
from shortcuts import checkpoint_indices


class TrackBuilderTests(unittest.TestCase):
    def setUp(self):
        self.description = json.loads((ROOT / "tracks/neon-skyway/track.json").read_text())

    def test_overlapping_lzs_backreference(self):
        # Two literal bytes followed by a six-byte, distance-two match and terminator.
        self.assertEqual(decode(b"\x03AB\x04\x02\0\0"), b"ABABABAB")

    def test_rejects_undefined_spline_and_grid_in_void(self):
        cases = []
        d = copy.deepcopy(self.description)
        d["points"][1] = d["points"][0].copy()
        cases.append(d)
        d = copy.deepcopy(self.description)
        d["points"][0]["x"] = float("nan")
        cases.append(d)
        d = copy.deepcopy(self.description)
        d["points"][0]["gap"] = True
        cases.append(d)
        for d in cases:
            with self.subTest(d=d), self.assertRaises(ValueError):
                validate_description(d)

    def test_collision_roundtrip_preserves_surface_and_fractional_coordinates(self):
        points = [[-14.125, 601.5, -30.25], [25.875, 601.5, -30.25],
                  [25.875, 601.5, 9.75]]
        road = Road(road_file([(points, [0, 1, 0], 0)]))
        origin = road.vertex(0)
        self.assertEqual(origin, tuple(points[0]))
        flags, info, matrix, _ = road.surface(0)
        self.assertEqual(flags, 0)
        self.assertEqual(info & 15, 3)
        # Plane normal is the middle row of the fixed-point transform, and must face up.
        self.assertEqual(matrix[3:6], (0, 16384, 0))
        self.assertEqual(road.surface_indices(0), [0, 1, 2])

    def test_shipped_bundle_fits_and_has_complete_paths_objects_and_collision(self):
        for directory in (ROOT / "tracks").iterdir():
            if not (directory / "manifest.json").exists(): continue
            with self.subTest(track=directory.name):
                files = {p.name: p.read_bytes() for p in directory.glob("*.LZS")}
                self.assertEqual(len(files), 5)
                validate_files(files)

    def test_chemical_layout_has_two_jumps_and_clear_bridges(self):
        description = json.loads((ROOT / "tracks/chemical-circuit/track.json").read_text())
        sec, _ = validate_description(description)
        self.assertEqual(sum(s["gap"] and not sec[i - 1]["gap"] for i, s in enumerate(sec)), 2)
        # Flattening the elevated return would create real road intersections.
        for p in description["points"]: p["y"] = 600
        with self.assertRaisesRegex(ValueError, "vertical clearance"):
            validate_description(description)

    def test_collision_leaf_filter_keeps_surfaces_and_rejects_native_overflow(self):
        # Long diagonal triangles have heavily overlapping bounding boxes, but
        # small spatial cells should include only the nearby actual surfaces.
        polygons = [([[0, 600, z], [300, 600, z + 300], [0, 600, z + 8]], [0, 1, 0], 0)
                    for z in range(0, 120, 3)]
        road = Road(road_file(polygons))
        leaves = dict(road.leaves())
        self.assertLessEqual(max(map(len, leaves.values())), 32)
        for surface, (points, _, _) in enumerate(polygons):
            x = sum(p[0] for p in points) / 3; z = sum(p[2] for p in points) / 3; i = 0
            while True:
                _, _, flags, x0, x1, z0, z1, *children = struct.unpack_from(
                    '<hBB4h4H', road.data, road.tree_off + i * 20)
                q = int(x >= int((x0 + x1) / 2)) + 2 * int(z < int((z0 + z1) / 2))
                child = children[q]
                if flags & (1 << q): i = child; continue
                offset = road.rest_off + child + (0x10000 if flags & (1 << (q + 4)) else 0)
                self.assertIn(surface, leaves[offset]); break
        data = bytearray(road.data); data[next(iter(leaves))] = 33
        with self.assertRaisesRegex(ValueError, 'native query buffer'):
            list(Road(data).leaves())

    def test_shortcuts_cannot_bypass_a_required_checkpoint(self):
        for name in ("neon-skyway", "chemical-circuit"):
            d = json.loads((ROOT / f"tracks/{name}/track.json").read_text())
            sec, _ = validate_description(d)
            self.assertTrue(d["shortcuts"])
            branch = d["shortcuts"][0]
            next_gate = next(i for i, value in enumerate(d["checkpoints"]) if value > branch["entry"])
            d["checkpoints"][next_gate] = (branch["entry"] + branch["rejoin"]) / 2
            with self.subTest(track=name), self.assertRaisesRegex(ValueError, "required checkpoint"):
                validate_description(d)

    def test_open_ramp_has_no_invisible_closing_collision_wall(self):
        d = {"points": self.description["shortcuts"][0]["ramp"]}
        sec, _ = resample(d, closed=False)
        frames(sec, closed=False)
        road = Road(road_file(ribbon_collision(sec, closed=False)))
        # Only the authored launch lane exists: no last-to-first slab across its
        # turnoff, and no side wall blocking access from the main road.
        self.assertEqual(road.counts[2], 2 * (len(sec) - 1))
        self.assertTrue(all(road.surface(i)[0] == 0 for i in range(road.counts[2])))
        for i in range(road.counts[2]):
            self.assertTrue(all(abs(v[1]) <= 1 / 32 for v in road.surface_vertices(i)[1:]))

    def test_shortcuts_cannot_overlap_in_progress(self):
        d = json.loads((ROOT / "tracks/neon-skyway/track.json").read_text())
        d["shortcuts"].append(dict(d["shortcuts"][0], id="overlap"))
        with self.assertRaisesRegex(ValueError, "cannot overlap"):
            validate_description(d)

    def test_reverse_checkpoints_keep_finish_and_reverse_the_required_gates(self):
        sec, total = validate_description(self.description)
        indices = checkpoint_indices(self.description, sec)
        forward = TrackPath(path_file(sec, total, checkpoints=indices))
        backward = TrackPath(path_file(sec, total, reverse=True, checkpoints=indices))
        self.assertEqual(backward.checkpoints[0]["pos"], forward.checkpoints[0]["pos"])
        self.assertEqual([q["pos"] for q in backward.checkpoints[1:]],
                         [q["pos"] for q in forward.checkpoints[:0:-1]])
        for a, b in zip(backward.checkpoints, forward.checkpoints[:1] + forward.checkpoints[:0:-1]):
            self.assertEqual(a["dir"], tuple(-v for v in b["dir"]))

    def test_banked_triangles_use_their_geometric_contact_plane(self):
        # A changing bank twists a road quad. The average section normal is
        # unsuitable for either triangle: all local vertices must have y=0.
        points = [[-45, 600, 0], [45, 620, 0], [44, 625, 10], [-44, 602, 10]]
        polygons = [(points[:3], [0, 1, 0], 0),
                    ([points[0], points[2], points[3]], [0, 1, 0], 0)]
        road = Road(road_file(polygons))
        for i in range(2):
            self.assertTrue(all(abs(v[1]) <= 1 / 32 for v in road.surface_vertices(i)[1:]))
            self.assertGreater(road.surface(i)[2][4], 0)

    def test_validator_rejects_a_step_in_a_collision_contact_plane(self):
        files = {p.name: p.read_bytes() for p in (ROOT / "tracks/neon-skyway").glob("*.LZS")}
        data = bytearray(decode(files["TRACK1ROAD.LZS"]))
        road = Road(data)
        local_vertex = road.surface_indices(0)[1]
        struct.pack_into("<h", data, road.vert_off + local_vertex * 8 + 2, 1)
        files["TRACK1ROAD.LZS"] = encode(data)
        with self.assertRaisesRegex(ValueError, "contact plane"):
            validate_files(files)

    def test_mesh_cache_can_be_overwritten_but_not_indexed_out_of_bounds(self):
        mesh = Mesh([0, 0, 0])
        mesh.texture(0)
        vertices = [((i, 0, 0), (0, 0)) for i in range(128)]
        mesh.strip(vertices)
        mesh.strip(vertices)
        track = Track.__new__(Track)
        track.data = mesh.finish()
        self.assertEqual([len(strip) for strip in track.mesh(0)], [128, 128])
        for invalid_word in (128 << 8, 0x10000000 | (128 << 16)):
            data = bytearray(track.data)
            # The first vertex follows the eight-byte texture command.
            struct.pack_into("<I", data, 8, invalid_word)
            bad = Track.__new__(Track)
            bad.data = data
            with self.subTest(word=invalid_word), self.assertRaisesRegex(ValueError, "cache"):
                bad.mesh(0)

    def test_rejects_authored_road_inside_native_visibility_prefix(self):
        files = {p.name: p.read_bytes() for p in (ROOT / "tracks/neon-skyway").glob("*.LZS")}
        data = bytearray(decode(files["TRACK1WORLDS.LZS"]))
        world = Worlds(data)
        # An otherwise valid placed model in the protected range would receive
        # stock visibility bits, hiding road or dynamic car parts during play.
        road = world.records[PVS_PREFIX_COUNT]["name"].encode().ljust(16, b"\0")
        start = world.records[0]["off"]
        data[start:start + 16] = road
        files["TRACK1WORLDS.LZS"] = encode(data)
        with self.assertRaisesRegex(ValueError, "prefix"):
            validate_files(files)

    def test_rejects_small_compressed_file_that_overflows_native_decoded_buffer(self):
        files = {p.name: p.read_bytes() for p in (ROOT / "tracks/neon-skyway").glob("*.LZS")}
        # A valid world plus padding still parses, and compresses under the disc slot
        # budget, but the native decoder would write beyond its fixed allocation.
        world = decode(files["TRACK1WORLDS.LZS"])
        files["TRACK1WORLDS.LZS"] = encode(world + bytes(18433 - len(world)))
        self.assertLess(len(files["TRACK1WORLDS.LZS"]), 6995)
        with self.assertRaisesRegex(ValueError, "expands to"):
            validate_files(files)


if __name__ == "__main__":
    unittest.main()
