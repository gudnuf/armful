#!/usr/bin/env python3
"""Check every Drive thumbnail the page uses (nothing is saved to disk).

usage: python3 -I pipeline/gallery/verify_thumbs.py --collection collections/<slug> [--data FILE] [--workers 6]
For each file in the built data.json (default <collection>/dist/data.json): GET the wall thumbnail (sz=w400) and, for
people's representative faces, the face thumbnail (sz=w<rep.sz>). Each must be
HTTP 200 + JPEG/PNG, and its aspect ratio must match the stored photo
width/height within 2% (otherwise the CSS face crops would drift).
Writes <collection>/state/thumbs_report.json.
"""
import json
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collection  # noqa: E402

URL = "https://drive.google.com/thumbnail?id={}&sz=w{}"


def dims(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", b[16:24])
    i = 2
    while i < len(b) - 9:
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", b[i + 5 : i + 9])
            return w, h
        i += 2 + struct.unpack(">H", b[i + 2 : i + 4])[0]
    return None


def check(job):
    fid, sz, w, h = job
    for attempt in range(4):
        try:
            req = urllib.request.Request(URL.format(fid, sz), headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                body, ctype = r.read(), r.headers.get("Content-Type", "")
            d = dims(body)
            if not d:
                return job, "not-an-image " + ctype
            tw, th = d
            if not (w and h):  # file the scan could not decode: only check the thumbnail loads
                return job, None
            if abs((tw / th) / (w / h) - 1) > 0.02:
                return job, f"aspect {tw}x{th} vs {w}x{h}"
            return job, None
        except Exception as e:  # noqa: BLE001
            err = repr(e)
            time.sleep(2 * (attempt + 1))
    return job, err


def main():
    ap = collection.parser(__doc__)
    ap.add_argument("--data", help="the data.json to check (default: <collection>/dist/data.json)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    col, _cfg = collection.resolve(args)
    workers = args.workers
    d = json.load(open(collection.data_json(col, args.data)))
    jobs = [(f["i"], 400, f["w"], f["h"]) for f in d["files"]]
    reps = [(d["files"][p["rep"]["f"]]["i"], p["rep"]["sz"], d["files"][p["rep"]["f"]]["w"], d["files"][p["rep"]["f"]]["h"]) for p in d["people"]]
    t0 = time.time()
    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(check, jobs + reps))
    bad = [(j, e) for j, e in res if e]
    nw = len(jobs)
    rep = dict(
        wall_checked=nw,
        wall_ok=sum(1 for j, e in res[:nw] if not e),
        faces_checked=len(reps),
        faces_ok=sum(1 for j, e in res[nw:] if not e),
        videos=sum(1 for f in d["files"] if f.get("v")),
        seconds=round(time.time() - t0, 1),
        problems=[dict(id=j[0], sz=j[1], why=e) for j, e in bad],
    )
    with open(os.path.join(collection.state_dir(col), "thumbs_report.json"), "w") as f:
        json.dump(rep, f, indent=1)
    print(json.dumps({k: v for k, v in rep.items() if k != "problems"}), "problems:", len(bad))
    for b in bad[:15]:
        print(" ", b)


if __name__ == "__main__":
    main()
