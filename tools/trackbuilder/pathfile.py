# Rush 2049 (Dreamcast) checkpoints + AI paths (TRACKnPATH.LZS / PATHBACK, decompressed). BIG-endian.
# From the game's loaders (checkpoints 0x8c04500c, paths 0x8c045bf0):
#   0x000  12-byte header: bytes 8-9 = checkpoint count (the rest is filled in at load)
#   0x00c  10 checkpoint slots x 80 bytes: f32 pos[3], f32 dir[3], s32 radius^2, u16 flags
#          (bit 0, 1, 2: start / finish markers; checkpoint 0 is the finish line, and the
#          start grid is placed from it), the rest is overwritten at load
#   0x32c  path header, 16 bytes: u16 point count, ..., u8 section count at +8
#          sections x 16 bytes: u16 at +2, +6, +10 (point count of the section)
#          u16 count + count x 6 bytes: s16 x, y, z  (the track's centre line)
#          each section's points, 6 bytes each
#          4 racing lines: 8-byte header (u16 point count, ...) + count x 8 bytes (s16 x, y, z, u16)
import struct

class Path:
    def __init__(self, data):
        self.data = data
        self.ncp = struct.unpack_from(">H", data, 8)[0]
        self.checkpoints = []
        for i in range(self.ncp):
            o = 0x0c + i * 80
            pos = struct.unpack_from(">3f", data, o); dirv = struct.unpack_from(">3f", data, o + 12)
            r2, flags = struct.unpack_from(">iH", data, o + 24)
            self.checkpoints.append(dict(pos=pos, dir=dirv, radius=r2 ** 0.5, flags=flags))
        o = 812
        self.header = data[o:o + 16]
        nsec = data[o + 8]
        o += 16
        self.sections = [struct.unpack_from(">8H", data, o + i * 16) for i in range(nsec)]
        o += nsec * 16
        n = struct.unpack_from(">H", data, o)[0]; o += 2       # the loader swaps this many points...
        self.centre = [struct.unpack_from(">3h", data, o + i * 6) for i in range(n)]
        o += struct.unpack_from(">H", self.header, 0)[0] * 6     # ...but skips the header's count
        self.section_points = []
        for s in self.sections:
            cnt = s[5]
            self.section_points.append([struct.unpack_from(">3h", data, o + i * 6) for i in range(cnt)])
            o += cnt * 6
        self.lines = []
        for k in range(4):
            hdr = struct.unpack_from(">4H", data, o); o += 8
            pts = [struct.unpack_from(">3hH", data, o + i * 8) for i in range(hdr[0])]
            o += hdr[0] * 8
            self.lines.append((hdr, pts))
        self.end = o

if __name__ == "__main__":
    import sys
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    from lzs import decode
    for f in sys.argv[1:]:
        p = Path(decode(open(f, "rb").read()))
        print(f, "len", len(p.data), "parsed to", p.end, "checkpoints", p.ncp, "header", p.header.hex(" "))
        print("  sections", p.sections[:4], "centre points", len(p.centre), p.centre[:3])
        for hdr, pts in p.lines: print("  line hdr", hdr, "points", len(pts), pts[:2])
