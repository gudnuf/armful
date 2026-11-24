#!/usr/bin/env python3
"""build_site.py on a tiny synthetic scan: per-collection paths, no bursts.

run: python3 -I test/build_site.test.py   (needs numpy + Pillow)
Everything is made up and lives in a temp dir: a few placeholder files and face
clusters, no real ids, names or paths. A few tests point
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
# the synthetic people below have one to four photos each, so all of them are "uncertain" (too few
# photos to be sure): the suites that test ids, hiding, times and sizes keep them in (KEEP); the
# ClearPeople and Merges suites test the default, where uncertain people are left out
KEEP = "--keep-uncertain"

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
    np.save(os.path.join(data, "centroids.npy"), np.eye(max(3, 1 + max(c for _f, _k, c in faces)), 8, dtype=np.float32))
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
        extra = [KEEP] if script == BUILD else []
        r = subprocess.run([sys.executable, "-I", script, *args, *extra], env=env or self.env, capture_output=True, text=True, cwd=self.tmp)
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


# clear and uncertain people: A, B and D each on 3 photos with good faces (clear); C on one photo
# and E on two (uncertain: too few photos). Five orthogonal clusters: nothing merges by itself.
CFACES = [
    ("a1", "f1", 0), ("a2", "f2", 0), ("a3", "f3", 0),
    ("b1", "f2", 1), ("b2", "f3", 1), ("b3", "f4", 1),
    ("c1", "f1", 2),
    ("d1", "f4", 3), ("d2", "f5", 3), ("d3", "f6", 3),
    ("e1", "f5", 4), ("e2", "f6", 4),
]


class ClearScan(unittest.TestCase):
    """The CFACES scan in a temp dir, one collection, and helpers (no tests of its own)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        scan, footage = make_scan(self.tmp, CFACES)
        self.env = dict(os.environ, ARMFUL_SCAN_ROOT=scan, ARMFUL_FOOTAGE=footage)
        self.env.pop("ARMFUL_COLLECTION", None)
        self.col = make_collection(self.tmp, [])

    def build(self, *args, ok=True):
        r = subprocess.run([sys.executable, "-I", BUILD, "--collection", self.col, *args], env=self.env,
                           capture_output=True, text=True, cwd=self.tmp)
        (self.assertEqual if ok else self.assertNotEqual)(r.returncode, 0, r.stdout + r.stderr)
        return r

    def data(self):
        return load(os.path.join(self.col, "dist", "data.json"))

    def ids(self):
        return load(os.path.join(self.col, "state", "person_faces.json"))

    def of(self, face):
        return next(int(pid) for pid, fids in self.ids().items() if face in fids)


class ClearPeople(ClearScan):
    """By default data.json holds clear people only: uncertain ones are in no list and on no file."""

    def test_uncertain_people_are_left_out(self):
        self.build()
        d = self.data()
        clear = {self.of(f) for f in ("a1", "b1", "d1")}
        self.assertEqual({p["id"] for p in d["people"]}, clear)
        self.assertTrue(all("x" not in p for p in d["people"]))
        self.assertEqual({i for f in d["files"] for i in f["p"]}, clear, "an uncertain id is still on a file")
        by = {f["i"]: f for f in d["files"]}
        self.assertEqual(by["FAKE_ID_1"]["p"], [self.of("a1")])
        self.assertEqual(by["FAKE_ID_1"]["nf"], 2, "C is left out but still a face")
        self.assertEqual(by["FAKE_ID_5"]["nf"], 2)
        for p in d["people"]:
            self.assertEqual(p["n"], sum(p["id"] in f["p"] for f in d["files"]))
            self.assertIn(p["id"], d["files"][p["rep"]["f"]]["p"])
        # their ids are kept (a later scan may make them clear, and hidden ids must keep meaning the same)
        self.assertEqual(len(self.ids()), 5)
        rep = load(os.path.join(self.col, "state", "build_report.json"))
        self.assertEqual((rep["people_on_page"], rep["uncertain"], rep["uncertain_kept"]), (3, 2, False))

    def test_keep_uncertain_flag_and_same_ids(self):
        self.build()
        d1, ids1 = self.data(), self.ids()
        self.build(KEEP)
        d2 = self.data()
        self.assertEqual(self.ids(), ids1, "the flag moved an id")
        self.assertEqual(len(d2["people"]), 5)
        self.assertEqual(sorted(p["id"] for p in d2["people"] if p.get("x") == 1), sorted([self.of("c1"), self.of("e1")]))
        self.assertEqual([p for p in d2["people"] if "x" not in p], d1["people"])
        self.build()
        self.assertEqual(self.data(), d1)

    def test_hidden_still_works(self):
        self.build()
        b = self.of("b1")
        dump([b], os.path.join(self.col, "hidden.json"))
        self.build()
        d = self.data()
        self.assertNotIn(b, {p["id"] for p in d["people"]})
        self.assertTrue(all(b not in f["p"] for f in d["files"]))
        self.assertEqual(len(d["people"]), 2)


