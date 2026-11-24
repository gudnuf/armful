#!/usr/bin/env python3
"""Check that every face circle on the page actually shows a centred face.

usage (ARMFUL_SCAN_ROOT and ARMFUL_FOOTAGE set):
  python -I pipeline/gallery/verify_faces.py --collection collections/<slug> [--data FILE]
Reads the built data.json (default <collection>/dist/data.json).
Fetches each person's face exactly as the page does (Google-side crop of the
Drive image, lh3 ...=w160-h160-fcrop64=...), in memory only, runs the local
face detector on it, and checks a face sits near the centre. Nothing is saved.
Writes <collection>/state/faces_report.json.
"""
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scan"))
import collection  # noqa: E402
import facecore as fc  # noqa: E402

PX = 160


def fcrop_url(f, box):
    x, y, s = box
    h4 = lambda v: "%04x" % min(0xFFFF, max(0, round(v * 0xFFFF)))  # noqa: E731
    return (
        f"https://lh3.googleusercontent.com/d/{f['i']}=w{PX}-h{PX}-fcrop64=1,"
        f"{h4(x / f['w'])}{h4(y / f['h'])}{h4((x + s) / f['w'])}{h4((y + s) / f['h'])}"
    )


def fetch(u):
    for _ in range(3):
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            return urllib.request.urlopen(req, timeout=30).read()
        except Exception:  # noqa: BLE001
            pass
    return b""


def main():
    ap = collection.parser(__doc__)
    ap.add_argument("--data", help="the data.json to check (default: <collection>/dist/data.json)")
    args = ap.parse_args()
    col, _cfg = collection.resolve(args)
    d = json.load(open(collection.data_json(col, args.data)))
    # people whose face uses the Google-side crop (rep without c); the others use the CSS crop
    # of the Drive thumbnail, whose aspect is checked by verify_thumbs.py
    d["people"] = [p for p in d["people"] if not p["rep"].get("c")]
    urls = [fcrop_url(d["files"][p["rep"]["f"]], p["rep"]["box"]) for p in d["people"]]
    with ThreadPoolExecutor(6) as ex:
        blobs = list(ex.map(fetch, urls))
    app = fc.app()

    app.det_model.input_size = (320, 320)
    res = []
    for p, b in zip(d["people"], blobs):
        img = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR) if b else None
        if img is None:
            res.append(dict(id=p["id"], main="x" not in p, ok=False, why="no image"))
            continue
        big = cv2.copyMakeBorder(img, 80, 80, 80, 80, cv2.BORDER_CONSTANT)  # context helps tight crops
        faces = app.det_model.detect(big, max_num=0, metric="default")[0]
        h, w = img.shape[:2]
        if (w, h) != (PX, PX):
            res.append(dict(id=p["id"], main="x" not in p, ok=False, why=f"not square {w}x{h}"))
            continue
        best = None
        for x1, y1, x2, y2, sc in faces:
            if sc < 0.4:
                continue
            cx, cy = (x1 + x2) / 2 - 80, (y1 + y2) / 2 - 80
            off = max(abs(cx - w / 2) / w, abs(cy - h / 2) / h)
            if best is None or off < best:
                best = off
        ok = best is not None and best <= 0.2
        res.append(dict(id=p["id"], main="x" not in p, ok=bool(ok), off=None if best is None else round(float(best), 3),
                        size=[w, h], bytes=len(b)))
    main = [r for r in res if r["main"]]
    rep = dict(
        checked=len(res),
        centred=sum(r["ok"] for r in res),
        main_checked=len(main),
        main_centred=sum(r["ok"] for r in main),
        main_kb=round(sum(r.get("bytes", 0) for r in main) / 1024),
        not_centred=[r for r in res if not r["ok"]],
    )
    with open(os.path.join(collection.state_dir(col), "faces_report.json"), "w") as f:
        json.dump(rep, f, indent=1)
    print(json.dumps({k: v for k, v in rep.items() if k != "not_centred"}))
    print("not centred / no face:", [(r["id"], r.get("off"), r["main"]) for r in rep["not_centred"]][:40])


if __name__ == "__main__":
    main()
