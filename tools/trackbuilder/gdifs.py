# List / extract files from a Dreamcast GDI's ISO9660 filesystem (high-density area).
# Usage: python3 -I gdifs.py <gdi> [extract-dir] [name-filter]
import sys, os, struct, re
gdi_path = sys.argv[1]; out = sys.argv[2] if len(sys.argv) > 2 else None; filt = sys.argv[3] if len(sys.argv) > 3 else None
d = os.path.dirname(gdi_path)
tracks = []
for line in open(gdi_path).read().split("\n")[1:]:
    p = line.split()
    if len(p) >= 6: tracks.append((int(p[1]), int(p[3]), os.path.join(d, p[4])))
tracks.sort()
def read_sector(lba):
    for i, (start, size, path) in enumerate(tracks):
        end = tracks[i + 1][0] if i + 1 < len(tracks) else 1 << 30
        if start <= lba < end:
            with open(path, "rb") as f:
                f.seek((lba - start) * size + (16 if size == 2352 else 0))
                return f.read(2048)
    raise ValueError(lba)
def read(lba, n):
    b = bytearray()
    for i in range((n + 2047) // 2048): b += read_sector(lba + i)
    return bytes(b[:n])
pvd = read_sector(45000 + 16)
assert pvd[1:6] == b"CD001", pvd[:8]
root = pvd[156:156 + 34]
def walk(lba, size, path):
    data = read(lba, size); i = 0
    while i < len(data):
        l = data[i]
        if l == 0: i = (i // 2048 + 1) * 2048; continue
        rec = data[i:i + l]; i += l
        ext, sz = struct.unpack("<I", rec[2:6])[0], struct.unpack("<I", rec[10:14])[0]
        flags, nl = rec[25], rec[32]; name = rec[33:33 + nl]
        if name in (b"\0", b"\1"): continue
        name = name.decode("latin1").split(";")[0]
        full = path + "/" + name
        if flags & 2: walk(ext, sz, full)
        else:
            print(f"{ext:8d} {sz:10d} {full}")
            if out and (not filt or re.search(filt, full, re.I)):
                os.makedirs(os.path.dirname(out + full), exist_ok=True)
                open(out + full, "wb").write(read(ext, sz))
walk(struct.unpack("<I", root[2:6])[0], struct.unpack("<I", root[10:14])[0], "")
