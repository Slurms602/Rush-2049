# Track builder: turns a track description (JSON) into the five files of a Rush 2049 (Dreamcast)
# track slot: TRACKn.LZS (textures + meshes), TRACKnROAD.LZS (collision), TRACKnPATH.LZS and
# TRACKnPATHBACK.LZS (checkpoints + AI lines), TRACKnWORLDS.LZS (object placements).
#
# Description: {"name": "...", "slot": n, "points": [{"x", "y", "z", "width", "bank", "gap", "rails"}...]}
# The points are control points of a closed loop (Catmull-Rom), in feet, y up. width (ft, default 60),
# bank (degrees, + leans the road's right side down... whichever side: see frames()), gap (no road
# from this point to the next: you have to fly), rails (side walls, default true).
#
# Usage: python3 trackbuilder.py <track.json> <out dir>
import json, math, os, struct, sys
# Fix the float32 k-means reduction order so builds reproduce the texture bytes.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
import numpy as np
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lzs import encode

STEP = 10.0          # ft between road cross-sections
CHUNK = 45           # cross-sections per object; each strip uses at most 92 cache slots
RAIL_H = 8.0         # rail height, ft
DEPTH = 4.0          # road slab thickness (visual)
PVS_PREFIX_COUNT = 117  # Marina's executable culls exactly this many leading scenery records
PVS_PADDING_NAME = "TRACK1L99999"

# ---------------------------------------------------------------- centre line
def catmull(points, samples=40):
    """Closed centripetal Catmull-Rom through the control points, densely sampled."""
    P = np.array(points, float); n = len(P); out = []
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        for t in np.linspace(t1, t2, samples, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append(((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2, i, (t - t1) / (t2 - t1)))
    return out

def resample(desc):
    pts = desc["points"]
    dense = catmull([[p["x"], p["y"], p["z"]] for p in pts])
    P = np.array([d[0] for d in dense]); seg = [d[1] for d in dense]; frac = [d[2] for d in dense]
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.vstack([P, P[:1]]), axis=0), axis=1))])
    total = L[-1]; n = int(round(total / STEP)); out = []
    for k in range(n):
        s = k * total / n
        j = min(np.searchsorted(L, s, side="right") - 1, len(P) - 1)
        u = (s - L[j]) / max(L[j + 1] - L[j], 1e-9)
        pos = P[j] * (1 - u) + P[(j + 1) % len(P)] * u
        a, b = pts[seg[j]], pts[(seg[j] + 1) % len(pts)]
        f = frac[j]
        lerp = lambda key, dflt: a.get(key, dflt) * (1 - f) + b.get(key, dflt) * f
        out.append(dict(pos=pos, s=s, width=lerp("width", 60.0), bank=lerp("bank", 0.0),
                        gap=bool(a.get("gap", False)), rails=bool(a.get("rails", True))))
    return out, total

def frames(sec):
    n = len(sec)
    for k, c in enumerate(sec):
        T = sec[(k + 1) % n]["pos"] - sec[(k - 1) % n]["pos"]; T /= np.linalg.norm(T)
        S = np.cross(T, [0.0, 1.0, 0.0]); S /= np.linalg.norm(S)
        N = np.cross(S, T)
        b = math.radians(c["bank"])
        c["T"], c["S"], c["N"] = T, S * math.cos(b) + N * math.sin(b), N * math.cos(b) - S * math.sin(b)
        c["L"] = c["pos"] - c["S"] * c["width"] / 2
        c["R"] = c["pos"] + c["S"] * c["width"] / 2

# ---------------------------------------------------------------- textures
def tw(v):
    r = 0
    for b in range(12): r |= ((v >> b) & 1) << (2 * b)
    return r

def pack_pixels(img, fmt):
    """img: h x w x 4 (RGBA 0-255) -> 16-bit pixels: fmt 1 RGB565, fmt 0 ARGB4444."""
    img = np.clip(img, 0, 255).astype(np.uint16)
    if fmt == 1: return (img[..., 0] >> 3) << 11 | (img[..., 1] >> 2) << 5 | (img[..., 2] >> 3)
    return (img[..., 3] >> 4) << 12 | (img[..., 0] >> 4) << 8 | (img[..., 1] >> 4) << 4 | (img[..., 2] >> 4)

