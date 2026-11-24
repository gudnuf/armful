#!/usr/bin/env python3
"""Cluster face embeddings into people.

usage: python -I pipeline/scan/cluster.py [--thresh 0.65]
Core faces (good detection, big enough) are clustered with agglomerative
average-linkage on cosine distance. Weaker faces are then attached to the
nearest cluster centroid if similar enough (marked weak=1). Faces that upright.py could
not orient or had to drop (fix=drop) are left out altogether. Writes
data/clusters.tsv (face_id, cluster, sim_to_centroid, weak) and
data/clusters.json (summary per cluster).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from sklearn.cluster import AgglomerativeClustering  # noqa: E402

import facecore as fc  # noqa: E402

CORE_DET = 0.65
CORE_SIDE = 40  # px in original resolution
ATTACH_SIM = 0.45
MIN_CLUSTER = 2  # faces; smaller groups are singletons (cluster -1)


def load_faces():
    rows = []
    with open(os.path.join(fc.DATA, "faces.tsv"), encoding="utf-8") as f:
        hdr = next(f).rstrip("\n").split("\t")
        for line in f:
            rows.append(dict(zip(hdr, line.rstrip("\n").split("\t"))))
    for r in rows:
        for k in ("t", "x1", "y1", "x2", "y2", "det", "sharp"):
            r[k] = float(r[k])
        r["side"] = min(r["x2"] - r["x1"], r["y2"] - r["y1"])
        r["drop"] = r.get("fix") == "drop"  # rolled past upright and not recoverable (upright.py)
        # roll unknown: no rotation of the face shows the detector an upright face (backs of heads,
        # blur, paintings, feet, flowers). Their embeddings all land in one "not a face" corner, so
        # they are left out of clustering: 251 of them had glued themselves onto one junk person.
        r["oriented"] = "roll" not in r or r["roll"] != ""
    return rows, np.load(os.path.join(fc.DATA, "emb.npy"))


def main():
    thresh = 0.65
    if "--thresh" in sys.argv:
        thresh = float(sys.argv[sys.argv.index("--thresh") + 1])
    rows, E = load_faces()
    core = np.array([r["det"] >= CORE_DET and r["side"] >= CORE_SIDE and not r["drop"] and r["oriented"] for r in rows])
    ci = np.where(core)[0]
    labels = np.full(len(rows), -1)
    if len(ci) >= 2:
        ag = AgglomerativeClustering(
            n_clusters=None, metric="cosine", linkage="average", distance_threshold=thresh
        )
        lab = ag.fit_predict(E[ci])
        labels[ci] = lab
    # drop tiny clusters
    ids, counts = np.unique(labels[labels >= 0], return_counts=True)
    small = set(ids[counts < MIN_CLUSTER].tolist())
    labels = np.array([-1 if l in small else l for l in labels])
    # renumber by size (largest = 0) counting distinct files, not faces
    uniq = [l for l in np.unique(labels) if l >= 0]
    files_per = {l: len({rows[i]["file_key"] for i in np.where(labels == l)[0]}) for l in uniq}
    order = sorted(uniq, key=lambda l: -files_per[l])
    remap = {l: n for n, l in enumerate(order)}
    labels = np.array([remap.get(l, -1) for l in labels])
    nc = len(order)
    cent = np.zeros((nc, E.shape[1]), np.float32)
    for c in range(nc):
        v = E[labels == c].mean(0)
        cent[c] = v / np.linalg.norm(v)
    sims = E @ cent.T if nc else np.zeros((len(rows), 0))
    weak = np.zeros(len(rows), int)
    for i in range(len(rows)):
        if labels[i] == -1 and nc and not rows[i]["drop"] and (rows[i]["oriented"] or not rows[i]["crop"]):
            j = int(np.argmax(sims[i]))
            if sims[i, j] >= ATTACH_SIM and rows[i]["det"] >= 0.5:
                labels[i] = j
                weak[i] = 1
    with open(os.path.join(fc.DATA, "clusters.tsv"), "w") as f:
        f.write("face_id\tcluster\tsim\tweak\n")
        for i, r in enumerate(rows):
            s = float(sims[i, labels[i]]) if labels[i] >= 0 else 0.0
            f.write(f"{r['face_id']}\t{labels[i]}\t{s:.4f}\t{weak[i]}\n")
    summary = []
    for c in range(nc):
        idx = np.where(labels == c)[0]
        core_idx = [i for i in idx if not weak[i]]
        summary.append(
            dict(
                cluster=c,
                faces=int(len(idx)),
                core_faces=len(core_idx),
                files=len({rows[i]["file_key"] for i in idx}),
                photos=len({rows[i]["file_key"] for i in idx if rows[i]["kind"] == "photo"}),
                videos=len({rows[i]["file_key"] for i in idx if rows[i]["kind"] == "video"}),
                cohesion=round(float(np.mean(sims[core_idx, c])), 3) if core_idx else 0.0,
            )
        )
    out = dict(
        thresh=thresh,
        n_faces=len(rows),
        n_core=int(core.sum()),
        n_clusters=nc,
        n_clusters_3plus_photos=sum(s["files"] >= 3 for s in summary),
        unclustered=int((labels == -1).sum()),
        clusters=summary,
    )
    with open(os.path.join(fc.DATA, "clusters.json"), "w") as f:
        json.dump(out, f, indent=1)
    np.save(os.path.join(fc.DATA, "centroids.npy"), cent)
    print(json.dumps({k: v for k, v in out.items() if k != "clusters"}, indent=1))
    for s in summary[:25]:
        print(s)


if __name__ == "__main__":
    main()
