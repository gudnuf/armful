"""Where one collection's files live, shared by build_site.py and the verify scripts.

A collection is a folder `collections/<slug>/` holding collection.json, an optional
hidden.json, state/ (stable person ids, reports) and, by default, dist/data.json.
Pass it as --collection DIR or set ARMFUL_COLLECTION. All of it is git-ignored
except collections/example/.

Everything these scripts write is private (page data, person ids, reports), so a
destination inside this checkout is refused unless git ignores it; destinations
outside the checkout are fine. Paths are checked after following symlinks.
"""
import argparse
import json
import os
import subprocess
import sys

REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def add_args(ap):
    ap.add_argument(
        "--collection",
        default=os.environ.get("ARMFUL_COLLECTION"),
        help="the collections/<slug>/ folder (default: $ARMFUL_COLLECTION)",
    )


def parser(doc):
    ap = argparse.ArgumentParser(description=(doc or "").split("\n\n")[0])
    add_args(ap)
    return ap


def resolve(args):
    """Check --collection and return (dir, config dict from collection.json). Writes nothing."""
    if not args.collection:
        sys.exit("no collection: pass --collection collections/<slug> or set ARMFUL_COLLECTION")
    d = os.path.abspath(os.path.expanduser(args.collection))
    cj = os.path.join(d, "collection.json")
    if not os.path.isfile(cj):
        sys.exit(f"no collection.json in {d}")
    try:
        with open(cj, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"{cj}: cannot read it ({e})")
    if not isinstance(cfg, dict) or not all(isinstance(cfg.get(k), str) and cfg[k] for k in ("slug", "title")):
        sys.exit(f"{cj}: needs a JSON object with non-empty \"slug\" and \"title\"")
    return d, cfg


def check_private_dest(path):
    """Exit unless writing the private file `path` is safe: outside this checkout, or git-ignored.

    `path` may not exist yet; its real location is the real path of its nearest existing
    parent plus the rest, so a symlinked folder (or file) pointing into the checkout is caught."""
    real = os.path.realpath(path)
    if os.path.commonpath([real, REPO]) != REPO:
        return real
    if not os.path.exists(os.path.join(REPO, ".git")):
        return real  # not a git checkout (an unpacked copy): nothing here can be committed
    rel = os.path.relpath(real, REPO)
    r = subprocess.run(["git", "-C", REPO, "check-ignore", "-q", "--", rel], capture_output=True)
    if r.returncode != 0:  # 1 = not ignored, 128 = git error: refuse both
        sys.exit(f"refusing to write {real}: it is inside the git checkout {REPO} and git does not ignore it")
    return real


def state_dir(col, check=True, make=True):
    """<collection>/state/, checked (its files must not land in tracked source) and created."""
    s = os.path.join(col, "state")
    if check:
        check_private_dest(os.path.join(s, "person_faces.json"))
    if make:
        os.makedirs(s, exist_ok=True)
    return s


def data_json(col, data=None):
    """The built page data: --data FILE, else <collection>/dist/data.json."""
    return os.path.abspath(os.path.expanduser(data)) if data else os.path.join(col, "dist", "data.json")


def write_atomic(path, text):
    """Write text beside the target, then rename it into place: readers see old or new, never half."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
