"""Original procedural artwork and scenery for the chemical works circuit."""
import math
import numpy as np


def textures(base, encode):
    result = {t[0]: t for t in base}

    def add(name, image, fmt=1):
        image = np.clip(image, 0, 255)
        if image.shape[-1] == 3:
            image = np.concatenate([image, np.full(image.shape[:2] + (1,), 255)], -1)
        result[name] = (name, image.shape[1], image.shape[0], fmt,
                        0x08000000, 0x6008, encode(image, fmt))

    y, x = np.mgrid[0:128, 0:128] / 127
    seams = ((x * 6) % 1 < .045) | ((y * 4) % 1 < .045)
    road = np.full((128, 128, 3), [35., 86., 162.])
    road[seams] = [14, 38, 85]
    road[((x * 30 + y * 16) % 1 < .09) & ~seams] += [15, 24, 32]
    edge = (x < .09) | (x > .91)
    road[edge] = np.where((((x + y) * 12) % 1 < .5)[edge, None],
                          [255, 207, 38], [23, 25, 49])
    road[(abs(x - .5) < .012) & ((y * 2) % 1 < .52)] = [185, 242, 255]
    add("ROAD", road)
    rail = np.full((128, 128, 3), [20., 52., 119.])
    rail += np.exp(-((y - .38) / .16) ** 2)[..., None] * [225, 112, 12]
    rail[(y > .78)] = [246, 191, 32]
    rail[(x * 6) % 1 < .1] = [45, 125, 213]
    add("RAIL", rail)
    metal = np.full((128, 128, 3), [27., 73., 153.])
    metal[seams] = [12, 35, 83]
    bolts = (((x * 4) % 1 - .1) ** 2 + ((y * 4) % 1 - .1) ** 2) < .003
    metal[bolts] = [150, 191, 222]
    add("CHEMMETAL", metal)
    under = metal.copy()
    under[(y < .15) | (y > .85)] = [238, 116, 24]
    add("UNDER", under)
    pipe = np.full((128, 128, 3), [247., 123., 20.])
    pipe *= (.48 + .52 * np.sin(x * math.pi))[..., None]
    pipe[(y < .07) | (y > .92)] = [255, 211, 51]
    pipe[(y > .07) & (y < .1)] = [99, 49, 29]
    add("CHEMPIPE", pipe)
    wall = metal.copy()
    wall[((x * 6) % 1 < .14) | ((y * 4) % 1 < .09)] = [235, 145, 26]
    add("CHEMWALL", wall)
    wave = (np.sin(x * 4 * math.pi + np.sin(y * 6 * math.pi))
            + np.sin(y * 4 * math.pi + x * 8)) / 2
    liquid = np.full((128, 128, 3), [135., 18., 169.])
    liquid += wave[..., None] * [46, 15, 33]
    bubbles = ((x * 4 % 1 - .45) ** 2 + (y * 4 % 1 - .52) ** 2)
    liquid[(bubbles > .025) & (bubbles < .045)] = [240, 75, 218]
    liquid[(bubbles > .045) & (bubbles < .058)] = [81, 13, 126]
    add("VOID", liquid)
    # Distant factory towers, illuminated windows and violet industrial haze.
    y, x = np.mgrid[0:256, 0:256] / 255
    sky = np.array([68, 28, 103]) * (1 - y[..., None]) + np.array([15, 17, 54]) * y[..., None]
    skyline = .12 + .14 * ((np.floor(x * 22) * 13) % 11) / 11
    blocks = y < skyline
    sky[blocks] = [13, 38, 81]
    windows = blocks & (y > .045) & ((x * 128) % 1 < .24) & ((y * 70) % 1 < .35)
    sky[windows] = [222, 153, 55]
    stacks = (((x * 13) % 1) < .06) & (y < .35)
    sky[stacks] = [31, 60, 109]
    sky[stacks & ((y * 32) % 1 < .16)] = [223, 116, 33]
    add("SKY", sky)
    return sorted(result.values(), key=lambda t: t[0])


def sky(sec, tex_ids, Mesh):
    dome = Mesh(np.zeros(3))
    for lower in (False, True):
        dome.texture(tex_ids["VOID" if lower else "SKY"])
        for r in range(4):
            a0, a1 = math.pi * r / 8, math.pi * (r + 1) / 8
            verts = []
            for k in range(17):
                th = 2 * math.pi * k / 16
                for a in (a1, a0):
                    p = [1740 * math.cos(a) * math.cos(th),
                         (-1 if lower else 1) * 1150 * math.sin(a),
                         1740 * math.cos(a) * math.sin(th)]
                    verts.append((p, (k / 16 * 4, a / (math.pi / 2))))
            if lower:
                verts = [v for i in range(0, len(verts), 2) for v in (verts[i + 1], verts[i])]
            dome.strip(verts)
    return dome


