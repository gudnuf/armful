#!/usr/bin/env python3
"""Build data.json for one armful collection.

usage (ARMFUL_SCAN_ROOT and ARMFUL_FOOTAGE set):
  python -I pipeline/gallery/build_site.py --collection collections/<slug> [--out DIR] [--merge 0.50]

Reads the face scan in $ARMFUL_SCAN_ROOT/data/ (faces.tsv, clusters.tsv,
photos.tsv, emb.npy, centroids.npy) and the collection folder (collection.json,
hidden.json, state/). Writes DIR/data.json (default <collection>/dist/), which
holds ONLY: the collection's slug, title and time zone, Drive file ids, photo
width/height, capture time, face count, one face box per person (the
representative) and person ids per photo. No
embeddings, no file names, no names, no bursts. Photos and crops are never
copied: the page loads Drive's own thumbnails and crops faces with CSS.

Steps:
1. Merge face clusters that are clearly the same person: centroid cosine
   similarity >= --merge AND the two never appear in the same photo/frame.
2. Keep person ids stable across rebuilds (state/person_faces.json maps each
   person id to its face ids; a rebuilt person inherits the id it shares the
   most faces with). hidden.json keys on these ids.
3. Drop every person listed in hidden.json or collection.json "hidden" (their faces and their id vanish
   from the page; the photos themselves stay browsable, as they are in Drive).
4. Give each file its capture time `t` (capture_time.py; omitted when unknown) and its face
   count `nf` (every face the scan detected, people or not), and order files by `t`, files
   without one last. Ordering files never renumbers people.
5. Give each file its display width/height: the scan's, or, where the scan recorded none
   (w or h <= 0), the file's own (media_size.py: Pillow with EXIF orientation, ffprobe with
   the stream's rotation). A file whose size still cannot be told is left out of data.json
   and listed in build_report.json ("dropped"): the page never gets a w or h <= 0.
"""
import json
import os
import sys
from collections import Counter, defaultdict

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture_time  # noqa: E402
import collection  # noqa: E402
import media_size  # noqa: E402


def _need(name, what):
    """An env var the pipeline cannot run without (no default: paths are local to each machine)."""
    v = os.environ.get(name)
    if not v:
        sys.exit(f"{name} is not set: {what}")
    return os.path.expanduser(v)

DATA = os.path.join(_need("ARMFUL_SCAN_ROOT", "the folder holding the scan output (data/, crops/)"), "data")
DRIVE = os.path.join(_need("ARMFUL_FOOTAGE", "the local copy of the collection's photos and videos (drive/ inside it)"), "drive")


_crop_ok = {}


def server_crop_ok(rel):
    if rel not in _crop_ok:
        _crop_ok[rel] = _server_crop_ok(rel)
    return _crop_ok[rel]


def _server_crop_ok(rel):
    """Google's fcrop64 crops the raw, un-rotated pixels: only safe for plain JPEGs
    without EXIF rotation. Everything else uses the CSS crop of Drive's (rotated) thumbnail."""
    if os.path.splitext(rel)[1].lower() not in (".jpg", ".jpeg"):
        return False
    try:
        with Image.open(os.path.join(DRIVE, rel)) as im:
            return im.getexif().get(274, 1) == 1
    except Exception:  # noqa: BLE001
        return False

MERGE = 0.50  # good-face centroid cosine similarity to merge two clusters (spot-checked 2026-11-19)
MAIN_MIN_PHOTOS, MAIN_MIN_GOOD = 3, 2  # else the face sits behind "more"
Q_DET, Q_SIDE, Q_SHARP, Q_MIN = 0.75, 60, 50, 2  # "good face" for merge decisions
REP_PX = 112  # target face-crop width in the thumbnail, px (faces show at <= 96 css px)
SIZES = (200, 400, 800, 1200)  # capped: a 1600 px thumbnail costs ~0.5 MB per face
MAIN_REP_SHARP = 80  # the main constellation needs a clear representative face (else "more")
REP_ROLL = 30  # degrees: the page shows the face as it sits in the photo, so the face tile must be upright


def tsv(path):
    with open(path, encoding="utf-8") as f:
        hdr = next(f).rstrip("\n").split("\t")
        return [dict(zip(hdr, line.rstrip("\n").split("\t"))) for line in f]