def vq_encode(img, fmt, iters=10):
    """PowerVR VQ (no mipmaps): 256-entry codebook of 2x2 blocks (texels (x0,y0),(x0,y1),(x1,y0),
    (x1,y1)) followed by one index byte per block, blocks in twiddled order."""
    h, w = img.shape[:2]; bh, bw = h // 2, w // 2
    blocks = np.stack([img[0::2, 0::2], img[1::2, 0::2], img[0::2, 1::2], img[1::2, 1::2]], 2).reshape(bh * bw, 16).astype(np.float32)
    rng = np.random.RandomState(1)
    uniq = np.unique(blocks, axis=0)
    cent = uniq[rng.choice(len(uniq), min(256, len(uniq)), replace=False)] if len(uniq) > 256 else uniq
    for _ in range(iters if len(uniq) > 256 else 1):
        d = (blocks ** 2).sum(1)[:, None] - 2 * blocks @ cent.T + (cent ** 2).sum(1)[None, :]
        lab = d.argmin(1)
        for k in range(len(cent)):
            m = lab == k
            if m.any(): cent[k] = blocks[m].mean(0)
    d = (blocks ** 2).sum(1)[:, None] - 2 * blocks @ cent.T + (cent ** 2).sum(1)[None, :]
    lab = d.argmin(1)
    book = np.zeros((256, 4), np.uint16)
    book[:len(cent)] = pack_pixels(cent.reshape(-1, 4, 4), fmt)
    order = np.zeros(bh * bw, np.uint8)
    for by in range(bh):
        for bx in range(bw):
            order[tw(by) | (tw(bx) << 1)] = lab[by * bw + bx]
    return book.astype("<u2").tobytes() + order.tobytes()

