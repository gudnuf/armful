# pipeline

Turns a local copy of a Drive folder into one collection's `data.json`. Python,
local, CPU only; no model APIs. Nothing it reads or writes is committed: scan
output, photos, face crops, `state/` and `data.json` are all git-ignored, and
`bin/check-no-private.sh` refuses them.

## Paths

Three locations, all set per machine. There are no defaults: a script that
needs one and finds it unset stops with a message naming it.

| variable | what it is |
|----------|------------|
| `ARMFUL_FOOTAGE` | your local copy of the folder: `drive/` (the files), `listing.tsv`, `manifest.tsv`, `work/` (converted DNG) |
| `ARMFUL_SCAN_ROOT` | where the scan writes: `data/` (faces.tsv, emb.npy, photos.tsv, clusters.tsv, centroids.npy) and `crops/` (face crops for review) |
| `ARMFUL_COLLECTION` | the `collections/<slug>/` folder (or pass `--collection DIR` to the gallery scripts) |

Keep the real values in a git-ignored file inside the collection folder, for
example `collections/<slug>/local.env`:

```bash
export ARMFUL_FOOTAGE="/path/to/your/footage"
export ARMFUL_SCAN_ROOT="/path/to/your/scan"
export ARMFUL_COLLECTION="/path/to/armful/collections/<slug>"
```

and `source` it in the shell you run the pipeline from.

## The collection folder

```
collections/<slug>/
  collection.json   slug, title, drive_folder, door_photo, door_position, hidden, tz
  hidden.json       optional: person ids never shown (joined with collection.json "hidden")
  merges.json       optional: {"<dup id>": <canonical id>, ...} people the scan split in two
  faces.json        optional: {"<canonical id>": <source id>, ...} which face a merged person shows
  state/            person_faces.json (stable person ids), reps.json, reports
  dist/data.json    the built page data (default output)
```

`tz` (optional) is the IANA time zone the event happened in, for example
`"Asia/Tokyo"` (the example collection says `"UTC"`). It is copied into
`data.json` so the page can group files by local day, and it is the zone a
camera clock without an offset is read in (see capture times below). An
unknown zone stops the build before anything is written.

`merges.json` folds a person the scan split into several clusters back into
one: each duplicate id's files join the canonical id's (the canonical keeps its
face; counts are recomputed). Both ids must be clear people (see below), no id
may be both merged away and merged into, and a bad file stops the build before
anything is written. Hiding either id hides the merged person. Person ids
themselves never change: the duplicate keeps its id in `person_faces.json`, it
just never reaches the page.

`faces.json` picks the face a merged person shows: `{"<canonical id>": <source
id>}` gives the canonical the representative face the source had before the
merge (the source is the canonical itself or one of the ids merged into it).
The canonical must still be a person after merges, the source a person before
them; anything else stops the build before anything is written. Both files
are git-ignored and the guard refuses them.

`state/person_faces.json` is what keeps person ids stable across rebuilds,
and hidden ids refer to it: keep it with the collection, and never rebuild a
collection without it, or every id (and so every hidden id) changes.
`build_site.py` refuses to build a collection that hides anyone when that
file is missing; `--fresh-ids` overrides it, after which the hidden list must
be redone against the new ids. `local.env` is git-ignored anywhere (even in
`collections/example/`) and the guard refuses it.

## Steps

`python` below is a Python with numpy, Pillow, opencv and, for the scan,
insightface + onnxruntime (and pillow-heif for HEIC).

```bash
# 1. list and download the Drive folder (stdlib only)
python -I pipeline/scan/list_drive.py DRIVE_FOLDER_ID "$ARMFUL_FOOTAGE/listing.tsv"
python -I pipeline/scan/download.py "$ARMFUL_FOOTAGE/listing.tsv" "$ARMFUL_FOOTAGE/drive" "$ARMFUL_FOOTAGE/manifest.tsv"

# 2. find, embed and cluster faces (CPU; resumable)
python -I pipeline/scan/scan.py --videos
python -I pipeline/scan/cluster.py

# 3. build the page data: writes collections/<slug>/dist/data.json
python -I pipeline/gallery/build_site.py --collection collections/<slug> [--out DIR] [--merge 0.50] [--ffprobe PATH] [--keep-uncertain]

# 4. check it (network: fetches Drive thumbnails in memory, saves nothing)
python -I pipeline/gallery/verify_thumbs.py --collection collections/<slug>
python -I pipeline/gallery/verify_faces.py --collection collections/<slug>
```

Adding a few files to a collection whose people are already reviewed:

- `download.py` skips videos over 500 MB and lists them in `skipped.tsv`.
  `--big ID[,ID]` fetches just those ids anyway; the cap stays for the rest.
  Big files play the same as the others: the page streams video through
  Drive's own player (`/file/d/ID/preview`), not the download URL.
