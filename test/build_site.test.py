#!/usr/bin/env python3
"""build_site.py on a tiny synthetic scan: per-collection paths, no bursts.

run: python3 -I test/build_site.test.py   (needs numpy + Pillow)
Everything is made up and lives in a temp dir: 3 placeholder files, 3 face
clusters (one of them hidden), no real ids, names or paths. A few tests point
the build at this checkout itself to check it refuses (nothing is written) or,
for git-ignored dist/, writes to a throwaway folder that is removed again.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "pipeline", "gallery", "build_site.py")
THUMBS = os.path.join(ROOT, "pipeline", "gallery", "verify_thumbs.py")

FACE_HDR = ["face_id", "file_key", "kind", "t", "x1", "y1", "x2", "y2", "det", "sharp", "roll", "crop"]
# (face id, file, cluster): person A in f1 + f3, person B in f2 + f3, a third person in f1 only
FACES = [("a1", "f1", 0), ("a2", "f3", 0), ("b1", "f2", 1), ("b2", "f3", 1), ("c1", "f1", 2)]
# a later scan: the same faces, and person B now also in two new files (so B outranks A by file count)
FACES_LATER = FACES + [("b3", "f4", 1), ("b4", "f5", 1)]


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def write_tsv(path, hdr, rows):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\t".join(hdr) + "\n")
        for r in rows:
            f.write("\t".join(str(v) for v in r) + "\n")


def make_scan(tmp, faces=FACES):
    """(Re)write the synthetic scan output and footage manifest; returns (scan root, footage root)."""
    scan, footage = os.path.join(tmp, "scan"), os.path.join(tmp, "footage")
    data = os.path.join(scan, "data")
    os.makedirs(data, exist_ok=True)
    os.makedirs(os.path.join(footage, "drive"), exist_ok=True)
    keys = sorted({k for _f, k, _c in faces}, key=lambda k: int(k[1:]))
    write_tsv(
        os.path.join(data, "photos.tsv"),
        ["file_key", "rel", "kind", "drive_id", "w", "h"],
        [(k, f"{k}.jpg", "photo", f"FAKE_ID_{k[1:]}", 1000, 800) for k in keys],
    )
    write_tsv(
        os.path.join(footage, "manifest.tsv"),
        ["id", "name", "size", "sha256", "subfolder"],
        [(f"FAKE_ID_{k[1:]}", f"{k}.jpg", 1, "0" * 64, "") for k in keys],
    )
    rows = []
    for n, (fid, key, _c) in enumerate(faces):
        x = 100 + 100 * n
        rows.append((fid, key, "photo", "", x, 100, x + 90, 190, 0.9, 200, 0.0, f"{fid}.jpg"))
    write_tsv(os.path.join(data, "faces.tsv"), FACE_HDR, rows)
    write_tsv(os.path.join(data, "clusters.tsv"), ["face_id", "cluster", "sim", "weak"], [(f, c, 0.9, 0) for f, _k, c in faces])
    emb = np.zeros((len(faces), 8), np.float32)
    for n, (_f, _k, c) in enumerate(faces):
        emb[n, c] = 1.0  # one orthogonal direction per person: nothing merges
    np.save(os.path.join(data, "emb.npy"), emb)
    np.save(os.path.join(data, "centroids.npy"), np.eye(3, 8, dtype=np.float32))
    return scan, footage


def make_collection(tmp, hidden=None, name="t"):
    """A collection folder; hidden=None leaves out the optional hidden.json."""
    col = os.path.join(tmp, "collections", name)
    os.makedirs(col)
    dump(dict(slug=name, title="test title", drive_folder="DRIVE_FOLDER_ID", door_photo="DRIVE_FILE_ID",
              door_position="center 30%", hidden=[]), os.path.join(col, "collection.json"))
    if hidden is not None:
        dump(hidden, os.path.join(col, "hidden.json"))
    return col


def snapshot(*dirs):
    """Every file under the given folders with its bytes (missing folder -> nothing)."""
    out = {}
    for d in dirs:
        for dp, _dn, fn in os.walk(d):
            for n in fn:
                p = os.path.join(dp, n)
                with open(p, "rb") as f:
                    out[p] = f.read()
    return out


class BuildSite(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        scan, footage = make_scan(self.tmp)
        self.env = dict(os.environ, ARMFUL_SCAN_ROOT=scan, ARMFUL_FOOTAGE=footage)
        self.env.pop("ARMFUL_COLLECTION", None)

    def build(self, *args, env=None, ok=True, script=BUILD):
        r = subprocess.run([sys.executable, "-I", script, *args], env=env or self.env, capture_output=True, text=True, cwd=self.tmp)
        if ok:
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        else:
            self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    # -- output -------------------------------------------------------------------------------

    def test_explicit_out(self):
        col = make_collection(self.tmp, [])
        self.build("--collection", col)  # first build: saves the person ids
        dump([3], os.path.join(col, "hidden.json"))  # the one-photo person got id 3 (ids go by photo count)
        out = os.path.join(self.tmp, "dist", "t")
        self.build("--collection", col, "--out", out)
        d = load(os.path.join(out, "data.json"))
        self.assertEqual(len(d["files"]), 3)
        self.assertEqual(len(d["people"]), 2)
        self.assertNotIn("bursts", d)
        self.assertEqual(d["slug"], "t")
        self.assertEqual(d["title"], "test title")
        self.assertEqual(sorted(p["id"] for p in d["people"]), [1, 2])
        self.assertTrue(all(3 not in f["p"] for f in d["files"]), "hidden person still listed on a file")
        self.assertEqual([f["p"] for f in d["files"]], [[1], [2], [1, 2]])
        for name in ("reps.json", "person_faces.json", "build_report.json"):
            self.assertTrue(os.path.exists(os.path.join(col, "state", name)), name)
        self.assertNotIn("bursts", load(os.path.join(col, "state", "build_report.json")))

    def test_default_out_is_collection_dist_and_env_collection(self):
        col = make_collection(self.tmp, [])
        self.build(env=dict(self.env, ARMFUL_COLLECTION=col))
        d = load(os.path.join(col, "dist", "data.json"))
        self.assertEqual(len(d["people"]), 3)
        self.assertNotIn("bursts", d)

    def test_relative_paths_from_cwd(self):
        make_collection(self.tmp, [])
        self.build("--collection", "collections/t", "--out", "out/t")
        self.assertEqual(len(load(os.path.join(self.tmp, "out", "t", "data.json"))["files"]), 3)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "collections", "t", "state", "person_faces.json")))

    def test_data_json_written_atomically(self):
        # a new file is renamed into place: a hard link to the old data.json keeps the old bytes
        # (an in-place rewrite would change them, and a crash mid-write would leave half a file)
        col = make_collection(self.tmp, [])
        os.makedirs(os.path.join(col, "dist"))
        keep = os.path.join(self.tmp, "keep.json")
        dump({"old": 1}, keep)
        os.link(keep, os.path.join(col, "dist", "data.json"))
        self.build("--collection", col)
        self.assertEqual(load(keep), {"old": 1})
        self.assertIn("files", load(os.path.join(col, "dist", "data.json")))
        self.assertEqual(sorted(os.listdir(os.path.join(col, "dist"))), ["data.json"])

    # -- stable ids and hidden people ---------------------------------------------------------

    def test_ids_stay_with_faces_when_rank_changes(self):
        col = make_collection(self.tmp, [])
        self.build("--collection", col)
        d1 = load(os.path.join(col, "dist", "data.json"))
        self.assertEqual([f["p"] for f in d1["files"]], [[1, 3], [2], [1, 2]])  # A = 1, B = 2 (tie, A first)
        dump([2], os.path.join(col, "hidden.json"))  # hide B
        make_scan(self.tmp, FACES_LATER)  # B now in 4 files, A in 2: ranked by count, B would become 1
        self.build("--collection", col)
        d2 = load(os.path.join(col, "dist", "data.json"))
        self.assertEqual(sorted(p["id"] for p in d2["people"]), [1, 3], "B lost its id or its hidden rule")
        self.assertEqual([f["p"] for f in d2["files"]], [[1, 3], [], [1], [], []])
        self.assertEqual(sorted(load(os.path.join(col, "state", "person_faces.json"))["2"]), ["b1", "b2", "b3", "b4"])
        self.assertEqual(sorted(load(os.path.join(col, "state", "person_faces.json"))["1"]), ["a1", "a2"])

    def test_hidden_from_collection_json(self):
        col = make_collection(self.tmp, [])
        self.build("--collection", col)  # first build: saves the person ids
        c = load(os.path.join(col, "collection.json"))
        c["hidden"] = [3]
        dump(c, os.path.join(col, "collection.json"))
        self.build("--collection", col)
        d = load(os.path.join(col, "dist", "data.json"))
        self.assertEqual(sorted(p["id"] for p in d["people"]), [1, 2])

    def test_hidden_json_is_optional(self):
        col = make_collection(self.tmp, None)
        self.build("--collection", col)
        self.assertEqual(len(load(os.path.join(col, "dist", "data.json"))["people"]), 3)

    def test_hidden_without_id_state_fails_closed(self):
        # ids would renumber from 1 and the hidden ids would point at other people: refuse
        out = os.path.join(self.tmp, "dist", "t")
        for via_json in (True, False):
            with self.subTest(hidden_in="hidden.json" if via_json else "collection.json"):
                col = make_collection(self.tmp, [3] if via_json else [])
                if not via_json:
                    c = load(os.path.join(col, "collection.json"))
                    c["hidden"] = [3]
                    dump(c, os.path.join(col, "collection.json"))
                r = self.build("--collection", col, "--out", out, ok=False)
                self.assertIn("person_faces.json", r.stdout + r.stderr)
                self.assertFalse(os.path.exists(os.path.join(out, "data.json")), "data.json written anyway")
                self.assertFalse(os.path.exists(os.path.join(col, "state", "person_faces.json")), "fresh ids saved")
                shutil.rmtree(os.path.join(self.tmp, "collections"))
        # --fresh-ids is the explicit way to start ids over (the hidden list must then be redone)
        col = make_collection(self.tmp, [3])
        self.build("--collection", col, "--out", out, "--fresh-ids")
        self.assertEqual(len(load(os.path.join(out, "data.json"))["people"]), 2)

    def test_bad_hidden_json_leaves_state_and_output_untouched(self):
        col = make_collection(self.tmp, [])
        self.build("--collection", col)
        make_scan(self.tmp, FACES_LATER)  # a rebuild would change both the id map and data.json
        before = snapshot(os.path.join(col, "state"), os.path.join(col, "dist"))
        for bad in ("[3, ", '{"3": true}', '["x"]', "3"):
            with self.subTest(hidden=bad):
                with open(os.path.join(col, "hidden.json"), "w") as f:
                    f.write(bad)
                r = self.build("--collection", col, ok=False)
                self.assertIn("hidden", (r.stdout + r.stderr).lower())
                self.assertEqual(snapshot(os.path.join(col, "state"), os.path.join(col, "dist")), before)

    # -- required inputs ----------------------------------------------------------------------

    def test_missing_collection_fails(self):
        r = self.build(ok=False)
        self.assertIn("collection", (r.stdout + r.stderr).lower())

    def test_missing_collection_json_fails(self):
        col = os.path.join(self.tmp, "collections", "t")
        os.makedirs(col)
        r = self.build("--collection", col, ok=False)
        self.assertIn("collection.json", r.stdout + r.stderr)
        self.assertEqual(os.listdir(col), [], "wrote into a folder that is not a collection")

    def test_each_required_root_unset_fails(self):
        col = make_collection(self.tmp, [])
        for var in ("ARMFUL_SCAN_ROOT", "ARMFUL_FOOTAGE"):
            with self.subTest(unset=var):
                env = dict(self.env)
                env.pop(var)
                r = self.build("--collection", col, env=env, ok=False)
                self.assertIn(var, r.stdout + r.stderr)
                self.assertFalse(os.path.exists(os.path.join(col, "state")))
                self.assertFalse(os.path.exists(os.path.join(col, "dist")))

    # -- destinations inside this checkout ----------------------------------------------------

    def test_refuses_out_in_tracked_repo_dir(self):
        col = make_collection(self.tmp, [])
        target = os.path.join(ROOT, "pipeline", "gallery")
        before = sorted(os.listdir(target))
        r = self.build("--collection", col, "--out", target, ok=False)
        self.assertIn("git", (r.stdout + r.stderr).lower())
        self.assertEqual(sorted(os.listdir(target)), before)
        self.assertFalse(os.path.exists(os.path.join(col, "state")), "state written before the refusal")

    def test_refuses_out_symlinked_into_repo(self):
        col = make_collection(self.tmp, [])
        link = os.path.join(self.tmp, "sneaky")
        os.symlink(os.path.join(ROOT, "pipeline", "gallery"), link)
        before = sorted(os.listdir(link))
        self.build("--collection", col, "--out", link, ok=False)
        self.assertEqual(sorted(os.listdir(link)), before)

    def test_refuses_state_symlinked_into_repo(self):
        col = make_collection(self.tmp, [])
        os.symlink(os.path.join(ROOT, "pipeline", "gallery"), os.path.join(col, "state"))
        before = sorted(os.listdir(os.path.join(ROOT, "pipeline", "gallery")))
        self.build("--collection", col, ok=False)
        self.assertEqual(sorted(os.listdir(os.path.join(ROOT, "pipeline", "gallery"))), before)
        self.assertFalse(os.path.exists(os.path.join(col, "dist", "data.json")))

    def test_allows_ignored_dist_in_repo(self):
        col = make_collection(self.tmp, [])
        target = tempfile.mkdtemp(prefix="build-site-test-", dir=self._repo_dist())
        self.addCleanup(shutil.rmtree, target, True)
        self.build("--collection", col, "--out", target)
        self.assertEqual(len(load(os.path.join(target, "data.json"))["files"]), 3)

    def _repo_dist(self):
        d = os.path.join(ROOT, "dist")
        if not os.path.isdir(d):
            os.makedirs(d)
            self.addCleanup(shutil.rmtree, d, True)
        return d

    # -- verify scripts -----------------------------------------------------------------------

    def test_verify_thumbs_reads_collection_dist(self):
        # empty page data: no network calls; the report must land in the collection's state/
        col = make_collection(self.tmp, [])
        os.makedirs(os.path.join(col, "dist"))
        dump(dict(files=[], people=[]), os.path.join(col, "dist", "data.json"))
        self.build("--collection", col, script=THUMBS)
        rep = load(os.path.join(col, "state", "thumbs_report.json"))
        self.assertEqual(rep["wall_checked"], 0)
        self.assertEqual(rep["problems"], [])


def write_jpeg(path, when=None, offset=None):
    """A tiny placeholder JPEG; `when` "YYYY:MM:DD HH:MM:SS" goes in EXIF DateTimeOriginal."""
    exif = Image.Exif()
    if when:
        ifd = exif.get_ifd(0x8769)
        ifd[36867] = when
        if offset:
            ifd[36881] = offset
    Image.new("RGB", (8, 6), (120, 130, 125)).save(path, "JPEG", exif=exif)


def utc(*a):
    return int(datetime(*a, tzinfo=timezone.utc).timestamp())


# timed scan: (face id, file, cluster, frame time); cluster -1 = detected but never clustered
TFACES = [
    ("a1", "f1", 0, -1.0), ("a2", "f3", 0, -1.0),
    ("b1", "f2", 1, -1.0), ("b2", "f3", 1, -1.0), ("b3", "f4", 1, -1.0),
    ("c1", "f1", 2, -1.0),  # person C: hidden in some tests, still a face
    ("u1", "f2", -1, -1.0), ("u2", "f2", -1, -1.0), ("u3", "f3", -1, -1.0),
    ("v1", "f5", 1, 0.5), ("v2", "f5", -1, 0.5), ("v3", "f5", -1, 4.5),  # video: 2 faces at 0.5 s, 1 at 4.5 s
]
# a video where A and B appear one after the other, never in one frame: still a group of two
TFACES_TURNS = TFACES + [("w1", "f7", 0, 0.5), ("w2", "f7", 1, 8.5)]
TFILES = [("f1", "photo"), ("f2", "photo"), ("f3", "photo"), ("f4", "photo"), ("f5", "video"), ("f6", "photo")]


def make_timed_scan(tmp, faces=TFACES, files=TFILES):
    scan, footage = os.path.join(tmp, "scan"), os.path.join(tmp, "footage")
    data = os.path.join(scan, "data")
    os.makedirs(data, exist_ok=True)
    os.makedirs(os.path.join(footage, "drive"), exist_ok=True)
    ext = {"photo": "jpg", "video": "mov"}
    write_tsv(
        os.path.join(data, "photos.tsv"),
        ["file_key", "rel", "kind", "drive_id", "w", "h"],
        [(k, f"{k}.{ext[kind]}", kind, f"FAKE_ID_{k[1:]}", 1000, 800) for k, kind in files],
    )
    kind_of = dict(files)
    rows = [
        (fid, key, kind_of[key], t, 100 + 100 * n, 100, 190 + 100 * n, 190, 0.9, 200, 0.0, f"{fid}.jpg")
        for n, (fid, key, _c, t) in enumerate(faces)
    ]
    write_tsv(os.path.join(data, "faces.tsv"), FACE_HDR, rows)
    write_tsv(os.path.join(data, "clusters.tsv"), ["face_id", "cluster", "sim", "weak"], [(f, c, 0.9, 0) for f, _k, c, _t in faces])
    emb = np.zeros((len(faces), 8), np.float32)
    for n, (_f, _k, c, _t) in enumerate(faces):
        emb[n, c if c >= 0 else 7] = 1.0
    np.save(os.path.join(data, "emb.npy"), emb)
    np.save(os.path.join(data, "centroids.npy"), np.eye(3, 8, dtype=np.float32))
    return scan, footage


class TimeAndFaces(unittest.TestCase):
    """Capture time `t`, face count `nf`, ordering by time and the collection's `tz`."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        scan, self.footage = make_timed_scan(self.tmp)
        self.drive = os.path.join(self.footage, "drive")
        self.env = dict(os.environ, ARMFUL_SCAN_ROOT=scan, ARMFUL_FOOTAGE=self.footage)
        self.env.pop("ARMFUL_COLLECTION", None)
        # a stand-in ffprobe: prints the creation_time QuickTime would carry
        self.ffprobe = os.path.join(self.tmp, "fake-ffprobe")
        with open(self.ffprobe, "w") as f:
            f.write('#!/bin/sh\necho \'{"format":{"tags":{"creation_time":"2026-05-05T18:30:00.000000Z"}}}\'\n')
        os.chmod(self.ffprobe, 0o755)
        open(os.path.join(self.drive, "f5.mov"), "wb").close()

    def build(self, *args, ok=True):
        r = subprocess.run([sys.executable, "-I", BUILD, *args], env=self.env, capture_output=True, text=True, cwd=self.tmp)
        (self.assertEqual if ok else self.assertNotEqual)(r.returncode, 0, r.stdout + r.stderr)
        return r

    def col(self, tz="Asia/Tokyo", hidden=None):
        col = make_collection(self.tmp, hidden)
        if tz is not None:
            c = load(os.path.join(col, "collection.json"))
            c["tz"] = tz
            dump(c, os.path.join(col, "collection.json"))
        return col

    def photos(self):
        d = self.drive
        write_jpeg(os.path.join(d, "f1.jpg"), "2026:05:04 20:00:00", "+02:00")  # exact: 18:00 UTC
        write_jpeg(os.path.join(d, "f2.jpg"), "2026:05:04 08:30:00")  # no offset: local Tokyo (UTC+9) -> 23:30 UTC the day before
        write_jpeg(os.path.join(d, "f3.jpg"))  # no EXIF date: no t
        write_jpeg(os.path.join(d, "f4.jpg"), "0000:00:00 00:00:00")  # blank camera clock: no t
        write_jpeg(os.path.join(d, "f6.jpg"), "2026:05:06 07:00:00", "-01:30")  # 08:30 UTC

    def data(self, col):
        return load(os.path.join(col, "dist", "data.json"))

    def test_capture_times_and_order(self):
        self.photos()
        col = self.col()
        self.build("--collection", col, "--ffprobe", self.ffprobe)
        d = self.data(col)
        by = {f["i"]: f for f in d["files"]}
        self.assertEqual(by["FAKE_ID_1"]["t"], utc(2026, 5, 4, 18, 0))
        self.assertEqual(by["FAKE_ID_2"]["t"], utc(2026, 5, 3, 23, 30))
        self.assertEqual(by["FAKE_ID_5"]["t"], utc(2026, 5, 5, 18, 30))
        self.assertEqual(by["FAKE_ID_6"]["t"], utc(2026, 5, 6, 8, 30))
        self.assertNotIn("t", by["FAKE_ID_3"])
        self.assertNotIn("t", by["FAKE_ID_4"])
        # by time; files without one last, in their scan order (photos, then videos)
        self.assertEqual([f["i"][8:] for f in d["files"]], ["2", "1", "5", "6", "3", "4"])
        for f in d["files"]:
            self.assertEqual(set(f) - {"t", "v"}, {"i", "w", "h", "p", "nf"})
            self.assertTrue(all(isinstance(f[k], int) for k in ("w", "h", "nf") + (("t",) if "t" in f else ())))
        self.assertEqual(by["FAKE_ID_5"]["v"], 1)
        # each representative still points at a file holding that person
        for p in d["people"]:
            self.assertIn(p["id"], d["files"][p["rep"]["f"]]["p"])
        self.assertEqual(d["tz"], "Asia/Tokyo")

    def test_no_offset_uses_collection_zone_else_utc(self):
        self.photos()
        col = self.col(tz=None)
        self.build("--collection", col, "--ffprobe", self.ffprobe)
        d = self.data(col)
        self.assertNotIn("tz", d)
        by = {f["i"]: f for f in d["files"]}
        self.assertEqual(by["FAKE_ID_2"]["t"], utc(2026, 5, 4, 8, 30))  # read as UTC
        self.assertEqual(by["FAKE_ID_1"]["t"], utc(2026, 5, 4, 18, 0))  # an offset wins regardless

    def test_no_ffprobe_videos_get_no_time(self):
        self.photos()
        col = self.col()
        r = self.build("--collection", col, "--ffprobe", os.path.join(self.tmp, "no-such-ffprobe"))
        self.assertIn("ffprobe", r.stderr)
        by = {f["i"]: f for f in self.data(col)["files"]}
        self.assertNotIn("t", by["FAKE_ID_5"])
        self.assertIn("t", by["FAKE_ID_1"])

    def test_no_mtime_fallback(self):
        # no EXIF date: the file's modification time is not a capture time
        for k in ("f1", "f2", "f3", "f4", "f6"):
            write_jpeg(os.path.join(self.drive, f"{k}.jpg"))
            os.utime(os.path.join(self.drive, f"{k}.jpg"), (utc(2026, 5, 4, 12, 0),) * 2)
        col = self.col()
        self.build("--collection", col, "--ffprobe", os.path.join(self.tmp, "no-such-ffprobe"))
        self.assertTrue(all("t" not in f for f in self.data(col)["files"]))

    def test_face_counts_include_unclustered_and_hidden(self):
        col = self.col()
        self.build("--collection", col)  # save ids first (by file count): B=1, A=2, C=3
        dump([3], os.path.join(col, "hidden.json"))
        self.build("--collection", col)
        d = self.data(col)
        by = {f["i"]: f for f in d["files"]}
        self.assertEqual(by["FAKE_ID_1"]["p"], [2])  # C is hidden: no id ...
        self.assertEqual(by["FAKE_ID_1"]["nf"], 2)  # ... but still a face
        self.assertEqual(by["FAKE_ID_2"]["nf"], 3)  # B + two faces no person was made of
        self.assertEqual(by["FAKE_ID_3"]["nf"], 3)
        self.assertEqual(by["FAKE_ID_4"]["nf"], 1)
        self.assertEqual(by["FAKE_ID_5"]["nf"], 2)  # video: most faces in one frame, not the sum
        self.assertEqual(by["FAKE_ID_6"]["nf"], 0)  # no faces at all
        self.assertTrue(all(3 not in f["p"] for f in d["files"]))

    def test_video_people_in_turns_count_as_a_group(self):
        make_timed_scan(self.tmp, TFACES_TURNS, TFILES + [("f7", "video")])
        col = self.col()
        self.build("--collection", col)
        f7 = next(f for f in self.data(col)["files"] if f["i"] == "FAKE_ID_7")
        self.assertEqual((len(f7["p"]), f7["nf"]), (2, 2))
        for f in self.data(col)["files"]:
            self.assertGreaterEqual(f["nf"], len(f["p"]))

    def test_ordering_never_renumbers_people(self):
        col = self.col()
        self.build("--collection", col)  # no photo has a time yet: scan order
        d1 = self.data(col)
        ids1 = load(os.path.join(col, "state", "person_faces.json"))
        self.photos()  # now the files reorder by time
        self.build("--collection", col, "--ffprobe", self.ffprobe)
        d2 = self.data(col)
        self.assertNotEqual([f["i"] for f in d1["files"]], [f["i"] for f in d2["files"]], "order did not change")
        self.assertEqual(load(os.path.join(col, "state", "person_faces.json")), ids1)
        self.assertEqual({f["i"]: f["p"] for f in d1["files"]}, {f["i"]: f["p"] for f in d2["files"]})
        def people(d):  # rep by Drive id: its index moves with the files
            return sorted((p["id"], p["n"], p["nv"], d["files"][p["rep"]["f"]]["i"]) for p in d["people"])

        self.assertEqual(people(d1), people(d2))
        # and a fresh build (no saved ids) on reordered files numbers people the same way
        shutil.rmtree(os.path.join(col, "state"))
        self.build("--collection", col, "--ffprobe", self.ffprobe)
        self.assertEqual(load(os.path.join(col, "state", "person_faces.json")), ids1)

    def test_bad_tz_fails_before_writing(self):
        for bad in ("Mars/Olympus", "", 2):
            with self.subTest(tz=bad):
                col = self.col(tz=bad)
                r = self.build("--collection", col, ok=False)
                self.assertIn("tz", r.stdout + r.stderr)
                self.assertFalse(os.path.exists(os.path.join(col, "dist")))
                self.assertFalse(os.path.exists(os.path.join(col, "state", "person_faces.json")))
                shutil.rmtree(os.path.join(self.tmp, "collections"))

    def test_example_collection_zone_is_utc(self):
        self.assertEqual(load(os.path.join(ROOT, "collections", "example", "collection.json"))["tz"], "UTC")


if __name__ == "__main__":
    unittest.main(verbosity=2)