def scenery(sec, tex_ids, Mesh, low):
    """Nine tiled liquid regions also batch the nearby tanks and pipe gantries.

    They remain after the protected visibility prefix. Batching keeps the complete
    placement table within the native WORLDS allocation, without giant floor quads.
    Props stand clear of the road and gantries have at least 60 ft of headroom.
    """
    center = (np.min([s["pos"] for s in sec], axis=0) + np.max([s["pos"] for s in sec], axis=0)) / 2
    pitch = 1100
    objects = []
    for iz in range(-1, 2):
        for ix in range(-1, 2):
            origin = np.array([center[0] + ix * pitch, low, center[2] + iz * pitch])
            m = Mesh(origin)
            m.texture(tex_ids["VOID"])
            for z in range(4):
                verts = []
                for x in range(5):
                    for dz in (0, 1):
                        p = origin + [(x / 4 - .5) * pitch, .25, ((z + dz) / 4 - .5) * pitch]
                        verts.append((p, (p[0] / 170, p[2] / 170)))
                m.strip(verts)
            objects.append((f"TRACK1L{80000 + len(objects):05d}", m))

    def region(p):
        return min((m for _, m in objects), key=lambda m: np.linalg.norm((m.origin - p)[[0, 2]]))

    def tube(mesh, points, radius, texture):
        points = np.array(points, float)
        rings = []
        for i, p in enumerate(points):
            t = points[min(i + 1, len(points) - 1)] - points[max(0, i - 1)]
            t /= np.linalg.norm(t)
            ref = [1, 0, 0] if abs(t[1]) > .9 else [0, 1, 0]
            side = np.cross(t, ref); side /= np.linalg.norm(side)
            up = np.cross(side, t)
            rings.append([p + radius * (math.cos(k * math.pi / 4) * side + math.sin(k * math.pi / 4) * up)
                          for k in range(8)])
        mesh.texture(tex_ids[texture])
        length = np.r_[0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
        for k in range(8):
            mesh.strip([v for i in range(len(points)) for v in
                        ((rings[i][(k + 1) % 8], ((k + 1) / 8, length[i] / 80)),
                         (rings[i][k], (k / 8, length[i] / 80)))])

    # Broad orange gantries frame the road and make the different sectors legible.
    for fraction in (.025, .34, .72):
        s = sec[int(len(sec) * fraction)]
        p = s["pos"]; side = s["S"]
        h = s["width"] / 2 + 54
        path = [p - side * h + [0, low + 10 - p[1], 0],
                p - side * h + [0, 40, 0],
                p - side * (h - 20) + [0, 66, 0],
                p - side * (h - 44) + [0, 72, 0],
                p + side * (h - 44) + [0, 72, 0],
                p + side * (h - 20) + [0, 66, 0],
                p + side * h + [0, 40, 0],
                p + side * h + [0, low + 10 - p[1], 0]]
        tube(region(p), path, 12, "CHEMPIPE")

    # Position tanks beside the course, checking every road branch at crossovers.
    positions = np.array([s["pos"] for s in sec])
    widths = np.array([s["width"] for s in sec])
    for fraction in (.12, .27, .48, .62, .85, .95):
        s = sec[int(len(sec) * fraction)]
        candidates = [s["pos"] + sign * s["S"] * offset for offset in (160, 220, 290)
                      for sign in (-1, 1)]
        p = next((p for p in candidates if np.all(np.linalg.norm((positions - p)[:, [0, 2]], axis=1) > widths / 2 + 85)), None)
        if p is None: continue
        m = region(p)
        base = np.array([p[0], low + 10, p[2]])
        top = base + [0, s["pos"][1] - low + 40, 0]
        tube(m, [base, top], 54, "CHEMMETAL")
        tube(m, [top + [0, -8, 0], top + [0, 8, 0]], 58, "CHEMPIPE")
        # Inset lid and a narrow outlet stack silhouette above the tank.
        m.texture(tex_ids["CHEMMETAL"])
        for k in range(8):
            a, b = k * math.pi / 4, (k + 1) * math.pi / 4
            q = top + [54 * math.cos(a), 8, 54 * math.sin(a)]
            r = top + [54 * math.cos(b), 8, 54 * math.sin(b)]
            m.strip([(top + [0, 8, 0], (.5, .5)), (q, (0, 0)), (r, (1, 0)), (r, (1, 0))])
        tube(m, [top + [0, 8, 0], top + [0, 65, 0]], 11, "CHEMPIPE")
    return objects