def upright(r):
    """Roll known (pipeline/scan/upright.py) and near upright."""
    return r.get("roll", "") != "" and abs(float(r["roll"])) <= REP_ROLL


def quality_centroids(faces, cl, E, n):
    """Per-cluster centroid from good faces only (confident, big, sharp, core).
    Clusters with fewer than Q_MIN such faces get a zero vector: never merged."""
    C = np.zeros((n, E.shape[1]), np.float32)
    idx = defaultdict(list)
    for i, r in enumerate(faces):
        c, _s, weak = cl[r["face_id"]]
        side = min(float(r["x2"]) - float(r["x1"]), float(r["y2"]) - float(r["y1"]))
        if c >= 0 and not weak and float(r["det"]) >= Q_DET and side >= Q_SIDE and float(r["sharp"]) >= Q_SHARP:
            idx[c].append(i)
    for c, ii in idx.items():
        if len(ii) >= Q_MIN:
            v = E[ii].mean(0)
            C[c] = v / np.linalg.norm(v)
    return C, {c: len(ii) for c, ii in idx.items()}


def merge_clusters(C, occ, thresh):
    """Union-find over cluster pairs by descending similarity, conflict-free."""
    n = len(C)
    parent = list(range(n))
    members = {i: {i} for i in range(n)}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    S = C @ C.T
    iu = np.triu_indices(n, 1)
    pairs = [(float(S[a, b]), int(a), int(b)) for a, b in zip(*iu) if S[a, b] >= thresh]
    pairs.sort(reverse=True)
    merges = []
    for s, a, b in pairs:
        ra, rb = find(a), find(b)
        if ra == rb:
            continue
        if any(occ[x] & occ[y] for x in members[ra] for y in members[rb]):
            continue  # seen together in one photo/frame: two different people
        parent[rb] = ra
        members[ra] |= members.pop(rb)
        merges.append((a, b, round(s, 3)))
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return list(groups.values()), merges


def hidden_ids(raw, where):
    """A hidden list must be a JSON list of whole person ids; anything else stops the build."""
    if not isinstance(raw, list) or not all(isinstance(x, int) and not isinstance(x, bool) for x in raw):
        sys.exit(f"{where}: the hidden list must be a JSON list of person ids (integers); nothing written")
    return set(raw)


