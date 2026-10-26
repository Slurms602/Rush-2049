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
from trackbuilder import Mesh, PVS_PREFIX_COUNT, road_file
from trackfile import Track
from worldsfile import Worlds


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
        files = {p.name: p.read_bytes() for p in (ROOT / "tracks/neon-skyway").glob("*.LZS")}
        self.assertEqual(len(files), 5)
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
