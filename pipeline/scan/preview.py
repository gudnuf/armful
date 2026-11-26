#!/usr/bin/env python3
"""Ingest new Drive files from previews only: no full download (for a metered connection).

usage: python -I pipeline/scan/preview.py LISTING.tsv IDS.txt [--ffprobe PATH] [--size 1600]
LISTING.tsv is list_drive.py's (id, name, mime, subfolder); IDS.txt holds one Drive id per line,
the files to ingest. Needs Pillow (and ffprobe for videos). Writes, under $ARMFUL_FOOTAGE/preview/:

  thumb/NAME.jpg     Drive's own thumbnail (the page's URL, sz=w<size>): what the scan detects faces on
  head/NAME          photos: the first 128 KB of the original (EXIF and the frame header live there)
  head/NAME.meta.mov videos: the original's top-level atoms without mdat (ftyp ... moov), which
                     ffprobe reads like the file: creation time, size, rotation, duration
  preview.tsv        one row per file: id, name, subfolder, kind, w, h, dims (where w x h came from:
                     head, moov or thumb), thumb_w, thumb_h, thumb, head, remote_size
  bytes.tsv          every HTTP response: id, what, status, body bytes, header bytes

Every Range request must come back 206 with a Content-Range and the asked-for length, or the
head is refused (and the file falls back to the thumbnail's aspect ratio, undated).
A video's moov is found by walking the top-level atom sizes from the first 4 KB and fetched
alone; no video body is ever fetched. Files keep going on any failure: a file with no thumbnail
still gets a row (w x h from its head; no faces). Resumable: rows already in preview.tsv
whose thumbnail is on disk are kept with no network.

These are previews, not originals: they never enter manifest.tsv. When the original is later
downloaded into drive/ under the same name, scan.py scans the original and ignores the preview.
"""
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "gallery"))
import media_size  # noqa: E402

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
DL = "https://drive.usercontent.google.com/download?id={}&export=download&confirm=t"
THUMB = "https://drive.google.com/thumbnail?id={}&sz=w{}"
PHOTO_HEAD = 128 * 1024
VIDEO_HEAD = 4096
MOOV_MAX = 8 * 1024 * 1024  # a moov larger than this is not fetched (the video stays undated)
COLS = ["id", "name", "subfolder", "kind", "w", "h", "dims", "thumb_w", "thumb_h", "thumb", "head", "remote_size"]


def footage():
    v = os.environ.get("ARMFUL_FOOTAGE")
    if not v:
        sys.exit("ARMFUL_FOOTAGE is not set: the local copy of the collection (preview/ is written inside it)")
    return os.path.expanduser(v)


def safe(name):
    return name.replace("/", "_").replace("\0", "_").lstrip(".") or "unnamed"


class Net:
    def __init__(self, log_path):
        self.log = open(log_path, "a", encoding="utf-8")
        self.total = 0

    def get(self, fid, what, url, rng=None):
        """(status, headers, body). Body and header bytes are logged and summed."""
        h = {"User-Agent": UA}
        if rng:
            h["Range"] = f"bytes={rng[0]}-{rng[1]}"
        last = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=90) as r:
                    body = r.read()
                    hdr = sum(len(k) + len(v) + 4 for k, v in r.headers.items()) + 20
                    self._note(fid, what, r.status, len(body), hdr)
                    return r.status, r.headers, body
            except urllib.error.HTTPError as e:
                self._note(fid, what, e.code, 0, 0)
                last = e
                if e.code < 500:
                    break
            except Exception as e:  # noqa: BLE001
                self._note(fid, what, "err", 0, 0)
                last = e
            time.sleep(2 * 2 ** attempt)
        raise RuntimeError(f"{what} {fid}: {last}")

    def _note(self, fid, what, status, body, hdr):
        self.total += body + hdr
        self.log.write(f"{fid}\t{what}\t{status}\t{body}\t{hdr}\n")
        self.log.flush()


def ranged(net, fid, what, start, end):
    """Exactly bytes start..end of the original, or RuntimeError; also the file's full size."""
    status, hdr, body = net.get(fid, what, DL.format(fid), (start, end))
    cr = hdr.get("Content-Range", "")
    if status != 206 or "/" not in cr or "text/html" in hdr.get("Content-Type", ""):
        raise RuntimeError(f"{what} {fid}: no partial content (status {status}, Content-Range {cr!r})")
    total = int(cr.rsplit("/", 1)[1])
    if len(body) != min(end, total - 1) - start + 1:
        raise RuntimeError(f"{what} {fid}: got {len(body)} bytes for {start}-{end} of {total}")
    return body, total


def atom_at(buf, o):
    """(type, size, header length) of the atom starting at buf[o:], or None if it does not fit."""
    if o + 8 > len(buf):
        return None
    sz, t = struct.unpack(">I4s", buf[o : o + 8])
    hl = 8
    if sz == 1:
        if o + 16 > len(buf):
            return None
        sz, hl = struct.unpack(">Q", buf[o + 8 : o + 16])[0], 16
    return t.decode("latin1"), sz, hl


