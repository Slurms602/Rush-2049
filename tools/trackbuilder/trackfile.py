# Rush 2049 (Dreamcast) track geometry file (TRACKn.LZS, decompressed).
# u32 toc_offset, u32 toc_count; table at toc_offset: [u32 tag, u32 offset, u32 count-or-size] x count.
# Tags: IMAG (texture data), OBHD (object headers, 72 bytes), PLHD, TXHD (texture headers, 48 bytes),
# OBJS (mesh streams), PATH / PTHD (paths, 24-byte headers).
#   OBHD: char name[16], f32 radius, u16 ?, s16 nparts, then nparts x 12: u16 ?, u16 flags (0x10: lit,
#         normals instead of colours), f32 draw distance, u32 file offset of the mesh stream.
#   TXHD: char name[16], u16 w, u16 h, u16 format, u16 ?, u32 ?, u32 ?, u32 offset into IMAG, ...
# Mesh stream (u32 words, from the game's walker at 0x8c026104): type = w & 0xE0000000
#   0xE0000000 end; 0x80000000 flags + 1 word; 0xA0000000 texture (w & 0xffff, 0xffff = none) + 1 word;
#   0x00000000 / 0x20000000 vertex (0x20000000 = last of a strip): bits 0x10000000 no position (reuse the
#   position of vertex (w >> 16) & 0xff), 0x08000000 no uv, 0x04000000 no colour (or no normal if lit);
#   then position f32[3], uv f32[2], colour u32 (or normal f32[3]). (w >> 8) & 0xff = this vertex's index.
import struct, sys

TAGS = {}
class Track:
    def __init__(self, data):
        self.data = data
        toc, n = struct.unpack_from("<2I", data, 0)
        self.chunks = {}
        for i in range(n):
            tag, off, cnt = struct.unpack_from("<3I", data, toc + i * 12)
            self.chunks[struct.pack(">I", tag).decode()] = (off, cnt)

    def objects(self):
        off, n = self.chunks["OBHD"]
        for i in range(n):
            o = off + i * 72
            name = self.data[o:o + 16].split(b"\0")[0].decode("latin1")
            radius = struct.unpack_from("<f", self.data, o + 16)[0]
            nparts = struct.unpack_from("<h", self.data, o + 22)[0]
            parts = []
            for p in range(nparts):
                a, flags, dist, moff = struct.unpack_from("<HHfI", self.data, o + 24 + p * 12)
                parts.append((flags, dist, moff))
            yield i, name, radius, parts

    def textures(self):
        off, n = self.chunks["TXHD"]
        for i in range(n):
            o = off + i * 48
            name = self.data[o:o + 16].split(b"\0")[0].decode("latin1")
            w, h, fmt = struct.unpack_from("<3H", self.data, o + 16)
            yield i, name, w, h, fmt, struct.unpack_from("<I", self.data, o + 24)[0]

    def mesh(self, moff, lit=False):
        """Decode one mesh stream into strips: lists of (pos, uv, texture index)."""
        d = self.data; p = moff; tex = -1; verts = {}; strips = []; cur = []
        while True:
            w = struct.unpack_from("<I", d, p)[0]; p += 4
            t = w & 0xE0000000
            if t == 0xE0000000: break
            if t == 0x80000000: p += 4; continue
            if t == 0xA0000000: tex = w & 0xffff; tex = -1 if tex == 0xffff else tex; p += 4; continue
            if t in (0, 0x20000000):
                vid = (w >> 8) & 0xff
                # Slots can be overwritten between strips. The hardware-facing
                # cache has 128 entries; total emitted vertices may be larger.
                if vid >= 128 or (w & 0x10000000 and ((w >> 16) & 0xff) >= 128):
                    raise ValueError("mesh vertex cache index exceeds 127")
                if w & 0x10000000: pos = verts.get((w >> 16) & 0xff, (0, 0, 0))
                else: pos = struct.unpack_from("<3f", d, p); p += 12
                uv = (0, 0)
                if not w & 0x08000000: uv = struct.unpack_from("<2f", d, p); p += 8
                if not w & 0x04000000: p += 12 if lit else 4
                verts[vid] = pos
                cur.append((pos, uv, tex))
                if t == 0x20000000: strips.append(cur); cur = []
                continue
            raise ValueError("unknown mesh word %08x at %x" % (w, p - 4))
        if cur: strips.append(cur)
        return strips

def positions(data, moff, lit=False):
    """Yield (file offset, (x, y, z)) for every vertex in a mesh stream that stores its own position."""
    p = moff
    while True:
        w = struct.unpack_from("<I", data, p)[0]; p += 4
        t = w & 0xE0000000
        if t == 0xE0000000: return
        if t in (0x80000000, 0xA0000000): p += 4; continue
        if not w & 0x10000000: yield p, struct.unpack_from("<3f", data, p); p += 12
        if not w & 0x08000000: p += 8
        if not w & 0x04000000: p += 12 if lit else 4

if __name__ == "__main__":
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from lzs import decode
    t = Track(decode(open(sys.argv[1], "rb").read()))
    print({k: (hex(v[0]), v[1]) for k, v in t.chunks.items()})
    bad = 0; total = 0
    for i, name, radius, parts in t.objects():
        for flags, dist, moff in parts:
            try:
                s = t.mesh(moff, bool(flags & 0x10)); total += sum(len(x) for x in s)
            except Exception as e:
                bad += 1
                if bad < 5: print("object", i, name, "part error:", e)
        if i < 8: print(i, name, round(radius, 1), [(hex(f), d) for f, d, _ in parts], "strips", len(t.mesh(parts[0][2], bool(parts[0][0] & 0x10))) if parts else 0)
    print("vertices decoded", total, "bad parts", bad)
