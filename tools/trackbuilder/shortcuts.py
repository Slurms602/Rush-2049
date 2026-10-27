"""Optional launch lanes. AI follows the main loop; players may fly across its bends."""
import math
import numpy as np


def validate(desc, sec):
    count = len(desc["points"])
    checkpoints = desc.get("checkpoints")
    if checkpoints is not None:
        if (not isinstance(checkpoints, list) or len(checkpoints) != 6
                or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in checkpoints)
                or checkpoints[0] != 0 or checkpoints != sorted(set(checkpoints))
                or not 0 <= checkpoints[-1] < count):
            raise ValueError("Use six ordered checkpoint progress values, beginning at zero.")
        if any(sec[index_at(sec, v)]["gap"] for v in checkpoints):
            raise ValueError("Checkpoints must be on solid road.")
    specs = desc.get("shortcuts", [])
    if not isinstance(specs, list) or len(specs) > 4:
        raise ValueError("Use at most four optional shortcuts.")
    if specs and checkpoints is None:
        raise ValueError("Shortcuts require explicit checkpoints outside their skipped turns.")
    ids = set(); ranges = []
    for spec in specs:
        if not isinstance(spec.get("id"), str) or not spec["id"] or spec["id"] in ids:
            raise ValueError("Each shortcut needs a unique id.")
        ids.add(spec["id"])
        a, b = spec.get("entry"), spec.get("rejoin")
        if (not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (a, b))
                or not 0 < a < b < count - .5):
            raise ValueError("Shortcut entry must precede its rejoin without crossing the finish.")
        if any(a <= cp <= b for cp in checkpoints):
            raise ValueError("A shortcut cannot skip a required checkpoint.")
        if any(a <= hi and lo <= b for lo, hi in ranges):
            raise ValueError("Shortcut progress ranges cannot overlap.")
        ranges.append((a, b))
        for key in ("ramp", "landing"):
            if key == "landing" and key not in spec: continue
            points = spec.get(key, [])
            if not 3 <= len(points) <= 16:
                raise ValueError("A launch ramp or landing needs 3 to 16 control points.")
            for i, p in enumerate(points):
                if any(not isinstance(p.get(k), (int, float)) or not math.isfinite(p[k])
                       or abs(p[k]) > 16000 for k in ("x", "y", "z")):
                    raise ValueError("Ramp coordinates must be finite and within +/-16000 ft.")
                if not 40 <= p.get("width", 60) <= 120 or p.get("bank", 0) != 0 or p.get("gap"):
                    raise ValueError("Shortcut decks need solid, unbanked pavement 40 to 120 ft wide.")
                if i and sum((p[k] - points[i - 1][k]) ** 2 for k in ("x", "y", "z")) < 1:
                    raise ValueError("Consecutive ramp points must be at least one foot apart.")
        openings = spec.get("openings", [])
        if not 1 <= len(openings) <= 4:
            raise ValueError("Each shortcut needs entry/rejoin rail openings.")
        for opening in openings:
            lo, hi = opening.get("from"), opening.get("to")
            if (opening.get("side") not in ("L", "R")
                    or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (lo, hi))
                    or not 0 < lo < hi < count or hi - lo > 1.5):
                raise ValueError("Rail openings need side L/R and a short, ordered progress interval.")
            if sec[index_at(sec, lo)]["s"] < 150 or sec[index_at(sec, hi)]["s"] > sec[-1]["s"] - 150:
                raise ValueError("Keep shortcut openings away from the start/finish grid.")


def index_at(sec, progress):
    return min(range(len(sec)), key=lambda i: abs(sec[i]["progress"] - progress))


def checkpoint_indices(desc, sec):
    values = desc.get("checkpoints")
    return None if values is None else [index_at(sec, value) for value in values]


def prepare(desc, sec):
    from trackbuilder import resample, frames
    result = []
    for spec in desc.get("shortcuts", []):
        for opening in spec["openings"]:
            for q in sec:
                if opening["from"] <= q["progress"] <= opening["to"]:
                    q["rails_" + opening["side"]] = False
        ramp, total = resample({"points": spec["ramp"]}, closed=False)
        frames(ramp, closed=False)
        landing = []
        if "landing" in spec:
            landing, _ = resample({"points": spec["landing"]}, closed=False)
            frames(landing, closed=False)
        result.append(dict(spec=spec, sections=ramp, landing=landing, total=total,
                           entry=index_at(sec, spec["entry"]),
                           rejoin=index_at(sec, spec["rejoin"])))
    return result


def texture(encode):
    y, x = np.mgrid[0:64, 0:64] / 63
    image = np.full((64, 64, 4), [12, 62, 35, 255], float)
    arrow = abs(y - (.82 - abs(x - .5))) < .12
    image[arrow] = [172, 255, 76, 255]
    image[(x < .07) | (x > .93)] = [66, 242, 174, 255]
    return ("FLYMARK", 64, 64, 1, 0x08000000, 0x6008, encode(image, 1))


def add_meshes(branches, meshes, main, tex_ids):
    from trackbuilder import ribbon_mesh
    for branch in branches:
        ramp = branch["sections"]
        # Batch into an existing road object: Chemical's placement table has room
        # for only one more record. A shortcut must not consume that reservation.
        m = min(meshes, key=lambda m: np.linalg.norm(m.origin - ramp[0]["pos"]))
        for deck in (ramp, branch["landing"]):
            for start in range(0, len(deck) - 1, 45):
                run = list(range(start, min(start + 45, len(deck) - 1) + 1))
                ribbon_mesh(m, deck, run, tex_ids, deck[-1]["s"])
                m.texture(tex_ids["FLYMARK"])
                m.strip([v for k in run for v in
                         ((deck[k]["L"] + deck[k]["N"] * .08, (0, deck[k]["s"] / 45)),
                          (deck[k]["R"] + deck[k]["N"] * .08, (1, deck[k]["s"] / 45)))])
        # A painted arrow on the main road points toward the launch lane.
        q = main[branch["entry"]]
        side = 1 if np.dot(ramp[0]["pos"] - q["pos"], q["S"]) > 0 else -1
        forward = q["T"] + q["S"] * side * .65
        forward /= np.linalg.norm(forward)
        across = np.cross(forward, [0., 1., 0.]); across /= np.linalg.norm(across)
        p = q["pos"] + q["S"] * side * q["width"] * .24 + q["N"] * .12
        m.texture(tex_ids["FLYMARK"])
        m.strip([(p - forward * 24 - across * 11, (0, 0)),
                 (p - forward * 24 + across * 11, (1, 0)),
                 (p + forward * 24 - across * 11, (0, 1)),
                 (p + forward * 24 + across * 11, (1, 1))])
        # Green posts identify the rejoin without obstructing its driving surface.
        q = main[branch["rejoin"]]
        for sign in (-1, 1):
            p = q["pos"] + q["S"] * sign * (q["width"] / 2 + 9)
            m.strip([(p - q["S"] * 3, (0, 0)), (p + q["S"] * 3, (1, 0)),
                     (p - q["S"] * 3 + [0, 26, 0], (0, 1)),
                     (p + q["S"] * 3 + [0, 26, 0], (1, 1))])
