#!/usr/bin/env python3
"""Download every file from listing.tsv (from list_drive.py), politely.

4 workers, retries with backoff, resumable (a file already on disk with the
right size is kept and only hashed). Videos larger than 500 MB are skipped and
listed. Stdlib only.

usage: python3 -I pipeline/scan/download.py LISTING.tsv DEST_DIR MANIFEST.tsv [--seed]
Writes MANIFEST.tsv (id, name, size, sha256, subfolder) and skipped.tsv /
failed.tsv next to it, checkpointed every 25 files (atomic rewrite), so a
stopped run resumes: ids in the manifest whose file is on disk at that size,
and ids in skipped.tsv, are not touched again (no network). Interrupted
downloads only ever leave NAME.part, never a truncated final file.
--seed: no network; hash complete files already on disk into the manifest.
"""
import concurrent.futures as cf
import hashlib
import os
import sys
import threading
import time
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
URL = "https://drive.usercontent.google.com/download?id={}&export=download&confirm=t"
VIDEO_CAP = 500 * 1024 * 1024
WORKERS = 4
lock = threading.Lock()


def safe(name):
    return name.replace("/", "_").replace("\0", "_").lstrip(".") or "unnamed"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def remote_size(fid):
    req = urllib.request.Request(URL.format(fid), headers={"User-Agent": UA, "Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        cr = r.headers.get("Content-Range", "")
        ctype = r.headers.get("Content-Type", "")
        if "text/html" in ctype:
            raise RuntimeError("got HTML instead of file (quota or permission page)")
        if "/" in cr:
            return int(cr.rsplit("/", 1)[1])
        return int(r.headers.get("Content-Length", "-1"))


def fetch(row, dest_root):
    fid, name, mime, sub = row
    d = os.path.join(dest_root, sub) if sub else dest_root
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, safe(name))
    last = None
    for attempt in range(5):
        try:
            size = remote_size(fid)
            if mime.startswith("video/") and size > VIDEO_CAP:
                return ("skipped", fid, name, size, "", sub)
            if os.path.exists(path) and os.path.getsize(path) == size:
                return ("ok", fid, name, size, sha256(path), sub)
            part = path + ".part"
            req = urllib.request.Request(URL.format(fid), headers={"User-Agent": UA})
            h = hashlib.sha256()
            got = 0
            with urllib.request.urlopen(req, timeout=120) as r, open(part, "wb") as f:
                if "text/html" in r.headers.get("Content-Type", ""):
                    raise RuntimeError("got HTML instead of file")
                for chunk in iter(lambda: r.read(1 << 20), b""):
                    f.write(chunk)
                    h.update(chunk)
                    got += len(chunk)
            if size >= 0 and got != size:
                raise RuntimeError(f"short read {got}/{size}")
            os.replace(part, path)
            return ("ok", fid, name, got, h.hexdigest(), sub)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * 2 ** attempt)
    return ("failed", fid, name, -1, str(last), sub)


def load_tsv(path):
    out = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            next(f, None)
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) >= 5 and p[0]:
                    out[p[0]] = p
    return out


def write_tsv(path, rows, last="info"):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(f"id\tname\tsize\t{last}\tsubfolder\n")
        for r in rows:
            f.write("\t".join(str(x) for x in r) + "\n")
    os.replace(tmp, path)


def main():
    listing, dest, manifest = sys.argv[1:4]
    seed = "--seed" in sys.argv  # hash files already on disk into the manifest, no network
    rows = []
    with open(listing, encoding="utf-8") as f:
        next(f)
        for line in f:
            p = line.rstrip("\n").split("\t")
            rows.append((p[0], p[1], p[2], p[3] if len(p) > 3 else ""))
    out_dir = os.path.dirname(os.path.abspath(manifest))
    skipped_p = os.path.join(out_dir, "skipped.tsv")
    done = load_tsv(manifest)  # id -> [id, name, size, sha256, sub]
    skipped = load_tsv(skipped_p)
    results, todo = [], []
    for r in rows:
        fid, name, _mime, sub = r
        path = os.path.join(dest, sub, safe(name)) if sub else os.path.join(dest, safe(name))
        if fid in done and os.path.exists(path) and os.path.getsize(path) == int(done[fid][2]):
            results.append(("ok", fid, name, int(done[fid][2]), done[fid][3], sub))
        elif fid in skipped:
            results.append(("skipped", fid, name, int(skipped[fid][2]), "", sub))
        elif seed and os.path.exists(path):
            # final names only appear via os.replace after a full, size-checked read
            results.append(("ok", fid, name, os.path.getsize(path), sha256(path), sub))
        else:
            todo.append(r)
    print(f"resume: {len(results)} already done/skipped, {len(todo)} to fetch", flush=True)

    def checkpoint():
        ok = sorted((r for r in results if r[0] == "ok"), key=lambda r: (r[5], r[2]))
        write_tsv(manifest, [(fid, n, sz, d, sub) for _s, fid, n, sz, d, sub in ok], last="sha256")
        sk = sorted((r for r in results if r[0] == "skipped"), key=lambda r: (r[5], r[2]))
        write_tsv(skipped_p, [(fid, n, sz, "video over 500 MB", sub) for _s, fid, n, sz, _d, sub in sk])

    checkpoint()
    t0 = time.time()
    if todo and not seed:
        with cf.ThreadPoolExecutor(WORKERS) as ex:
            futs = [ex.submit(fetch, r, dest) for r in todo]
            for i, fu in enumerate(cf.as_completed(futs), 1):
                res = fu.result()
                results.append(res)
                if res[0] != "ok" or i % 50 == 0:
                    print(f"[{i}/{len(todo)} {time.time()-t0:.0f}s] {res[0]} {res[2]} {res[3]}", flush=True)
                if i % 25 == 0:
                    checkpoint()
    checkpoint()
    fl = sorted((r for r in results if r[0] == "failed"), key=lambda r: r[2])
    write_tsv(os.path.join(out_dir, "failed.tsv"), [(fid, n, sz, info, sub) for _s, fid, n, sz, info, sub in fl])
    c = {k: sum(r[0] == k for r in results) for k in ("ok", "skipped", "failed")}
    c["not_fetched"] = len(todo) if seed else 0
    print(f"done in {time.time()-t0:.0f}s: {c}", flush=True)


if __name__ == "__main__":
    main()