def make_textures():
    """Our textures, plus our own versions of the ones every track has (the game looks those up
    by name: car reflections, props). Returns [(name, w, h, fmt, word1c, flags, data)]."""
    def grid(n): return np.mgrid[0:n, 0:n] / (n - 1)
    def rgba(c, a=255): return np.concatenate([c, np.full(c.shape[:2] + (1,), a)], -1)
    out = []
    def add(name, img, fmt=1, w1c=0x08000000, flags=0x6008):
        out.append((name, img.shape[1], img.shape[0], fmt, w1c, flags, vq_encode(img, fmt)))
    n = 128; y, x = grid(n)
    road = np.zeros((n, n, 3)) + [70, 74, 110]
    road[np.minimum(np.abs((x * 4) % 1 - 0.5), np.abs((y * 4) % 1 - 0.5)) > 0.46] = [90, 230, 255]
    road[(x < 0.06) | (x > 0.94)] = [255, 40, 200]
    road[(x > 0.48) & (x < 0.52) & ((y * 8) % 1 < 0.5)] = [240, 240, 255]
    add("ROAD", rgba(road))
    rail = np.zeros((n, n, 3)) + [40, 50, 100]
    rail += np.exp(-((y - 0.7) ** 2) / 0.01)[..., None] * [120, 255, 255]
    rail[((x * 8) % 1 < 0.08)] = [90, 90, 140]
    add("RAIL", rgba(rail))
    under = np.zeros((n, n, 3)) + [30, 30, 38]
    under[((x * 4) % 1 < 0.04) | ((y * 4) % 1 < 0.04)] = [70, 70, 90]
    add("UNDER", rgba(under))
    sky = np.array([255, 120, 200]) * (1 - y[..., None]) ** 2 + np.array([40, 30, 120]) * (1 - (1 - y[..., None]) ** 2)
    rng = np.random.RandomState(7)
    for _ in range(90): sx, sy = rng.randint(0, n, 2); sky[sy, sx] = [255, 255, 255]
    add("SKY", rgba(sky))
    void = np.zeros((n, n, 3)) + [8, 6, 20]
    void[((x * 8) % 1 < 0.03) | ((y * 8) % 1 < 0.03)] = [60, 20, 90]
    add("VOID", rgba(void))
    # The shared set (sizes, formats and flags as the game's own).
    def sheen(n):
        # Car reflections: the game's are mostly transparent (alpha ~4/15).
        y, x = grid(n)
        c = np.array([120, 110, 200]) * (1 - y[..., None]) + np.array([255, 160, 230]) * np.exp(-((y - 0.55) ** 2) / 0.01)[..., None]
        return rgba(np.clip(c, 0, 255), 64)
    add("SHEEN0", sheen(512), fmt=0, w1c=0x08008001, flags=0x6000)
    for k in ("SHEENS1", "SHEENS2", "SHEENS3", "SHEENT1", "SHEENT2", "SHEENT3"):
        add(k, sheen(256), fmt=0, w1c=0x08008011, flags=0x26000)
    y, x = grid(64)
    add("CHECKERS", rgba(np.where(((x * 8).astype(int) + (y * 8).astype(int)) % 2 == 0, 255, 20)[..., None].repeat(3, -1)))
    add("CAUTIONZ", rgba(np.where(((x + y) * 4 % 1) < 0.5, 1, 0)[..., None] * np.array([250, 210, 0]) + 10))
    fence = rgba(np.full((64, 64, 3), 160), 0); fence[((x + y) * 8 % 1 < 0.12) | ((x - y) * 8 % 1 < 0.12), 3] = 255
    add("CHAINLINK", fence, fmt=0, w1c=0x08008001)
    for k, c in (("AL_COLUN3", 150), ("MOSTUCCO", 180), ("MOTTOP2E", 120)):
        add(k, rgba(np.full((64, 64, 3), c) + (((x * 4) % 1 < 0.05) * 30)[..., None]))
    y, x = grid(128)
    for k, c in (("CONCRETE2", [140, 140, 150]), ("TRP_PANLS", [90, 100, 120])):
        add(k, rgba(np.full((128, 128, 3), c) + (((x * 4) % 1 < 0.03) | ((y * 4) % 1 < 0.03))[..., None] * 40))
    for k, c in (("DRAGONDC", [200, 40, 40]), ("SLIMJIMDC", [40, 120, 220])):
        add(k, rgba(np.full((128, 128, 3), 30) + ((np.abs(y - 0.5) < 0.2))[..., None] * np.array(c)))
    tree = rgba(np.zeros((128, 128, 3)) + [20, 90, 40], 0)
    tree[(np.abs(x - 0.5) < (y * 0.45)) & (y < 0.85), 3] = 255
    tree[(np.abs(x - 0.5) < 0.05) & (y >= 0.85)] = [80, 50, 20, 255]
    add("SPRUCE_01", tree, fmt=0, w1c=0x08038000)
    y, x = grid(512)
    land = np.zeros((512, 512, 3)) + [15, 12, 30]
    land[((x * 16) % 1 < 0.04) | ((y * 16) % 1 < 0.04)] = [70, 30, 110]
    add("LANDTEX_03", rgba(land), w1c=0x08900000)
    # Named texture lookups use the exported table's alphabetical order.
    return sorted(out, key=lambda t: t[0])

# ---------------------------------------------------------------- meshes
class Mesh:
    """One mesh stream: texture switches and triangle strips (positions relative to `origin`)."""
    def __init__(self, origin):
        self.origin = origin; self.words = bytearray(); self.vid = 0; self.pts = []
    def texture(self, i):
        self.words += struct.pack("<II", 0xA0000000 | i, 0)
    def strip(self, verts):
        # Each generated strip consists of cross-section pairs. Rush renders the
        # clockwise side, so swap the pair's sides (reversing the entire even-length
        # strip would preserve its facing). This also makes the deck's diagonal match
        # the collision triangles, and puts the sky's visible side inside the dome.
        assert len(verts) % 2 == 0
        verts = [v for k in range(0, len(verts), 2) for v in (verts[k + 1], verts[k])]
        # Every vertex below supplies its full position, so a new strip can
        # overwrite the cache slots used by the previous strip. The limit is
        # 128 live slots, not 128 total emitted vertices in the whole object.
        self.vid = 0
        # Vertex word: bits 8-15 slot in the transformed-vertex table and bits 16-23 position
        # index (both at most 127 per object in the game's data), low byte colour slot.
        for k, (p, uv) in enumerate(verts):
            last = k == len(verts) - 1
            v = self.vid; self.vid += 1
            assert v < 128, "a strip can use at most 128 vertex cache slots"
            w = (0x20000000 if last else 0) | (v << 16) | (v << 8)
            q = np.asarray(p) - self.origin; self.pts.append(q)
            self.words += struct.pack("<I3f2fI", w, *q, *uv, 0xFFFFFFFF)
    def finish(self):
        self.words += struct.pack("<I", 0xE0000000)
        return bytes(self.words)