class Merges(ClearScan):
    """merges.json folds duplicate ids onto one canonical id."""

    def merge(self, m):
        dump(m, os.path.join(self.col, "merges.json"))

    def test_merge_folds_files_and_keeps_canonical_face(self):
        self.build()
        d0, ids0 = self.data(), self.ids()
        a, dd = self.of("a1"), self.of("d1")
        self.merge({str(dd): a})
        self.build()
        d = self.data()
        self.assertEqual(self.ids(), ids0, "a merge moved an id")
        self.assertEqual({p["id"] for p in d["people"]}, {a, self.of("b1")})
        pa = next(p for p in d["people"] if p["id"] == a)
        self.assertEqual((pa["n"], pa["nv"]), (6, 0), "A's files and D's, once each")
        self.assertTrue(all(dd not in f["p"] for f in d["files"]))
        self.assertEqual(sum(a in f["p"] for f in d["files"]), 6)
        rep0 = next(p for p in d0["people"] if p["id"] == a)["rep"]
        self.assertEqual(d["files"][pa["rep"]["f"]]["i"], d0["files"][rep0["f"]]["i"], "canonical's face kept")
        self.assertEqual(pa["rep"]["box"], rep0["box"])
        self.assertEqual(d["people"][0]["id"], a, "counts recomputed: A now leads")
        self.assertEqual(load(os.path.join(self.col, "state", "build_report.json"))["merged"], [[dd, a]])

    def test_merge_shares_a_photo_counts_it_once(self):
        self.build()
        a, b = self.of("a1"), self.of("b1")
        self.merge({str(b): a})
        self.build()
        pa = next(p for p in self.data()["people"] if p["id"] == a)
        self.assertEqual(pa["n"], 4)  # f1-f3 and f4
        self.assertTrue(all(f["p"].count(a) <= 1 for f in self.data()["files"]))

    def test_hidden_canonical_hides_what_is_merged_into_it(self):
        self.build()
        a, dd, b = self.of("a1"), self.of("d1"), self.of("b1")
        self.merge({str(dd): a})
        for hide in (a, dd):  # hiding the canonical id or the merged one hides the person
            with self.subTest(hidden=hide):
                dump([hide], os.path.join(self.col, "hidden.json"))
                self.build()
                d = self.data()
                self.assertEqual([p["id"] for p in d["people"]], [b])
                self.assertEqual({i for f in d["files"] for i in f["p"]}, {b})

    def test_bad_merges_write_nothing(self):
        self.build()
        a, b, dd, c = self.of("a1"), self.of("b1"), self.of("d1"), self.of("c1")
        before = snapshot(os.path.join(self.col, "state"), os.path.join(self.col, "dist"))
        for bad, why in (
            ("[1, 2]", "a JSON object"),
            ('{"x": 1}', "person ids"),
            (json.dumps({str(a): "1"}), "person ids"),
            (json.dumps({str(a): a}), "itself"),
            (json.dumps({str(dd): b, str(b): a}), "chains"),
            (json.dumps({str(dd): b, str(b): dd}), "chains"),
            (json.dumps({str(dd): 999}), "no person"),
            (json.dumps({"999": a}), "no person"),
            (json.dumps({str(c): a}), "uncertain"),
            (json.dumps({str(a): c}), "uncertain"),
            ("{", "not valid JSON"),
        ):
            with self.subTest(merges=bad):
                with open(os.path.join(self.col, "merges.json"), "w") as f:
                    f.write(bad)
                r = self.build(ok=False)
                self.assertIn(why, r.stdout + r.stderr)
                self.assertIn("nothing written", r.stdout + r.stderr)
                self.assertEqual(snapshot(os.path.join(self.col, "state"), os.path.join(self.col, "dist")), before)


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


