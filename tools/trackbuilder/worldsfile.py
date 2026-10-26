# Rush 2049 (Dreamcast) object placements (TRACKnWORLDS.LZS, decompressed).
# u32 ?, u32 ?, u32 ?, u32 first-record offset (32); char world name[16]; then 104-byte records:
#   char object[16], f32 rot[9], f32 pos[3], u32 flags (0x40), u16 next sibling (0xffff: end), u16 first child,
#   u32 ?, u32 object id (-1 for scenery; coins, cones etc. count up), f32 bbox min[3], max[3]
import struct

class Worlds:
    def __init__(self, data):
        self.data = data
        self.header = struct.unpack_from("<4I", data, 0)
        self.name = data[16:32].split(b"\0")[0].decode("latin1")
        self.records = []
        o = 32
        while o + 104 <= len(data):
            name = data[o:o + 16].split(b"\0")[0]
            if not name or not all(32 < c < 127 for c in name): break
            rot = struct.unpack_from("<9f", data, o + 16)
            pos = struct.unpack_from("<3f", data, o + 52)
            flags, index = struct.unpack_from("<IH", data, o + 64)
            bbox = struct.unpack_from("<6f", data, o + 80)
            self.records.append(dict(off=o, name=name.decode(), rot=rot, pos=pos, flags=flags, index=index, bbox=bbox))
            o += 104
        self.end = o