def build_meshes(sec, tex_ids, total):
    n = len(sec); objects = []
    for start in range(0, n, CHUNK):
        end = min(start + CHUNK, n)              # sections start..end (end wraps to 0 on the last chunk)
        ids = [k % n for k in range(start, end + 1)]
        m = Mesh(sec[start]["pos"].copy())
        runs = []; cur = []
        for a, b in zip(ids, ids[1:]):
            if sec[a]["gap"]:
                if cur: runs.append(cur); cur = []
                continue
            if not cur: cur = [a]
            cur.append(b)
        if cur: runs.append(cur)
        for run in runs:
            dist = lambda k: sec[k]["s"] if k or run[0] == 0 else total
            vv = lambda k: dist(k) / 60.0
            m.texture(tex_ids["ROAD"])
            m.strip([v for k in run for v in ((sec[k]["L"], (0.0, vv(k))), (sec[k]["R"], (1.0, vv(k))))])
            m.texture(tex_ids["UNDER"])
            m.strip([v for k in run for v in ((sec[k]["R"] - sec[k]["N"] * DEPTH, (1.0, vv(k))),
                                                (sec[k]["L"] - sec[k]["N"] * DEPTH, (0.0, vv(k))))])
            for side, sgn in (("L", -1), ("R", 1)):
                if not all(sec[k]["rails"] for k in run[:-1]): continue
                m.texture(tex_ids["RAIL"])
                top = lambda k: sec[k][side] + sec[k]["N"] * RAIL_H
                if sgn < 0:
                    m.strip([v for k in run for v in ((top(k), (vv(k), 0.0)), (sec[k][side], (vv(k), 1.0)))])
                else:
                    m.strip([v for k in run for v in ((sec[k][side], (vv(k), 1.0)), (top(k), (vv(k), 0.0)))])
        if m.pts: objects.append(m)
    return objects

def sky_and_void(sec, tex_ids):
    c = np.mean([s["pos"] for s in sec], axis=0)
    span = max(np.ptp([s["pos"][0] for s in sec]), np.ptp([s["pos"][2] for s in sec])) / 2 + 3000
    # The engine draws SKYSKY around the camera: a dome like the game's (radius ~1740, 1150 high).
    sky = Mesh(np.zeros(3)); sky.texture(tex_ids["SKY"])
    rings = 4; segs = 12
    for r in range(rings):
        a0, a1 = math.pi / 2 * r / rings, math.pi / 2 * (r + 1) / rings
        verts = []
        for k in range(segs + 1):
            th = 2 * math.pi * k / segs
            for a, v in ((a1, (r + 1) / rings), (a0, r / rings)):
                verts.append((np.array([1740 * math.cos(a) * math.cos(th), 1150 * math.sin(a), 1740 * math.cos(a) * math.sin(th)]),
                              (k / segs * 4, 1 - v)))
        sky.strip(verts)
    low = min(s["pos"][1] for s in sec) - 400
    # The void is the space below the floating road; only its fall-reset
    # collision plane is needed, without a giant visible floor quad.
    return sky, low, span, c

