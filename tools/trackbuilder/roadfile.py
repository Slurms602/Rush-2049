# Rush 2049 (Dreamcast) road/collision file (TRACKnROAD.LZS, decompressed).
# Layout (from the game's parser at 0x8c05145c): 8 u16 counts, then
#   spine    count[0] x 132  road cross-sections: pos f32[3], orientation f32[9] (rows: side, up, forward), ...
#   tree     count[1] x 20   quadtree: s16 parent, u16 flags, s16 minx, maxx, minz, maxz, s16 child[4]
#   surfs    count[2] x 24   u16 flags, u16 info (low 4 bits: vertex count), s16 uvs[9] (1.0 = 16384), u16 vlist offset
#   verts    count[3] x 8    s16 x, y, z (feet) + u16 fractions (x: bits 10-14, y: 5-9, z: 0-4, in 1/32 ft)
#   sect5    count[4] x 32   (unknown)
#   vlist    count[5] bytes  per surface: runs of [u16 big-endian first index, optional byte 0xE0|run-1]
#   leaves   rest of file    per leaf: u8 count + runs like vlist (surface indices); tree node child q is a
#                            node index if flags byte 3 bit q is set, else a leaf offset (bit 4+q: +0x10000)
import struct, sys

class Road:
    def __init__(self, data):
        self.data = data
        self.counts = struct.unpack_from("<8H", data, 0)
        c = self.counts
        o = 16
        self.spine_off = o; o += c[0] * 132
        self.tree_off = o; o += c[1] * 20
        self.surf_off = o; o += c[2] * 24
        self.vert_off = o; o += c[3] * 8
        self.s5_off = o; o += c[4] * 32
        self.vlist_off = o; o += c[5]
        self.rest_off = o
        # The leaf lists run to the end of the file; their size can exceed 16 bits (count[6]
        # wraps), which is why tree children carry a 17th offset bit in the node flags.
        assert (len(data) - o) & 0xffff == c[6], (o, c[6], len(data))

    def spine(self, i):
        o = self.spine_off + i * 132
        return struct.unpack_from("<3f", self.data, o), struct.unpack_from("<9f", self.data, o + 12)

    def vertex(self, i):
        x, y, z, f = struct.unpack_from("<3hH", self.data, self.vert_off + i * 8)
        return ((x * 32 + ((f & 0x7c00) >> 10)) / 32, (y * 32 + ((f & 0x3e0) >> 5)) / 32, (z * 32 + (f & 0x1f)) / 32)

    def surface(self, i):
        o = self.surf_off + i * 24
        flags, info = struct.unpack_from("<2H", self.data, o)
        uvs = struct.unpack_from("<9h", self.data, o + 4)
        vli = struct.unpack_from("<H", self.data, o + 22)[0]
        return flags, info, uvs, vli

    def surface_indices(self, i):
        flags, info, uvs, vli = self.surface(i)
        n = info & 15; p = self.vlist_off + vli; out = []
        d = self.data
        while n > 0:
            idx = d[p] << 8 | d[p + 1]; p += 2
            run = 0
            if n >= 2 and d[p] >= 0xE0:
                run = d[p] & 0x1f; p += 1
            n -= run + 1
            out.extend(range(idx, idx + run + 1))
        return out

    def surface_vertices(self, i):
        return [self.vertex(k) for k in self.surface_indices(i)]

if __name__ == "__main__":
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from lzs import decode
    r = Road(decode(open(sys.argv[1], "rb").read()))
    print("counts", r.counts)
    for i in range(3):
        print("surface", i, r.surface(i)[:2], r.surface_indices(i), [tuple(round(v, 2) for v in p) for p in r.surface_vertices(i)])
