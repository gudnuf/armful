#!/usr/bin/env python3
"""Write a synthetic collection for tests: no real photos, faces or ids.

usage: python3 -I bin/make-fixture.py OUT_DIR

Writes OUT_DIR/data.json and placeholder SVGs OUT_DIR/fx/p{N}.svg (one per
file) and OUT_DIR/fx/f{N}.svg (one per person). data.json.thumbs points the
page at those local files instead of Drive.

Shape (the page tests rely on it):
  60 files, sizes 4:3, 3:4, 16:9, 1:1 (file 26 is 9:16); 3 of them videos (v: 1), files
  0, 22, 26 (26 a portrait video);
  12 people, ids 1-12, n descending (n = files containing them);
  no x (the pipeline leaves uncertain people out); people 1 and 2 share exactly 9 files;
  person 12 shares none with person 1; no bursts;
  tz "UTC"; t (unix seconds) on 58 files, strictly ascending in file order,
  over 4 trip days (a day runs 04:00 to 04:00) in a morning and an evening
  cluster each; file 14, the first day's last, is at 01:30 the next calendar
  day (still the first trip day's evening); file 36 is in the third day's
  afternoon (13:30); files 58 and 59 have no t (so the file order is also the
  build's default order: by t, untimed last);
  nf (faces detected) >= people on the file: 0 on the 6 files with nobody
  (EMPTY), 8+ on the group shots (GROUP), otherwise 1-6.
Then one malformed entry, appended LAST so no index above shifts: file "60",
a video with w: 0, h: 0 and nobody on it, no t and no SVG. The page must drop
it (and warn) and show the 60 good files; data.json holds 61 entries.
"""
import json
import os
import random
import sys

N_FILES = 60
SIZES = [(1600, 1200), (1200, 1600), (1920, 1080), (1200, 1200)]  # 4:3, 3:4, 16:9, 1:1
# files per person, ids 1..12, strictly descending
COUNTS = [30, 26, 22, 19, 16, 13, 11, 9, 7, 5, 3, 2]
SHARED_1_2 = 9
VIDEOS = (0, 22, 26)  # the page tests rely on file 0 being a video
EMPTY = {6, 15, 24, 33, 42, 51}  # no people, no faces
GROUP = {10, 27, 45, 57}  # group shots: 8+ faces, most of them nobody the page names
N_TIMED = 58  # files 58 and 59 carry no capture time
PAST_MIDNIGHT = 14  # the first evening's last file: 01:30 the next calendar day, still trip day 1
AFTERNOON = 36  # the third morning's last file: 13:30
PORTRAIT_VIDEO = 26  # 9:16
DAY0 = 1777852800  # 2026-05-04 00:00 UTC
SESSIONS = [(d, start) for d in range(4) for start in (7 * 3600 + 1800, 18 * 3600)]  # 07:30 and 18:00
COLOURS = ["#8A9A8E", "#A89B8C", "#7F8C99", "#9C8FA0", "#8F9F9A", "#B0A38F", "#8C8A7E", "#9AA3A8"]


def photo_svg(idx, w, h):
    c = COLOURS[idx % len(COLOURS)]
    fs = min(w, h) // 5
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<rect width="{w}" height="{h}" fill="{c}"/>'
        f'<text x="{w // 2}" y="{h // 2}" font-family="sans-serif" font-size="{fs}" fill="#FBFAF7" '
        f'text-anchor="middle" dominant-baseline="central">{idx}</text></svg>\n'
    )


def face_svg(pid):
    c = COLOURS[pid % len(COLOURS)]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">'
        '<rect width="400" height="400" fill="#F2EFE8"/>'
        f'<circle cx="200" cy="200" r="180" fill="{c}"/>'
        '<text x="200" y="200" font-family="sans-serif" font-size="160" fill="#FBFAF7" '
        f'text-anchor="middle" dominant-baseline="central">{pid}</text></svg>\n'
    )


def main(out_dir):
    random.seed(1)
    idxs = list(range(N_FILES))
    pool = [i for i in idxs if i not in EMPTY]
    members = {}
    members[1] = set(random.sample(pool, COUNTS[0]))
    not1 = [i for i in pool if i not in members[1]]
    members[2] = set(random.sample(sorted(members[1]), SHARED_1_2)) | set(
        random.sample(not1, COUNTS[1] - SHARED_1_2)
    )
    for pid in range(3, 12):
        members[pid] = set(random.sample(pool, COUNTS[pid - 1]))
    members[12] = set(random.sample(not1, COUNTS[11]))
    videos = set(VIDEOS)

    files = []
    for i in idxs:
        w, h = (1080, 1920) if i == PORTRAIT_VIDEO else SIZES[i % len(SIZES)]
        rec = dict(i=str(i), w=w, h=h, p=sorted(pid for pid, m in members.items() if i in m))
        if i in videos:
            rec["v"] = 1
        if i < N_TIMED:
            s = i * len(SESSIONS) // N_TIMED  # session index
            j = i - next(k for k in range(N_TIMED) if k * len(SESSIONS) // N_TIMED == s)  # place in session
            day, start = SESSIONS[s]
            rec["t"] = DAY0 + day * 86400 + start + j * 360 + (i % 3) * 40
            if i == PAST_MIDNIGHT:
                rec["t"] = DAY0 + (day + 1) * 86400 + 5400  # 01:30
            elif i == AFTERNOON:
                rec["t"] = DAY0 + day * 86400 + 13 * 3600 + 1800  # 13:30
        n = len(rec["p"])
        rec["nf"] = 0 if i in EMPTY else 8 + i % 5 if i in GROUP else n + (1 if i % 7 == 3 or n == 0 else 0)
        files.append(rec)

    people = []
    for pid in range(1, 13):
        mine = sorted(members[pid])
        f = random.choice(mine)
        w, h = files[f]["w"], files[f]["h"]
        p = dict(id=pid, n=len(mine), nv=sum(1 for i in mine if i in videos))
        p["rep"] = dict(f=f, box=[0, 0, min(w, h)], sz=400, c=1)
        people.append(p)
    people.sort(key=lambda q: (-q["n"], q["id"]))
    good = len(files)
    files.append(dict(i=str(N_FILES), w=0, h=0, p=[], v=1, nf=0))  # the malformed entry (see above)

    data = dict(
        built="2026-01-01",
        tz="UTC",
        files=files,
        people=people,
        thumbs={"wall": "fx/p{i}.svg", "face": "fx/f{pid}.svg", "big": "fx/p{i}.svg"},
    )
    fx = os.path.join(out_dir, "fx")
    os.makedirs(fx, exist_ok=True)
    for i, rec in enumerate(files[:good]):
        with open(os.path.join(fx, f"p{i}.svg"), "w") as fh:
            fh.write(photo_svg(i, rec["w"], rec["h"]))
    for pid in range(1, 13):
        with open(os.path.join(fx, f"f{pid}.svg"), "w") as fh:
            fh.write(face_svg(pid))
    with open(os.path.join(out_dir, "data.json"), "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
        fh.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