# ---------------------------------------------------------------- TRACKn.LZS
def track_file(slot, objects, textures):
    # The game's named model lookup expects OBHD in alphabetical order (including
    # SKYSKY). Placements reference names, so their sibling/child order is unaffected.
    objects = sorted(objects, key=lambda obj: obj[0])
    imag = b""; txhd = b""
    for name, w, h, fmt, w1c, flags, data in textures:
        imag += b"\0" * (-len(imag) % 32)
        txhd += (name.encode().ljust(16, b"\0") + struct.pack("<HHBBHIII", w, h, 2, fmt, 0xFFFF, len(imag), w1c, flags)).ljust(48, b"\0")
        imag += data
    imag += b"\0" * (-len(imag) % 32)
    off_imag = 8
    off_obhd = off_imag + len(imag)
    obhd_size = 72 * len(objects)
    off_txhd = off_obhd + obhd_size
    off_objs = off_txhd + len(txhd)
    streams = [m.finish() for _, m in objects]
    obhd = b""; o = off_objs
    for (name, m), st in zip(objects, streams):
        radius = max(float(np.linalg.norm(p)) for p in m.pts) + 1.0
        obhd += (name.encode().ljust(16, b"\0") + struct.pack("<fhh", radius, 0, 1)
                 + struct.pack("<HHfI", 0, 0, 0.0, o)).ljust(72, b"\0")
        o += len(st)
    objs = b"".join(streams)
    off_path = off_objs + len(objs)
    toc_off = off_path
    toc = [(b"IMAG", off_imag, len(imag)), (b"OBHD", off_obhd, len(objects)), (b"PLHD", off_txhd, 0),
           (b"TXHD", off_txhd, len(textures)), (b"OBJS", off_objs, len(objs)), (b"PATH", off_path, 0), (b"PTHD", off_path, 0)]
    out = struct.pack("<II", toc_off, len(toc)) + imag + obhd + txhd + objs
    assert len(out) == toc_off
    out += b"".join(struct.pack("<III", struct.unpack(">I", t)[0], a, b) for t, a, b in toc)
    return out

# ---------------------------------------------------------------- TRACKnWORLDS.LZS
def coin_spots(sec):
    """8 gold and 8 silver coins (the game expects exactly that many): silver spread around the
    lap 5 ft above the road, gold in the air over the gaps where there are any, else between."""
    n = len(sec)
    silver = [sec[int((k + 0.25) * n / 8)]["pos"] + sec[int((k + 0.25) * n / 8)]["N"] * 5 for k in range(8)]
    gaps = [k for k in range(n) if sec[k]["gap"]]
    if gaps:
        gold = [sec[gaps[int(k * len(gaps) / 8)]]["pos"] + [0, 12, 0] for k in range(8)]
    else:
        gold = [sec[int((k + 0.75) * n / 8)]["pos"] + sec[int((k + 0.75) * n / 8)]["N"] * 5 for k in range(8)]
    return [("GOLDCOIN", p) for p in gold] + [("SILVERCOIN", p) for p in silver]

def reserve_visibility_slots(objects, tex_ids, low, center):
    """Absorb Marina's fixed scenery visibility bitmap before any authored objects.

    The executable culls 117 leading render objects using the original track's
    bitmap. Without this prefix it hides arbitrary road pieces and car parts.
    One tiny, offscreen model supplies all 117 inert placements. Compact road
    objects keep the complete WORLDS file inside its fixed decompression buffer.
    """
    origin = np.array([center[0], low - 12000.0, center[2]])
    dummy = Mesh(origin); dummy.texture(tex_ids["UNDER"])
    dummy.strip([(origin + [0, 0, 0], (0, 0)), (origin + [1, 0, 0], (1, 0)),
                 (origin + [0, 0, 1], (0, 1)), (origin + [1, 0, 1], (1, 1))])
    padding = (PVS_PADDING_NAME, dummy)
    return objects + [padding], [padding] * PVS_PREFIX_COUNT + objects

