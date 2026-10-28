"""Steering targets for the runtime bot; never changes native game physics or state."""
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "trackbuilder"))
from trackbuilder import resample, frames, np
from shortcuts import prepare


def make_route(description, use_shortcuts=False):
    main, total = resample(description)
    frames(main)
    for k, q in enumerate(main):
        q["mainIndex"] = k
    route = main
    taken = []; landings = []
    if use_shortcuts:
        branches = prepare(description, main)
        route = []; previous = 0
        for b in sorted(branches, key=lambda b: b["entry"]):
            a, end = b["entry"], b["rejoin"]
            ramp = b["sections"]
            start = a - 16
            route += main[previous:start]
            lateral = (ramp[0]["pos"] - main[a]["pos"]) @ main[a]["S"]
            sign = (1 if lateral > 0 else -1) if abs(lateral) > main[a]["width"] * .05 else 0
            anchors = [main[start]["pos"],
                       main[a - 10]["pos"] + main[a - 10]["S"] * sign * main[a - 10]["width"] * .35,
                       ramp[0]["pos"]]
            for p, q in zip(anchors, anchors[1:]):
                for t in np.linspace(0, 1, max(1, round(np.linalg.norm(q - p) / 10)), endpoint=False):
                    route.append(dict(pos=p * (1 - t) + q * t, gap=False, width=60,
                                      shortcut=b["spec"]["id"], phase="approach", mainIndex=a))
            for q in ramp:
                route.append(dict(q, shortcut=b["spec"]["id"], phase="ramp", mainIndex=a))
            p = ramp[-1]["pos"]
            q = b["landing"][0]["pos"] if b["landing"] else main[end]["pos"]
            count = max(2, round(np.linalg.norm(q - p) / 10))
            for t in np.linspace(0, 1, count, endpoint=False):
                # Approximate the height of a glide for route selection at bridges.
                # Only X/Z targets steer the car. The emulator supplies all motion.
                pos = p * (1 - t) + q * t + [0, 28 * 4 * t * (1 - t), 0]
                route.append(dict(pos=pos, gap=True, width=60,
                                  shortcut=b["spec"]["id"], phase="flight", mainIndex=a + round((end - a) * t)))
            for q in b["landing"]:
                route.append(dict(q, shortcut=b["spec"]["id"], phase="landing", mainIndex=end))
            previous = end
            taken.append(b["spec"]["id"])
            deck = b["landing"] or [main[end]]
            landings.append(dict(id=b["spec"]["id"], deck=[
                dict(pos=q["pos"].tolist(), width=q["width"]) for q in deck]))
        route += main[previous:]
    out = []; jump = 0
    for k, q in enumerate(route):
        if q["gap"] and not route[k - 1]["gap"]: jump += 1
        a = (q["pos"] - route[(k - 3) % len(route)]["pos"])[[0, 2]]
        b = (route[(k + 3) % len(route)]["pos"] - q["pos"])[[0, 2]]
        curvature = abs(math.atan2(a[0] * b[1] - a[1] * b[0], a @ b)) / max(1, (np.linalg.norm(a) + np.linalg.norm(b)) / 2)
        limit = min(300, max(70, math.sqrt(65 / max(curvature, 1e-6))))
        out.append(dict(pos=q["pos"].tolist(), gap=q["gap"], jump=jump if q["gap"] else 0,
                        width=q["width"], mainIndex=q["mainIndex"], shortcut=q.get("shortcut"), phase=q.get("phase", "main"),
                        limit=limit))
    length = sum(np.linalg.norm(q["pos"] - route[k - 1]["pos"]) for k, q in enumerate(route))
    return dict(sections=out, shortcuts=taken, landings=landings, mainLength=total, routeLength=float(length))


if __name__ == "__main__":
    print(json.dumps(make_route(json.loads(Path(sys.argv[1]).read_text()), len(sys.argv) > 2 and sys.argv[2] == "all")))
