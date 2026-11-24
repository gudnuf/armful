#!/usr/bin/env python3
"""Find upside-down / strongly rolled faces in the scan cache and re-embed them upright.

usage: python -I pipeline/scan/upright.py
Then: scan.py (rebuilds faces.tsv + emb.npy from the cache), cluster.py.

Why: an inverted face gets a poor embedding (the detector's landmarks on it are unreliable, so
the ArcFace alignment is wrong). Such faces sit near each other and near junk, not near their
owner: they formed one big "person" of strangers (found 2026-11-19).

For every cached face without a "roll" yet:
1. Roll estimate from the saved review crop (fc.roll_of: tries 0/90/180/270).
2. If |roll| > fc.ROLL_MAX: reload the photo (or video frame), rotate the face patch upright,
   detect + embed again. Success -> the embedding is replaced (fix="reemb"); no upright face
   found -> fix="drop" (kept in faces.tsv for stable ids, left out of clustering).
The original embeddings are kept next to the cache as <key>.npy.orig. Resumable.
New scans do the same inline (scan.py -> fc.orient).
"""
import glob
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

import facecore as fc  # noqa: E402


def frame_at(path, t):
    """The frame scan.py saw at time t (same seek, same downscale)."""
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return None
    h, w = frame.shape[:2]
    if max(h, w) > 1920:
        frame = cv2.resize(frame, None, fx=1920 / max(h, w), fy=1920 / max(h, w), interpolation=cv2.INTER_AREA)
    return frame


def main():
    files = sorted(glob.glob(os.path.join(fc.DATA, "per_file", "*.json")))
    fc.app()
    t0 = time.time()
    n_faces = n_rolled = n_reemb = n_drop = n_unknown = 0
    for n, cache in enumerate(files, 1):
        with open(cache) as f:
            meta = json.load(f)
        todo = [i for i, r in enumerate(meta["faces"]) if "roll" not in r]
        if todo:
            cemb = cache[:-5] + ".npy"
            e = np.load(cemb) if os.path.exists(cemb) else np.zeros((0, 512), np.float32)
            src, frames, changed = None, {}, False
            for i in todo:
                r = meta["faces"][i]
                r["roll"], r["fix"] = None, ""
                crop = cv2.imread(os.path.join(fc.CROPS, r["crop"])) if r["crop"] else None
                if crop is None:
                    continue  # too small for a crop: never a core face
                roll, _sc = fc.roll_of(fc.patch_from_crop(crop))
                r["roll"] = None if roll is None else round(roll, 1)
                if roll is None or abs(roll) <= fc.ROLL_MAX:
                    continue
                path = os.path.join(fc.DRIVE, meta["rel"])
                if meta["kind"] == "photo":
                    if src is None:
                        src = fc.load_image(path)
                    bgr, box = src[0], [v * src[1] for v in r["box"]]
                else:
                    if r["t"] not in frames:
                        frames[r["t"]] = frame_at(path, r["t"])
                    bgr, box = frames[r["t"]], r["box"]
                got = fc.upright_embed(fc.patch(bgr, box, size=480), roll) if bgr is not None else None
                if got is None:
                    r["fix"] = "drop"
                else:
                    r["fix"], r["det_upright"] = "reemb", round(got[1], 3)
                    e[i] = got[0]
                    changed = True
            if changed:
                if not os.path.exists(cemb + ".orig"):
                    shutil.copy2(cemb, cemb + ".orig")
                with open(cemb + ".tmp", "wb") as f:
                    np.save(f, e)
                os.replace(cemb + ".tmp", cemb)
            with open(cache + ".tmp", "w") as f:
                json.dump(meta, f)
            os.replace(cache + ".tmp", cache)
        for r in meta["faces"]:
            n_faces += 1
            n_unknown += r["roll"] is None
            n_rolled += r["roll"] is not None and abs(r["roll"]) > fc.ROLL_MAX
            n_reemb += r["fix"] == "reemb"
            n_drop += r["fix"] == "drop"
        if n % 100 == 0:
            print(f"[{n}/{len(files)} {time.time() - t0:.0f}s] rolled {n_rolled} reemb {n_reemb} drop {n_drop}", flush=True)
    out = dict(faces=n_faces, roll_unknown=n_unknown, rolled_over_max=n_rolled, reembedded=n_reemb, dropped=n_drop,
               roll_max=fc.ROLL_MAX, seconds=round(time.time() - t0, 1))
    with open(os.path.join(fc.DATA, "upright_stats.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