def video_meta(net, fid):
    """The original's top-level atoms minus mdat (bytes), and its full size."""
    head, total = ranged(net, fid, "head", 0, VIDEO_HEAD - 1)
    parts, o = [], 0
    while o < total:
        if o + 16 <= len(head):
            buf, base = head, 0
        else:
            buf, _ = ranged(net, fid, "atom", o, min(o + 15, total - 1))
            base = o
        a = atom_at(buf, o - base)
        if a is None:
            raise RuntimeError(f"atom at {o}: header does not fit")
        t, sz, _hl = a
        if sz == 0:
            sz = total - o
        if sz < 8:
            raise RuntimeError(f"atom {t!r} at {o}: bad size {sz}")
        if t != "mdat":
            if sz > MOOV_MAX:
                raise RuntimeError(f"atom {t!r} at {o}: {sz} bytes, over the cap")
            if o + sz <= len(head):
                parts.append(head[o : o + sz])
            else:
                body, _ = ranged(net, fid, t, o, o + sz - 1)
                parts.append(body)
        o += sz
    if not any(p[4:8] == b"moov" for p in parts):
        raise RuntimeError("no moov atom")
    return b"".join(parts), total


def write(path, data):
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)


def load_rows(path):
    rows = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            hdr = next(f).rstrip("\n").split("\t")
            for line in f:
                r = dict(zip(hdr, line.rstrip("\n").split("\t")))
                rows[r["id"]] = r
    return rows


def save_rows(path, rows):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write("\t".join(COLS) + "\n")
        for r in sorted(rows.values(), key=lambda r: (r["subfolder"], r["name"])):
            f.write("\t".join(str(r.get(c, "")) for c in COLS) + "\n")
    os.replace(path + ".tmp", path)


def main():
    args = sys.argv[1:]
    ffprobe = None
    size = 1600
    if "--ffprobe" in args:
        ffprobe = args[args.index("--ffprobe") + 1]
    if "--size" in args:
        size = int(args[args.index("--size") + 1])
    listing_p, ids_p = args[0], args[1]
    want = [ln.strip() for ln in open(ids_p, encoding="utf-8") if ln.strip()]
    listing = {}
    with open(listing_p, encoding="utf-8") as f:
        next(f)
        for line in f:
            p = line.rstrip("\n").split("\t")
            listing[p[0]] = (p[1], p[2], p[3] if len(p) > 3 else "")
    missing = [i for i in want if i not in listing]
    if missing:
        sys.exit(f"{len(missing)} ids are not in {listing_p} (e.g. {missing[0]}); nothing fetched")
    root = os.path.join(footage(), "preview")
    for d in ("thumb", "head"):
        os.makedirs(os.path.join(root, d), exist_ok=True)
    tsv = os.path.join(root, "preview.tsv")
    rows = load_rows(tsv)
    net = Net(os.path.join(root, "bytes.tsv"))
    problems = []
    for n, fid in enumerate(want, 1):
        name, mime, sub = listing[fid]
        kind = "video" if mime.startswith("video/") else "photo"
        if fid in rows and os.path.exists(os.path.join(root, rows[fid]["thumb"] or "-")):
            continue
        stem = (sub.replace("/", "_") + "__" if sub else "") + safe(name)
        row = dict(id=fid, name=name, subfolder=sub, kind=kind, w=0, h=0, dims="", thumb_w=0, thumb_h=0,
                   thumb="", head="", remote_size="")
        try:
            if kind == "photo":
                body, total = ranged(net, fid, "head", 0, PHOTO_HEAD - 1)
                rel = f"head/{stem}"
            else:
                body, total = video_meta(net, fid)
                rel = f"head/{stem}.meta.mov"
            write(os.path.join(root, rel), body)
            row.update(head=rel, remote_size=total)
            got = media_size.probe(os.path.join(root, rel), kind, ffprobe)
            if got:
                row.update(w=got[0], h=got[1], dims="head" if kind == "photo" else "moov")
        except RuntimeError as e:
            problems.append((name, f"head: {e}"))
        try:
            status, hdr, body = net.get(fid, "thumb", THUMB.format(fid, size))
            if status != 200 or not hdr.get("Content-Type", "").startswith("image/"):
                raise RuntimeError(f"status {status}, {hdr.get('Content-Type')}")
            rel = f"thumb/{stem}.jpg"
            write(os.path.join(root, rel), body)
            tw, th = media_size.image_size(os.path.join(root, rel)) or (0, 0)
            row.update(thumb=rel, thumb_w=tw, thumb_h=th)
            if not row["dims"] and tw and th:
                row.update(w=tw, h=th, dims="thumb")  # aspect ratio only: the original's size is unknown
        except RuntimeError as e:
            problems.append((name, f"thumb: {e}"))
        rows[fid] = row
        save_rows(tsv, rows)
        print(f"[{n}/{len(want)}] {kind} {name} {row['w']}x{row['h']} ({row['dims'] or 'no size'}) "
              f"total {net.total / 1e6:.1f} MB", flush=True)
    save_rows(tsv, rows)
    print(json.dumps(dict(files=len(want), rows=len(rows), bytes_this_run=net.total, problems=problems), indent=1))


if __name__ == "__main__":
    main()