- `scan.py` only scans files it has no cache for.
- `cluster.py --attach` keeps every face already in `clusters.tsv` where it
  is and keeps `centroids.npy` unchanged. A new face joins its nearest
  existing cluster by the weak-face rule, or stays unclustered. A full
  `cluster.py` run lets the new faces nudge the old clusters, so a file
  already on the wall can gain or lose a person. `--attach` never changes
  an old file.
- Files deleted from the folder: move their originals out of `drive/` and
  their rows out of `manifest.tsv` (keep a copy), rerun `scan.py`, then
  `cluster.py --attach --forget-gone`, which drops their faces from
  `clusters.tsv` and leaves every other face and the centroids as they are.
  Person ids stay (the id map keeps them).

On a metered connection, new files can come in from previews instead of
originals:

```bash
python -I pipeline/scan/preview.py LISTING.tsv NEW_IDS.txt --ffprobe PATH   # Pillow; writes $ARMFUL_FOOTAGE/preview/
```

For each id it fetches Drive's thumbnail (the page's own `sz=w1600` URL) and
only the start of the original by HTTP Range (refused unless the answer is
206 with the asked-for length): a photo's first 128 KB (EXIF time and
orientation, and the frame header's true size), a video's top-level atoms
except `mdat` (its `moov`, found by walking the atom sizes, so a video body
is never fetched). `preview/preview.tsv` lists them and `preview/bytes.tsv`
every response's size. They are not originals and never go into
`manifest.tsv`. `scan.py` detects faces on the thumbnail (a video's on its
poster frame) with boxes scaled to the file's true size, and `build_site.py`
reads time, orientation and size from the saved head. A file with no head
gets the thumbnail's aspect ratio and no time. Later, download the originals
into `drive/` under the same names: `scan.py` then scans them afresh and
ignores their previews (the preview faces leave `faces.tsv`, so recluster:
`--attach --forget-gone` puts the new faces on existing people).

Everything the gallery scripts write is private, so a destination inside
this checkout (after following symlinks) is refused unless git ignores it:
`--out dist/<slug>` is fine, `--out pipeline/gallery` is not. Destinations
outside the checkout are fine. `build_site.py` checks all its inputs (including
`hidden.json`, which must be a JSON list of integer ids) and destinations before
writing anything, then writes `data.json`, then the id map, each atomically.

`data.json` holds the collection's `slug` and `title`, a `built` date, `tz`
(when collection.json has one), `files` and `people` (id, photo and video
counts, the representative face box). `people` holds clear people only: someone on fewer
than three photos, with fewer than two good faces, or without one clear,
upright face to show is "uncertain" and is left out entirely (not listed, and
their id is on no file), so every count on the page is of clear people. Their
faces still count in `nf`, and their ids stay in `person_faces.json`.
`--keep-uncertain` keeps them in, marked `x: 1`, for debugging (the page
ignores them). No embeddings, file names, names or
bursts: every file is its own tile. Each entry of `files`:

| key | what it is |
|-----|------------|
| `i` | Drive file id |
| `w`, `h` | width and height |
| `p` | ids of the people on it (hidden people never appear) |
| `v` | `1` for a video |
| `t` | capture time, whole unix seconds (UTC); left out when unknown |
| `nf` | faces the scan detected on it: every face, also people nobody named and hidden people (they count, their ids never show); a video counts the most faces in one sampled frame, or its people if that is more |

`files` is ordered by `t`, oldest first; files without `t` come last, in scan
order (photos, then videos). People's ids never depend on this order (they
come from `state/person_faces.json`); `people[].rep.f` indexes the ordered list.

Capture times (`capture_time.py`):

- Photos: EXIF `DateTimeOriginal`. With `OffsetTimeOriginal` the time is
  exact. Without it (many cameras, older phones) the clock is **assumed to be
  local time in the collection's `tz`** (UTC when there is none): a camera
  set to another zone, or never set, gives times off by that much.
- Videos: the container's `creation_time` from
  `ffprobe -v quiet -print_format json -show_format` (QuickTime/MP4 store it in
  UTC). `--ffprobe PATH` names the binary; without one on `PATH` videos get no
  time and the build says so.
- No usable time (no EXIF date, a blank `0000:00:00` clock, a date before 2000):
  no `t`. The file's modification time is never used: a download resets it.

`verify_thumbs.py` checks every wall thumbnail and every face thumbnail loads
and matches the stored aspect ratio; `verify_faces.py` checks a face sits at
the centre of each Google-side face crop. Both write their report to
`<collection>/state/`.

## Tests

```bash
python3 -I test/build_site.test.py   # needs numpy + Pillow; synthetic data in a temp dir
```

The page itself is tested in headless Chrome by the suites in `test/` and
screenshotted by `bin/shoot.mjs`, all on the synthetic fixture (see the
top-level README); there are no browser helpers in `pipeline/`.