def worlds_file(slot, objects, coins):
    """Placements: one record per object (siblings), coins as children of the nearest piece."""
    recs = []; lo = np.array([1e9, 1e9]); hi = -lo
    for i, (name, m) in enumerate(objects):
        P = np.array(m.pts); mn, mx = P.min(0), P.max(0)
        recs.append(dict(name=name, pos=m.origin, next=i + 1 if i + 1 < len(objects) else 0xFFFF,
                         child=0xFFFF, id=0xFFFFFFFF, mn=mn, mx=mx))
        w = m.origin[[0, 2]]; lo = np.minimum(lo, w + mn[[0, 2]]); hi = np.maximum(hi, w + mx[[0, 2]])
    pieces = [k for k, (name, m) in enumerate(objects) if name.startswith("TRACK")]
    for cid, (name, pos) in enumerate(coins):
        parent = min(pieces, key=lambda k: np.linalg.norm(objects[k][1].origin - pos))
        idx = len(recs)
        recs.append(dict(name=name, pos=pos, next=recs[parent]["child"], child=0xFFFF, id=cid, mn=np.zeros(3), mx=np.zeros(3)))
        recs[parent]["child"] = idx
    out = b""
    for r in recs:
        out += (r["name"].encode().ljust(16, b"\0") + struct.pack("<9f", 1, 0, 0, 0, 1, 0, 0, 0, 1)
                + struct.pack("<3f", *r["pos"])
                # flags, next sibling (0xffff ends), first child, ?, interactive object id (-1: scenery)
                + struct.pack("<IHHII", 0x40, r["next"], r["child"], 0, r["id"])
                + struct.pack("<6f", *r["mn"], *r["mx"]))
    whdr = struct.pack("<II", 1, 32) + f"TRACK{slot}".encode().ljust(16, b"\0")
    gtld = struct.pack(f"<{len(coins)}I", *range(len(coins)))
    off_wobj = 32; off_gtld = off_wobj + len(out); off_gdat = off_gtld + len(gtld)
    # Quadtree of interactive objects (coins, cones...): one leaf (flags 0x10; 1 = four children)
    # holding all of them: count, start in the GTLD list.
    gdat = struct.pack("<hBB4fHHHH", -1, 0, 0x10, lo[0] - 100, hi[0] + 100, lo[1] - 100, hi[1] + 100, len(coins), 0, 0, 0)
    toc_off = off_gdat + len(gdat)
    data = struct.pack("<II", toc_off, 4) + whdr + out + gtld + gdat
    assert len(data) == toc_off
    for t, a, b in ((b"WHDR", 8, 24), (b"WOBJ", off_wobj, len(recs)), (b"GTLD", off_gtld, len(coins)), (b"GDAT", off_gdat, 1)):
        data += struct.pack("<III", struct.unpack(">I", t)[0], a, b)
    return data

# ---------------------------------------------------------------- TRACKnROAD.LZS
def fix32(v):
    iv = int(math.floor(v * 32 + 0.5)); return iv >> 5, iv & 31

