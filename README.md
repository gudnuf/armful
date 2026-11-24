# armful

A shared photo collection you can search by face. Point it at a Google Drive
folder of photos and videos from an event; it finds the faces, groups them
into people, and builds one quiet page: a wall of every photo, and a rail of
faces. Tap a face to see only the photos that person is in; tap two to see
the photos they are in together. No names, no accounts, no uploads: the
photos stay in Drive and the page loads Drive's own thumbnails.

armful is open source and this repository holds **no real data**: no photos,
no faces, no Drive ids, no built page data, no passwords. Every test runs on
a synthetic fixture.

## Layout

```
site/          the page: index.html, app.js, style.css
functions/     _middleware.js, the password gate (Cloudflare Pages Functions)
pipeline/scan/     find and embed faces in a local copy of the folder, cluster them
pipeline/gallery/  merge clusters into people, build data.json, verify it
collections/   one folder per collection; only example/ is committed
bin/           repo tools: privacy guard, hook installer, fixture generator
test/          tests (run on the synthetic fixture)
docs/          DESIGN.md, the design note
```

## A collection

A collection is one folder under `collections/<slug>/`. Everything in it
except `collections/example/` is git-ignored, because it names a private
Drive folder. The shape:

```json
{
  "slug": "example",
  "title": "example",
  "drive_folder": "DRIVE_FOLDER_ID",
  "door_photo": "DRIVE_FILE_ID",
  "door_position": "center 30%",
  "hidden": []
}
```

- `slug`: the URL path the collection is served at.
- `title`: the one title on the page.
- `drive_folder`: the id of the shared Drive folder holding the photos.
- `door_photo`, `door_position`: the Drive file shown behind the password
  door, and its CSS `object-position`.
- `hidden`: person ids that never appear on the page (people who asked).

The pipeline also writes `hidden.json`, `state/` and the built `data.json`
next to it; none of those are committed.

## Running the pipeline on your own folder

The pipeline is Python and runs locally on CPU. It needs two paths, with
no defaults: `ARMFUL_SCAN_ROOT` (where the scan output goes) and
`ARMFUL_FOOTAGE` (your local copy of the photos and videos). Setup and every step are
documented in `pipeline/README.md`. In short:

1. Copy `collections/example/` to `collections/<your-slug>/` and fill in your
   Drive folder id.
2. Download the folder and scan it for faces (`pipeline/scan/`).
3. Build the page data (`pipeline/gallery/build_site.py`), then check it with
   the verify scripts.
4. Deploy `dist/` to Cloudflare Pages with a password set as a Pages secret
   (see `DEPLOY.md`). The password lives only in the Pages project, never in
   a file.

## Checks

One command runs every suite on the synthetic fixture:

```bash
bin/check.sh
```

It prints one `ok <suite>` or `FAIL <suite>` line per suite (a failure shows
the tail of that suite's log), runs every suite even after a failure, and
exits non-zero if any failed. The suites: the guard's own tests, the
fixture, `build_site`, the dist build, the gate (under `wrangler pages dev`,
pinned `wrangler@4.167.0` via `npx`), the page suites in headless Chrome
(tokens, wall, panel, hold, previewer, a11y; a suite whose file does not
exist yet is skipped), and the privacy guard on the index and on every
commit reachable from `HEAD`.

- `test/build_site.test.py` needs numpy and Pillow. Point `ARMFUL_PY` at a
  Python that has them, e.g.
  `ARMFUL_PY="uv run --with numpy --with pillow python3" bin/check.sh`.
- The Chrome suites run one after another. Set `ARMFUL_CHROME_LOCK` to a
  lockfile path to serialise headless Chrome on a shared machine:
  `check.sh` then wraps the Chrome suites in `lockf` / `flock` on it. Unset,
  there is no lock and they run directly. `CHROME` overrides the Chrome
  binary.

`node bin/shoot.mjs` writes the screenshot set to
`shots/` (git-ignored): `door`, `arrive`, `one`, `together`, `any`,
`previewer`, `home` at 375, 390, 768 and 1440 px, light and dark, all from
the fixture. `--only door,home` limits the screens, `--out DIR` moves them.

After a deploy, `bin/smoke.sh <base-url> <slug>` checks the live site (see
`DEPLOY.md`).

The pieces, one at a time:

```bash
bash test/guard.test.sh             # the privacy guard's own tests
node --test test/fixture.test.mjs   # the synthetic fixture
bin/check-no-private.sh             # the guard on the index (what the next commit carries)
bin/check-no-private.sh --history --all   # the guard on every commit: the gate before any push
bin/install-hooks.sh                # optional: run the guard locally on every push
```

`bin/check-no-private.sh` fails if git tracks or stages page data, hidden
lists, scan output, photos or video of any type the pipeline reads (any
case), collection config other than the example, wrangler secrets or state,
face crops, screenshots or local state; any binary file except the fonts in
`site/fonts/*.woff2` (woff2 bytes) and the home page's generated link-preview
card and touch icon in `home/og/*.png` (PNG bytes, made by `bin/make-og.mjs`);
Git LFS pointers, symlinks or submodules; or a
password variable (`GALLERY_PASSWORD`, `COLLECTION_PASSWORD_*`) set to a real
value in any syntax (empty values, placeholders such as `change-me` and env
reads pass). It also checks for keyed private strings in file contents, path names and
commit messages: put one ERE per line in `.git/armful-private-patterns` (or
point `ARMFUL_PRIVATE_PATTERNS` at a file outside the repo); the file is
never committed; without that file it warns and checks the rest, and a
pattern list grep cannot parse stops it (exit 2). Exit codes: 0 clean, 1
private content found, 2 the guard could not run.

**The gate is the full-history scan, not the hook.** Before anything is
pushed to a public remote, run `bin/check-no-private.sh --history --all`
(every commit, including ones later removed from the tree) and push only if
it exits 0. The pre-push hook from `bin/install-hooks.sh` runs the same
checks on the index and the outgoing commits, but it is a local, optional
convenience: a fresh clone does not have it, `git push --no-verify` skips
it, and it runs whatever guard is in your working tree. The installer never
overwrites a different existing pre-push hook; it tells you how to chain it.

`python3 -I bin/make-fixture.py OUT_DIR` writes the synthetic collection the
page tests use: 60 placeholder files, 12 placeholder people, local SVGs
instead of Drive thumbnails.

## Licence

MIT, see `LICENSE`.