def main(argv=None):
    ap = collection.parser(__doc__)
    ap.add_argument("--out", help="folder to write data.json into (default: <collection>/dist)")
    ap.add_argument("--merge", type=float, default=MERGE, help=f"centroid similarity to merge clusters (default {MERGE})")
    ap.add_argument(
        "--fresh-ids",
        action="store_true",
        help="allow numbering people from scratch although hidden ids are set (they then name other people: redo them)",
    )
    ap.add_argument(
        "--ffprobe",
        default="ffprobe",
        help="ffprobe to read video capture times and missing video sizes with (default: ffprobe on PATH; without it videos get no time)",
    )
    args = ap.parse_args(argv)
    thresh = args.merge

    # Order (so a failed build never leaves the id map and the page data at different revisions):
    # 1. validate every input and every destination; nothing is written yet
    # 2. compute everything in memory
    # 3. write data.json atomically
    # 4. write the id map (state/person_faces.json) atomically, then the review files
    # A crash between 3 and 4 leaves the old id map with the new page data; rerunning the build
    # derives the same ids again from that old map and the same scan, so it heals itself.
    col, cfg = collection.resolve(args)
    out_dir = os.path.abspath(os.path.expanduser(args.out)) if args.out else os.path.join(col, "dist")
    st = collection.state_dir(col, make=False)
    state_f = os.path.join(st, "person_faces.json")
    hidden_f = os.path.join(col, "hidden.json")
    data_f = os.path.join(out_dir, "data.json")
    written = [data_f] + [os.path.join(st, n) for n in ("person_faces.json", "reps.json", "build_report.json")]
    for w in written:
        collection.check_private_dest(w)
        collection.check_private_dest(w + ".tmp")
    hidden = hidden_ids(cfg.get("hidden", []), "collection.json \"hidden\"")
    tz_name = cfg.get("tz")
    try:
        tz = capture_time.zone(tz_name) if tz_name is not None else __import__("datetime").timezone.utc
    except ValueError as e:
        sys.exit(f"collection.json \"tz\": {e} (use an IANA name such as \"UTC\"); nothing written")
    if os.path.exists(hidden_f):
        try:
            with open(hidden_f, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError) as e:
            sys.exit(f"{hidden_f}: hidden list is not valid JSON ({e}); nothing written")
        hidden |= hidden_ids(raw, hidden_f)
    prev = {}
    if os.path.exists(state_f):
        try:
            with open(state_f, encoding="utf-8") as f:
                prev = json.load(f)
            _ids = {fid: int(pid) for pid, fids in prev.items() for fid in fids}  # shape check only
        except (OSError, ValueError, AttributeError, TypeError) as e:
            sys.exit(f"{state_f}: id map is unreadable ({e}); nothing written")
    if hidden and not os.path.exists(state_f) and not args.fresh_ids:
        # fail closed: without the saved ids people are renumbered from 1, and the hidden ids
        # would then hide other people and publish the ones who asked to be hidden
        sys.exit(
            f"{state_f} is missing but the collection hides {len(hidden)} person id(s): those ids only mean "
            "something with the saved person ids. Restore state/person_faces.json, or pass --fresh-ids "
            "and redo the hidden list against the new ids."
        )
    for d in (out_dir, st):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError as e:
            sys.exit(f"cannot create {d} ({e}); nothing written")
        if not os.access(d, os.W_OK):
            sys.exit(f"{d} is not writable; nothing written")
    faces = tsv(os.path.join(DATA, "faces.tsv"))
    photos = tsv(os.path.join(DATA, "photos.tsv"))
    cl = {}
    with open(os.path.join(DATA, "clusters.tsv")) as f:
        next(f)
        for line in f:
            fid, c, s, w = line.split()
            cl[fid] = (int(c), float(s), int(w))
    C, good = quality_centroids(faces, cl, np.load(os.path.join(DATA, "emb.npy")), len(np.load(os.path.join(DATA, "centroids.npy"))))

    # where each cluster appears: photo file keys, or (video key, frame time)
    occ = defaultdict(set)
    for r in faces:
        c = cl[r["face_id"]][0]
        if c >= 0:
            occ[c].add((r["file_key"], r["t"]))
    groups, merges = merge_clusters(C, occ, thresh)
    cl2grp = {c: g for g, cs in enumerate(groups) for c in cs}

    # faces per group; photo/video membership per group
    gfaces = defaultdict(list)
    for r in faces:
        c = cl[r["face_id"]][0]
        if c >= 0:
            gfaces[cl2grp[c]].append(r)

    # stable person ids
    prev_of = {fid: int(pid) for pid, fids in prev.items() for fid in fids}
    gid = {}
    taken = set()
    order = sorted(gfaces, key=lambda g: -len({r["file_key"] for r in gfaces[g]}))
    for g in order:
        votes = Counter(prev_of[r["face_id"]] for r in gfaces[g] if r["face_id"] in prev_of)
        for pid, _n in votes.most_common():
            if pid not in taken:
                gid[g] = pid
                taken.add(pid)
                break
    nxt = max(list(taken) + [int(p) for p in prev] + [0]) + 1
    for g in order:  # new people numbered after all ids ever used
        if g not in gid:
            gid[g] = nxt
            taken.add(nxt)
            nxt += 1
    state = dict(prev)
    for g in order:
        state[str(gid[g])] = sorted(r["face_id"] for r in gfaces[g])

    # photo table (photos first by Drive listing order of photos.tsv, then videos)
    pinfo = {p["file_key"]: p for p in photos if p["drive_id"]}
    photo_keys = [p["file_key"] for p in photos if p["drive_id"] and p["kind"] == "photo"]
    video_keys = [p["file_key"] for p in photos if p["drive_id"] and p["kind"] == "video"]
    ffprobe = capture_time.ffprobe_path(args.ffprobe)
    if video_keys and not ffprobe:
        print(f"no ffprobe ({args.ffprobe}): videos get no capture time", file=sys.stderr)
    # display sizes: the scan's, else the file's own; a file without one is left out (before any
    # index is taken, so person reps and per-file people only ever point at published files)
    size, probed, dropped = {}, [], []
    for k in photo_keys + video_keys:
        p = pinfo[k]
        w, h = media_size.dim(p["w"]), media_size.dim(p["h"])
        if w <= 0 or h <= 0:
            got = media_size.probe(os.path.join(DRIVE, p["rel"]), p["kind"], ffprobe)
            entry = dict(drive_id=p["drive_id"], rel=p["rel"], kind=p["kind"], scan_w=p["w"], scan_h=p["h"])
            if got is None:
                dropped.append(entry)
                continue
            w, h = got
            probed.append(dict(entry, w=w, h=h))
        size[k] = (w, h)
    for e in dropped:
        print(f"no size for {e['kind']} {e['rel']} (scan: {e['scan_w']} x {e['scan_h']}): left out of data.json", file=sys.stderr)
    photo_keys = [k for k in photo_keys if k in size]
    video_keys = [k for k in video_keys if k in size]
    keys = photo_keys + video_keys
    # capture times; files ordered by time, those without one last in the order above
    when = {}
    for k in keys:
        path = os.path.join(DRIVE, pinfo[k]["rel"])
        t = capture_time.exif_time(path, tz) if pinfo[k]["kind"] == "photo" else capture_time.video_time(path, ffprobe)
        if t is not None:
            when[k] = t
    keys = sorted(keys, key=lambda k: (k not in when, when.get(k, 0)))  # stable: ties keep their order
    # faces per file: every detected face (also unclustered and hidden people's faces, which
    # leave no id behind). A video counts the most faces seen in one sampled frame, or the
    # people seen across its frames if that is more (two people in turn are a group of two).
    per_frame = Counter((r["file_key"], r["t"]) for r in faces)
    nfaces = defaultdict(int)
    for (k, _t), n in per_frame.items():
        nfaces[k] = max(nfaces[k], n)
    seen = defaultdict(set)  # file -> person groups, hidden ones included
    for g, rs in gfaces.items():
        for r in rs:
            seen[r["file_key"]].add(g)
    for k, gs in seen.items():
        nfaces[k] = max(nfaces[k], len(gs))
    kidx = {k: i for i, k in enumerate(keys)}
    ppl_in = defaultdict(set)  # file index -> person ids
    people = []
    reps = {}  # local only (state/): person id -> representative face id + crop file, for review
    for g in order:
        pid = gid[g]
        if pid in hidden:
            continue
        fs = [r for r in gfaces[g] if r["file_key"] in kidx]
        pf = {r["file_key"] for r in fs if r["kind"] == "photo"}
        vf = {r["file_key"] for r in fs if r["kind"] == "video"}
        if not pf:
            continue  # no photo face to show: video-only people are left out
        for k in pf | vf:
            ppl_in[kidx[k]].add(pid)
        # representative: a core face that fills a good share of its photo (so a
        # small Drive thumbnail is enough), sharp, confident, close to centroid
        best, score = None, -1.0
        for r in fs:
            if r["kind"] != "photo" or cl[r["face_id"]][2]:
                continue
            x1, y1, x2, y2 = (float(r[k]) for k in ("x1", "y1", "x2", "y2"))
            side = min(x2 - x1, y2 - y1)
            W = size[r["file_key"]][0]
            frac = min(side * 1.6 / W, 0.5)  # crop width as a share of the thumbnail
            need_r = REP_PX * W / (side * 1.6)  # small thumbnails load fast: prefer them
            fast = 1.0 if need_r <= 400 else 0.85 if need_r <= 800 else 0.5
            if not server_crop_ok(pinfo[r["file_key"]]["rel"]):
                fast *= 0.7  # rotated photo: face must come via the bigger Drive thumbnail
            if not (float(r["det"]) >= Q_DET and side >= Q_SIDE and float(r["sharp"]) >= MAIN_REP_SHARP):
                fast *= 0.2  # strongly prefer a clear face
            if not upright(r):
                fast *= 0.02  # a sideways or upside-down face tile reads as a stranger
            sc = (
                fast
                * frac
                * min(side, 200)
                * float(r["det"]) ** 2
                * min(float(r["sharp"]), 300)
                * max(cl[r["face_id"]][1], 0.01) ** 2
            )
            if sc > score:
                best, score = r, sc
        if best is None:
            best = next(r for r in fs if r["kind"] == "photo")
        p = pinfo[best["file_key"]]
        W, H = size[best["file_key"]]
        x1, y1, x2, y2 = (float(best[k]) for k in ("x1", "y1", "x2", "y2"))
        # square crop around the face, 1.6x the box, kept inside the image
        s = min(max(x2 - x1, y2 - y1) * 1.6, W, H)
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        left = min(max(cx - s / 2, 0), W - s)
        top = min(max(cy - s / 2, 0), H - s)
        rep_clear = (
            float(best["det"]) >= Q_DET
            and min(x2 - x1, y2 - y1) >= Q_SIDE
            and float(best["sharp"]) >= MAIN_REP_SHARP
            and upright(best)
        )
        reps[pid] = dict(face=best["face_id"], crop=best["crop"])
        need = REP_PX * W / s  # thumbnail width that makes the crop ~REP_PX wide
        sz = next((z for z in SIZES if z >= need), SIZES[-1])
        people.append(
            dict(
                id=pid,
                n=len(pf),
                nv=len(vf),
                **(
                    {"x": 1}
                    if len(pf) < MAIN_MIN_PHOTOS
                    or sum(good.get(c, 0) for c in groups[g]) < MAIN_MIN_GOOD
                    or not rep_clear
                    else {}
                ),
                rep=dict(
                    f=kidx[best["file_key"]],
                    box=[round(left), round(top), round(s)],
                    sz=sz,
                    **({} if server_crop_ok(p["rel"]) else {"c": 1}),
                ),
            )
        )
    people.sort(key=lambda q: (-q["n"], -q["nv"], q["id"]))

    files = []
    for k in keys:
        p = pinfo[k]
        w, h = size[k]
        assert w > 0 and h > 0, k  # never publish a size the page cannot lay out
        rec = dict(i=p["drive_id"], w=w, h=h, p=sorted(ppl_in[kidx[k]]))
        if p["kind"] == "video":
            rec["v"] = 1
        if k in when:
            rec["t"] = when[k]
        rec["nf"] = nfaces[k]
        files.append(rec)
    out = dict(
        slug=cfg["slug"],
        title=cfg["title"],
        built=__import__("datetime").date.today().isoformat(),
        **({"tz": tz_name} if tz_name is not None else {}),
        files=files,
        people=people,
    )
    # 3. page data, then 4. the id map (see the order at the top of main)
    collection.write_atomic(data_f, json.dumps(out, separators=(",", ":")))
    collection.write_atomic(state_f, json.dumps(state))
    collection.write_atomic(os.path.join(st, "reps.json"), json.dumps(reps))
    collection.write_atomic(
        os.path.join(st, "build_report.json"),
        json.dumps(
            dict(
                merge_thresh=thresh,
                clusters=len(C),
                clusters_mergeable=int((np.abs(C).sum(1) > 0).sum()),
                groups=len(groups),
                merges=merges,
                people_on_page=len(people),
                people_3plus=sum(q["n"] >= 3 for q in people),
                people_main=sum("x" not in q for q in people),
                hidden=sorted(hidden),
                photos=len(photo_keys),
                videos=len(video_keys),
                timed_photos=sum(k in when for k in photo_keys),
                timed_videos=sum(k in when for k in video_keys),
                sizes_probed=probed,  # the scan had no size; read from the file
                dropped=dropped,  # no size anywhere: not on the page
            ),
            indent=1,
        ),
    )
    print(
        f"clusters {len(C)} -> people {len(groups)} ({len(merges)} merges at {thresh}); "
        f"on page {len(people)}, 3+ photos {sum(q['n'] >= 3 for q in people)}, main sky {sum('x' not in q for q in people)}; "
        f"files {len(photo_keys)} photos + {len(video_keys)} videos ({len(when)} with a time"
        f"{f', {len(probed)} sized from the file' if probed else ''}{f', {len(dropped)} left out: no size' if dropped else ''}); "
        f"hidden {len(hidden)}; "
        f"wrote {data_f}"
    )


if __name__ == "__main__":
    main()