def road_file(polys):
    """polys: [(points (3 or 4 world xyz), normal, surface flags)] -> collision file bytes."""
    surfs = b""; verts = b""; vlist = bytearray(); boxes = []; nv = 0
    for i, (pts, normal, flags) in enumerate(polys):
        pts = [np.asarray(p, float) for p in pts]
        o = pts[0]
        r0 = pts[1] - o; r0 /= np.linalg.norm(r0)
        # Collision tests use y=0 in this frame as the contact plane. Averaging
        # the cross-section normals leaves the third corner off that plane on
        # changing slopes/banks, creating steps between neighboring triangles.
        r1 = np.cross(pts[1] - o, pts[2] - o)
        r1 /= np.linalg.norm(r1)
        if np.dot(r1, normal) < 0: r1 = -r1
        r2 = np.cross(r0, r1)
        M = np.array([r0, r1, r2])
        if np.dot(pts[2] - o, r2) < 0:                       # third corner on the +z side
            pts = [pts[0]] + pts[1:][::-1]
            r0 = pts[1] - o; r0 /= np.linalg.norm(r0)
            r2 = np.cross(r0, r1); M = np.array([r0, r1, r2])
        local = [M @ (p - o) for p in pts[1:]]
        first = nv
        for v in [o] + local:
            (xi, xf), (yi, yf), (zi, zf) = fix32(v[0]), fix32(v[1]), fix32(v[2])
            verts += struct.pack("<3hH", xi, yi, zi, (xf << 10) | (yf << 5) | zf)
            nv += 1
        n = len(pts)
        vli = len(vlist)
        vlist += bytes([first >> 8, first & 0xff, 0xE0 | (n - 1)]) + bytes([first >> 8, first & 0xff])
        uvs = [max(-32768, min(32767, int(round(c * 16384)))) for c in M.flatten()]
        surfs += struct.pack("<HH9hH", flags, n, *uvs, vli)
        P = np.array(pts); boxes.append((P[:, 0].min(), P[:, 0].max(), P[:, 2].min(), P[:, 2].max()))
    assert len(polys) < 8192 and nv < 65536
    # Quadtree over x/z: leaves list the surfaces overlapping them.
    B = np.array(boxes)
    root = [int(math.floor(B[:, 0].min())) - 8, int(math.ceil(B[:, 1].max())) + 8,
            int(math.floor(B[:, 2].min())) - 8, int(math.ceil(B[:, 3].max())) + 8]
    nodes = []; leaves = bytearray(b"\0")              # offset 0 means "empty"
    def mid(a, b):
        s = a + b
        if s < 0: s += 1
        return s >> 1
    def leaf_list(ids):
        ids = sorted(ids); out = bytearray([len(ids)]); k = 0
        while k < len(ids):
            run = 0
            while run < 7 and k + run + 1 < len(ids) and ids[k + run + 1] == ids[k] + run + 1: run += 1
            v = (run << 13) | ids[k]; out += bytes([v >> 8, v & 0xff]); k += run + 1
        return out
    def build(box, ids, parent, depth):
        me = len(nodes); nodes.append(None)
        mx, mz = mid(box[0], box[1]), mid(box[2], box[3])
        quads = [(box[0], mx, mz, box[3]), (mx, box[1], mz, box[3]), (box[0], mx, box[2], mz), (mx, box[1], box[2], mz)]
        children = [0] * 4; fl_nodes = 0; fl_hi = 0
        for q, (x0, x1, z0, z1) in enumerate(quads):
            sub = [i for i in ids if B[i, 1] >= x0 - 1 and B[i, 0] <= x1 + 1 and B[i, 3] >= z0 - 1 and B[i, 2] <= z1 + 1]
            if not sub: continue
            if len(sub) > 20 and depth < 12 and (x1 - x0) > 24 and (z1 - z0) > 24:
                children[q] = build((x0, x1, z0, z1), sub, me, depth + 1); fl_nodes |= 1 << q
            else:
                assert len(sub) <= 255
                off = len(leaves); leaves.extend(leaf_list(sub))
                children[q] = off & 0xffff
                if off >> 16: fl_hi |= 1 << (4 + q)
        nodes[me] = struct.pack("<hBB4h4H", parent, 0, fl_nodes | fl_hi, box[0], box[1], box[2], box[3], *children)
        return me
    build(tuple(root), list(range(len(polys))), -1, 0)
    tree = b"".join(nodes)
    counts = (0, len(nodes), len(polys), nv, 0, len(vlist), len(leaves) & 0xffff, len(leaves) >> 16)
    return struct.pack("<8H", *counts) + tree + surfs + verts + bytes(vlist) + bytes(leaves)

def collision(sec, low, span, c):
    polys = []; n = len(sec)
    for k in range(n):
        a, b = sec[k], sec[(k + 1) % n]
        if a["gap"]: continue
        up = (a["N"] + b["N"]) / 2
        polys.append(((a["L"], a["R"], b["R"]), up, 0x0000))
        polys.append(((a["L"], b["R"], b["L"]), up, 0x0000))
        if a["rails"]:
            for side, inward in (("L", (a["S"] + b["S"]) / 2), ("R", -(a["S"] + b["S"]) / 2)):
                p0, p1 = a[side], b[side]; p2, p3 = p1 + b["N"] * RAIL_H, p0 + a["N"] * RAIL_H
                polys.append(((p0, p1, p2), inward, 0x0005))
                polys.append(((p0, p2, p3), inward, 0x0005))
    # Crash surface far below, in tiles (local coordinates must fit 16 bits). Surface 2
    # is merely low-friction water and lets a fallen car keep driving under the track;
    # surface 7 is the game's crash material.
    tile = 1000.0
    xs = np.arange(c[0] - span, c[0] + span, tile); zs = np.arange(c[2] - span, c[2] + span, tile)
    for x in xs:
        for z in zs:
            q = [np.array([x, low, z]), np.array([x + tile, low, z]), np.array([x + tile, low, z + tile]), np.array([x, low, z + tile])]
            polys.append(((q[0], q[1], q[2]), [0, 1, 0], 0x0007))
            polys.append(((q[0], q[2], q[3]), [0, 1, 0], 0x0007))
    return polys

