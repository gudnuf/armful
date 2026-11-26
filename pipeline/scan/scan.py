#!/usr/bin/env python3
"""Detect + embed every face in the downloaded collection (local, CPU).

usage: python -I pipeline/scan/scan.py [--videos]
Resumable: per-file results cached in data/per_file/. Writes
data/faces.tsv (one row per face), data/emb.npy (512-d, L2-normed, same order),
data/photos.tsv (one row per file) and data/scan_stats.json.
Each face also gets a roll estimate; faces rolled past fc.ROLL_MAX are re-embedded upright or
marked fix=drop (see upright.py, which does the same for an existing cache).

Previews ($ARMFUL_FOOTAGE/preview/preview.tsv, written by preview.py): a file listed there whose
original is not in drive/ is scanned from its Drive thumbnail instead (a video from its poster
frame, t=0), its face boxes scaled to the file's own size from the preview row. Its cache key is
taken from "preview:" + its path, so once the original is downloaded under the same name it is
scanned afresh and the preview is ignored.
"""
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import facecore as fc  # noqa: E402

MIN_CROP = 24  # px, original-resolution face side below which we don't save a crop


def key(rel):
    return hashlib.sha1(rel.encode()).hexdigest()[:16]


def manifest_ids():
    ids = {}
    p = os.path.join(fc.FOOTAGE, "manifest.tsv")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            next(f)
            for line in f:
                fid, name, _size, _sha, sub = line.rstrip("\n").split("\t")
                ids[os.path.join(sub, name) if sub else name] = fid
    return ids


def scan_image(path, k):
    bgr, scale, (w, h) = fc.load_image(path)
    res = []
    for i, f in enumerate(fc.faces(bgr)):
        box = f["box"]
        side = min(box[2] - box[0], box[3] - box[1]) / scale
        crop = ""
        if side >= MIN_CROP:
            crop = f"{k}_{i}.jpg"
            fc.save_crop(bgr, box, os.path.join(fc.CROPS, crop))
        roll, fix, emb = fc.orient(bgr, box, f["emb"]) if crop else (None, "", f["emb"])
        res.append(
            dict(
                t=-1.0,
                box=[v / scale for v in box],
                det=f["det"],
                sharp=fc.sharpness(bgr, box),
                emb=emb,
                crop=crop,
                roll=roll,
                fix=fix,
            )
        )
    return res, w, h, fc.image_sharpness(bgr)


def preview_rows():
    """rel -> preview.tsv row, for files ingested from previews only (preview.py)."""
    p = os.path.join(fc.FOOTAGE, "preview", "preview.tsv")
    out = {}
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            hdr = next(f).rstrip("\n").split("\t")
            for line in f:
                r = dict(zip(hdr, line.rstrip("\n").split("\t")))
                out[os.path.join(r["subfolder"], r["name"]) if r["subfolder"] else r["name"]] = r
    return out


def scan_preview(row, k):
    """Faces on a file's Drive thumbnail, boxes in the file's own w x h (from the preview row)."""
    W, H = int(row["w"]), int(row["h"])
    if not row["thumb"]:
        return [], W, H, 0.0  # no thumbnail fetched: listed with no faces
    bgr, _scale, (tw, th) = fc.load_image(os.path.join(fc.FOOTAGE, "preview", row["thumb"]))
    s = (W / tw) if W and tw else 1.0  # thumbnail px -> file px (same aspect ratio)
    if not (W and H):
        W, H = tw, th
    img_scale = bgr.shape[1] / tw  # load_image downscales past fc.MAX_SIDE
    t = 0.0 if row["kind"] == "video" else -1.0
    res = []
    for i, f in enumerate(fc.faces(bgr)):
        box = f["box"]
        side = min(box[2] - box[0], box[3] - box[1]) / img_scale * s
        crop = ""
        if side >= MIN_CROP:
            crop = f"{k}_{i}.jpg"
            fc.save_crop(bgr, box, os.path.join(fc.CROPS, crop))
        roll, fix, emb = fc.orient(bgr, box, f["emb"]) if crop else (None, "", f["emb"])
        res.append(dict(t=t, box=[v / img_scale * s for v in box], det=f["det"], sharp=fc.sharpness(bgr, box),
                        emb=emb, crop=crop, roll=roll, fix=fix))
    return res, W, H, (fc.image_sharpness(bgr) if row["kind"] == "photo" else 0.0)


def scan_video(path, k):
    res = []
    w = h = 0
    for j, (t, frame) in enumerate(fc.video_frames(path)):
        h, w = frame.shape[:2]
        for i, f in enumerate(fc.faces(frame)):
            box = f["box"]
            side = min(box[2] - box[0], box[3] - box[1])
            crop = ""
            if side >= MIN_CROP:
                crop = f"{k}_v{j}_{i}.jpg"
                fc.save_crop(frame, box, os.path.join(fc.CROPS, crop))
            roll, fix, emb = fc.orient(frame, box, f["emb"]) if crop else (None, "", f["emb"])
            res.append(dict(t=t, box=box, det=f["det"], sharp=fc.sharpness(frame, box), emb=emb, crop=crop,
                            roll=roll, fix=fix))
    return res, w, h, 0.0