def make_timed_scan(tmp, faces=TFACES, files=TFILES, sizes=None):
    """sizes: file key -> (w, h) as the scan recorded it (default 1000 x 800)."""
    sizes = sizes or {}
    scan, footage = os.path.join(tmp, "scan"), os.path.join(tmp, "footage")
    data = os.path.join(scan, "data")
    os.makedirs(data, exist_ok=True)
    os.makedirs(os.path.join(footage, "drive"), exist_ok=True)
    ext = {"photo": "jpg", "video": "mov"}
    write_tsv(
        os.path.join(data, "photos.tsv"),
        ["file_key", "rel", "kind", "drive_id", "w", "h"],
        [(k, f"{k}.{ext[kind]}", kind, f"FAKE_ID_{k[1:]}", *sizes.get(k, (1000, 800))) for k, kind in files],
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
        r = subprocess.run([sys.executable, "-I", BUILD, *args, KEEP], env=self.env, capture_output=True, text=True, cwd=self.tmp)
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


class Sizes(unittest.TestCase):
    """A file the scan recorded without a size (w or h <= 0) is sized from the file itself, or left out."""

    # a stand-in ffprobe: f5 a portrait phone video stored landscape with a -90 display matrix,
    # f7 the older `rotate` tag; any other file has no video stream. Both calls (capture time and
    # size) get the same JSON: each reads only its own part.
    FFPROBE = """#!/bin/sh
case "$*" in
  *f5.mov*) echo '{"format":{"tags":{"creation_time":"2026-05-05T18:30:00Z"}},"streams":[{"codec_type":"video","width":1920,"height":1440,"side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]}]}' ;;
  *f7.mov*) echo '{"streams":[{"codec_type":"video","width":1280,"height":720,"tags":{"rotate":"270"}}]}' ;;
  *) echo '{"streams":[]}' ;;
esac
"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.ffprobe = os.path.join(self.tmp, "fake-ffprobe")
        with open(self.ffprobe, "w") as f:
            f.write(self.FFPROBE)
        os.chmod(self.ffprobe, 0o755)

    def scan(self, sizes, files=TFILES + [("f7", "video")]):
        scan, footage = make_timed_scan(self.tmp, TFACES, files, sizes)
        self.drive = os.path.join(footage, "drive")
        self.env = dict(os.environ, ARMFUL_SCAN_ROOT=scan, ARMFUL_FOOTAGE=footage)
        self.env.pop("ARMFUL_COLLECTION", None)
        for k in ("f5", "f7"):
            open(os.path.join(self.drive, f"{k}.mov"), "wb").close()

    def build(self, col, *args, ok=True):
        r = subprocess.run([sys.executable, "-I", BUILD, "--collection", col, *args, KEEP], env=self.env,
                           capture_output=True, text=True, cwd=self.tmp)
        (self.assertEqual if ok else self.assertNotEqual)(r.returncode, 0, r.stdout + r.stderr)
        return r

    def jpeg(self, name, orientation=1):
        exif = Image.Exif()
        if orientation != 1:
            exif[274] = orientation
        Image.new("RGB", (8, 6), (120, 130, 125)).save(os.path.join(self.drive, name), "JPEG", exif=exif)

    def check_sizes(self, d):
        for f in d["files"]:
            self.assertTrue(isinstance(f["w"], int) and isinstance(f["h"], int) and f["w"] > 0 and f["h"] > 0, f)
        for p in d["people"]:
            self.assertIn(p["id"], d["files"][p["rep"]["f"]]["p"])
            self.assertTrue(all(v >= 0 for v in p["rep"]["box"]), p)

    def test_missing_sizes_read_from_the_files(self):
        self.scan({"f3": (0, 0), "f4": ("", ""), "f5": (0, 0), "f7": (0, 1)})
        self.jpeg("f3.jpg", orientation=6)  # stored 8 x 6, shown turned a quarter: 6 x 8
        self.jpeg("f4.jpg")  # plain: 8 x 6
        col = make_collection(self.tmp, [])
        self.build(col, "--ffprobe", self.ffprobe)
        d = load(os.path.join(col, "dist", "data.json"))
        by = {f["i"]: f for f in d["files"]}
        self.assertEqual(len(d["files"]), 7)
        self.assertEqual((by["FAKE_ID_3"]["w"], by["FAKE_ID_3"]["h"]), (6, 8))
        self.assertEqual((by["FAKE_ID_4"]["w"], by["FAKE_ID_4"]["h"]), (8, 6))
        self.assertEqual((by["FAKE_ID_5"]["w"], by["FAKE_ID_5"]["h"]), (1440, 1920))  # rotation -90
        self.assertEqual((by["FAKE_ID_7"]["w"], by["FAKE_ID_7"]["h"]), (720, 1280))  # rotate 270
        self.assertEqual((by["FAKE_ID_1"]["w"], by["FAKE_ID_1"]["h"]), (1000, 800))  # the scan's size stands
        self.check_sizes(d)
        rep = load(os.path.join(col, "state", "build_report.json"))
        self.assertEqual(rep["dropped"], [])
        self.assertEqual(sorted((e["drive_id"], e["w"], e["h"]) for e in rep["sizes_probed"]),
                         [("FAKE_ID_3", 6, 8), ("FAKE_ID_4", 8, 6), ("FAKE_ID_5", 1440, 1920), ("FAKE_ID_7", 720, 1280)])

    def test_unknown_size_is_left_out_and_reported(self):
        self.scan({})
        col = make_collection(self.tmp, [])
        self.build(col, "--ffprobe", self.ffprobe)  # all sizes known: the reference build
        d0 = load(os.path.join(col, "dist", "data.json"))
        ids0 = load(os.path.join(col, "state", "person_faces.json"))
        # f1 (persons A and C) has no size and no file; f5 (a video) no size and no ffprobe to read one
        self.scan({"f1": (0, 0), "f5": (0, 0)})
        r = self.build(col, "--ffprobe", os.path.join(self.tmp, "no-such-ffprobe"))
        self.assertIn("left out", r.stderr)
        d = load(os.path.join(col, "dist", "data.json"))
        self.assertEqual(sorted(f["i"] for f in d["files"]), ["FAKE_ID_2", "FAKE_ID_3", "FAKE_ID_4", "FAKE_ID_6", "FAKE_ID_7"])
        self.check_sizes(d)
        rep = load(os.path.join(col, "state", "build_report.json"))
        self.assertEqual(sorted(e["drive_id"] for e in rep["dropped"]), ["FAKE_ID_1", "FAKE_ID_5"])
        self.assertEqual(rep["sizes_probed"], [])
        # person ids do not move: the id map is the faces', not the files'
        self.assertEqual(load(os.path.join(col, "state", "person_faces.json")), ids0)
        of = lambda face: next(int(pid) for pid, fids in ids0.items() if face in fids)  # noqa: E731
        n = {p["id"]: p["n"] for p in d["people"]}
        self.assertNotIn(of("c1"), n, "C was only on the dropped photo")
        self.assertEqual(n[of("a1")], 1, "A keeps the photo that is still there")
        self.assertEqual(n[of("b1")], {p["id"]: p["n"] for p in d0["people"]}[of("b1")])
        # with the sizes back, the files come back
        self.scan({})
        self.build(col, "--ffprobe", self.ffprobe)
        self.assertEqual(load(os.path.join(col, "dist", "data.json"))["files"], d0["files"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