# ---------------------------------------------------------------- TRACKnPATH.LZS
def path_file(sec, total, reverse=False, ncp=6):
    n = len(sec); order = list(range(n))
    if reverse: order = [0] + order[1:][::-1]
    pick = lambda k: sec[order[k % n]]
    fwd = lambda c: -c["T"] if reverse else c["T"]
    cp = bytearray(812); struct.pack_into(">H", cp, 8, ncp)
    for i in range(ncp):
        c = pick(int(i * n / ncp))
        r = c["width"] * 0.75 + 20
        struct.pack_into(">3f3fiH", cp, 0x0c + i * 80, *c["pos"], *fwd(c), int(r * r), 7 if i == 0 else 0)
    # Centre line every 2 sections (20 ft), and four racing lines across the road.
    centre = [pick(k)["pos"] for k in range(0, n, 2)]
    out = bytearray(cp)
    hdr = bytearray(16); struct.pack_into(">H", hdr, 0, len(centre)); out += hdr
    out += struct.pack(">H", len(centre))
    for p in centre: out += struct.pack(">3h", *(int(round(v)) for v in p))
    for lane in (-0.25, 0.25, -0.1, 0.1):
        pts = []
        for k in range(0, n, 2):
            c = pick(k); p = c["pos"] + c["S"] * c["width"] * lane
            pts.append(struct.pack(">3hH", *(int(round(v)) for v in p), 0xB403))
        out += struct.pack(">4H", len(pts), 0, 0, 0) + b"".join(pts)
    return bytes(out)

# ---------------------------------------------------------------- main
def build(desc, outdir):
    slot = desc.get("slot", 1)
    if slot != 1:
        raise ValueError("This builder currently supports Marina (slot 1) only.")
    sec, total = resample(desc); frames(sec)
    textures = make_textures(); tex_ids = {t[0]: i for i, t in enumerate(textures)}
    meshes = build_meshes(sec, tex_ids, total)
    sky, low, span, c = sky_and_void(sec, tex_ids)
    # Objects named TRACKnL... come from this track's file; any other name (except SKYSKY) is a
    # shared object (coins, cones...), and the game waits forever for one that doesn't exist.
    objects = [(f"TRACK{slot}L{i + 1:05d}", m) for i, m in enumerate(meshes)][:desc.get("max_objects", 10**6)]
    objects, placements = reserve_visibility_slots(objects, tex_ids, low, c)
    if desc.get("sky", True): objects.append(("SKYSKY", sky))
    files = {
        f"TRACK{slot}.LZS": track_file(slot, objects, textures),
        # SKYSKY is drawn by the engine itself: it is in the track file but never placed.
        f"TRACK{slot}WORLDS.LZS": worlds_file(slot, placements, coin_spots(sec)),
        f"TRACK{slot}ROAD.LZS": road_file(collision(sec, low, span, c)),
        f"TRACK{slot}PATH.LZS": path_file(sec, total),
        f"TRACK{slot}PATHBACK.LZS": path_file(sec, total, reverse=True),
    }
    for name, data in files.items():
        enc = encode(data)
        open(f"{outdir}/{name}", "wb").write(enc)
        print(f"{name}: {len(data)} bytes, {len(enc)} compressed")
    print(f"track length {total:.0f} ft, {len(sec)} sections, {len(meshes)} road objects")
    return sec

if __name__ == "__main__":
    build(json.load(open(sys.argv[1])), sys.argv[2])
