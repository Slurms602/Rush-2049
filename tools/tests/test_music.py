"""Native STR format and stereo channel packing regression checks."""
import sys
from pathlib import Path
import struct
import unittest
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'trackbuilder'))
from music import encode_pcm, INTERLEAVE, RATE

class MusicTests(unittest.TestCase):
    def test_native_header_and_roundtrip(self):
        pcm = np.column_stack((np.arange(10000, dtype='<i2'), -np.arange(10000, dtype='<i2')))
        data = encode_pcm(pcm.tobytes())
        tracks, rate, bits, interleave, blocks, size, channels, end = struct.unpack_from('<8I', data)
        self.assertEqual((tracks, rate, bits, interleave, channels), (1, RATE, 16, INTERLEAVE, 2))
        self.assertEqual(len(data), 2048 + blocks * interleave * channels)
        self.assertEqual(end, blocks)
        self.assertEqual(size, (len(pcm) + INTERLEAVE) * 4)
        self.assertEqual(data[0xd5:0xe0], b'Sega Stream')
        decoded = np.frombuffer(data[2048:], dtype='<i2').reshape(blocks, 2, interleave//2).transpose(0, 2, 1).reshape(-1, 2)
        self.assertTrue(np.all(decoded[:INTERLEAVE] == 0))
        np.testing.assert_array_equal(decoded[INTERLEAVE:INTERLEAVE+len(pcm)], pcm)
        self.assertTrue(np.all(decoded[INTERLEAVE+len(pcm):] == 0))

    def test_rejects_incomplete_frames(self):
        for pcm in (b'', b'\x00', b'\x00'*6):
            with self.assertRaises(ValueError): encode_pcm(pcm)