def main():
    do_videos = "--videos" in sys.argv
    os.makedirs(os.path.join(fc.DATA, "per_file"), exist_ok=True)
    os.makedirs(fc.CROPS, exist_ok=True)
    ids = manifest_ids()
    files = []
    for dp, _dn, fn in os.walk(fc.DRIVE):
        for n in sorted(fn):
            if n.endswith(".part"):
                continue
            ext = os.path.splitext(n)[1].lower()
            kind = "photo" if ext in fc.IMG_EXT else "video" if ext in fc.VID_EXT else None
            if kind:
                files.append((os.path.relpath(os.path.join(dp, n), fc.DRIVE), kind))
    on_disk = {rel for rel, _kind in files}
    previews = {rel: r for rel, r in preview_rows().items() if rel not in on_disk}
    for rel, r in previews.items():
        files.append((rel, r["kind"]))
    files.sort()
    t0 = time.time()
    rows, embs, photos, errors = [], [], [], []
    compute = {"photo": 0.0, "video": 0.0}
    fc.app()
    t_model = time.time()
    for n, (rel, kind) in enumerate(files, 1):
        pv = previews.get(rel)
        k = key("preview:" + rel if pv else rel)
        cache = os.path.join(fc.DATA, "per_file", k + ".json")
        cemb = os.path.join(fc.DATA, "per_file", k + ".npy")
        if os.path.exists(cache):
            with open(cache) as f:
                meta = json.load(f)
            e = np.load(cemb) if os.path.exists(cemb) else np.zeros((0, 512), np.float32)
        elif kind == "video" and not do_videos and not pv:
            continue
        else:
            try:
                ts = time.time()
                if pv:
                    res, w, h, isharp = scan_preview(pv, k)
                else:
                    fn = scan_image if kind == "photo" else scan_video
                    res, w, h, isharp = fn(os.path.join(fc.DRIVE, rel), k)
                secs = time.time() - ts
            except Exception as ex:  # noqa: BLE001
                errors.append((rel, repr(ex)))
                print(f"ERR {rel}: {ex}", flush=True)
                continue
            e = np.stack([r.pop("emb") for r in res]) if res else np.zeros((0, 512), np.float32)
            meta = dict(rel=rel, kind=kind, w=w, h=h, img_sharp=isharp, secs=round(secs, 3), faces=res,
                        **({"preview": pv["id"]} if pv else {}))
            # atomic: .npy first, then .json (the json is the "done" marker)
            with open(cemb + ".tmp", "wb") as f:
                np.save(f, e)
            os.replace(cemb + ".tmp", cemb)
            with open(cache + ".tmp", "w") as f:
                json.dump(meta, f)
            os.replace(cache + ".tmp", cache)
        compute[kind] += meta.get("secs", 0.0)
        fid = pv["id"] if pv else ids.get(rel, "")
        photos.append((k, rel, kind, meta["w"], meta["h"], len(meta["faces"]), meta["img_sharp"], fid))
        for i, r in enumerate(meta["faces"]):
            x1, y1, x2, y2 = r["box"]
            roll = r.get("roll")  # absent: cache from before the orientation pass (run upright.py)
            rows.append((f"{k}_{i}", k, rel, kind, r["t"], x1, y1, x2, y2, r["det"], r["sharp"], r["crop"],
                         "" if roll is None else roll, r.get("fix", "")))
            embs.append(e[i])
        if n % 50 == 0:
            el = time.time() - t0
            print(f"[{n}/{len(files)} {el:.0f}s] faces so far {len(rows)}", flush=True)
    with open(os.path.join(fc.DATA, "faces.tsv"), "w", encoding="utf-8") as f:
        f.write("face_id\tfile_key\trel\tkind\tt\tx1\ty1\tx2\ty2\tdet\tsharp\tcrop\troll\tfix\n")
        for r in rows:
            f.write("\t".join(str(v) for v in r) + "\n")
    np.save(os.path.join(fc.DATA, "emb.npy"), np.stack(embs) if embs else np.zeros((0, 512), np.float32))
    with open(os.path.join(fc.DATA, "photos.tsv"), "w", encoding="utf-8") as f:
        f.write("file_key\trel\tkind\tw\th\tn_faces\timg_sharp\tdrive_id\n")
        for r in photos:
            f.write("\t".join(str(v) for v in r) + "\n")
    stats = dict(
        files_seen=len(files),
        files_scanned=len(photos),
        photos=sum(p[2] == "photo" for p in photos),
        videos=sum(p[2] == "video" for p in photos),
        faces=len(rows),
        previews=len(previews),
        errors=errors,
        seconds_total=round(time.time() - t0, 1),
        seconds_model_load=round(t_model - t0, 1),
        compute_seconds_photos=round(compute["photo"], 1),
        compute_seconds_videos=round(compute["video"], 1),
    )
    with open(os.path.join(fc.DATA, "scan_stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
