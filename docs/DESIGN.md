# armful: design note

## What it is

Armfuls of photos, finally findable. A group event (a trip, a training, a
weekend) leaves hundreds or thousands of photos and videos in one shared
folder, and nobody can find the ones they are in. armful turns that folder
into one quiet page you can search by face.

- **Now:** face search. The pipeline finds the faces, groups them into
  people (no names), and the page shows every file on a wall with a list of
  faces beside it. Tap a face to see only the files that person is in.
- **Later:** filters by group size (just me, two of us, the whole group),
  by day and time, photos with no people in them, and by media and shape
  (videos, portraits, panoramas).
- **Later still:** natural-language search over the same index ("the two of
  us at the beach in the evening").

## The look: Veil

No colour. Ink on paper, a white veil over the photos, one spring.

| token | light | dark |
|-------|-------|------|
| `--ink` | `#16231F` | (fixed) |
| `--paper` | `#FBFAF7` | (fixed) |
| `--cream` | `#F2EFE8` | (fixed) |
| `--body` | `#4A5754` | (fixed) |
| `--stone` | `#6B7975` | (fixed) |
| `--ground` | `#FBFAF7` | `#0D0F0E` |
| `--text` | `#16231F` | `#F2EFE8` |
| `--dim` | `#4A5754` | `rgba(242, 239, 232, .68)` |
| `--ring` | `#16231F` | `#FBFAF7` |
| `--line` | `rgba(22, 35, 31, .12)` | `rgba(242, 239, 232, .14)` |
| `--veil` | `rgba(255, 255, 255, .75)`, blur 20px | `rgba(13, 15, 14, .72)` |

The five named colours never change; ground, text, dim, ring, line and veil
follow the device's colour scheme.

**Type.** Self-hosted woff2 only (OFL 1.1, `site/fonts/`): no request goes
to a font host. Inter 400/500/600 for everything at 16/24. Bricolage
Grotesque 700 only for the wordmark and the one title (32/40,
letter-spacing -0.03em). Counts use tabular numerals.

**Motion.**

- `--spring`: 420ms, `linear(0, 0.1895, 0.3445, 0.4713, 0.5751, 0.66,
  0.7295, 0.7863, 0.8328, 0.8708, 0.902, 0.9274, 0.9483, 0.9653, 0.9793,
  0.9907, 1)` where supported, else `cubic-bezier(.2, .8, .2, 1)`. Anything
  that moves.
- `--fade`: 250ms `cubic-bezier(.2, 0, 0, 1)`. Opacity only.
- `--press`: scale .94 over 120ms, a tapped face.

Faces are 44px (36px from 1000px wide); the wall gutter is 2px.

## The page

- **The wall.** One tile per file, in justified rows (two across on a phone,
  four or five on wide screens). Every box is reserved from the stored
  aspect ratio before any image arrives; images fade in in a wave and load
  one viewport ahead at the size they are shown. A failed tile keeps its box
  and retries in place. A short last row stays ragged, never stretched.
- **The panel (desktop) / the rail (phone).** A floating panel top-left on
  wide screens; on a phone a pill bottom-left that opens upward. Collapsed on
  arrival; faces load only when the list opens; Esc or a tap outside folds
  it. Beyond the main list, `+N more` opens the rest.
- **The hold.** Tap a face to hold it. With two or more held the wall shows
  either the files with all of them (**together**, the faces overlap) or with
  any of them (**any**, the faces separate); tap the pair to switch. Every
  count in the list is the count you would get if you tapped that face next
  (count-if-tapped), so the list always tells you where a tap leads. The URL
  keeps the hold: `#p=3.7` or `#p=3.7&any`.
- **The previewer.** A tap on a tile opens it large and steps through exactly
  what the wall shows, in wall order, with the held faces and the mode word
  at the bottom. Back closes the previewer, not the page.

## Routes

- `/` is the public home page (indexable): what armful is, and the recent
  collections this browser has opened (kept in `localStorage`, never sent).
- `/<slug>/` is a collection, behind its own password door. A slug is
  lowercase `[a-z0-9-]`, at least 6 characters (e.g. `/example/`).
  `/<slug>` redirects to `/<slug>/`.
- Reserved first segments, never slugs: `app`, `api`, `a`, `c`, `about`,
  `login`, `new`, `open`, `static`, `_`. Shared assets live under `/static/`.

## Privacy model

- **No photo bytes are hosted.** The photos stay in the shared Drive folder;
  the page loads Drive's own thumbnails. Hiding a person removes their face
  from the page, not the photos.
- **`data.json` is gated.** Each collection has its own secret
  (`COLLECTION_PASSWORD_<SLUG>`, a Pages secret, at least 16 characters).
  Without it the collection answers 503. The cookie is an HMAC of the
  password scoped to `/<slug>`, so a password change logs everyone out of
  that one collection, and a cookie for one collection never opens another.
  Everything under a collection is `noindex`.
- **Nothing real in git.** No photos, faces, Drive ids, built page data,
  per-collection config or passwords; every test runs on a synthetic
  fixture. `bin/check-no-private.sh` enforces this on the index and, before
  any push to a public remote, on the full history
  (`--history --all`), including keyed strings kept in a pattern file that
  is never committed.
- **Opt-out.** Anyone can write to photos@armful.photos to be taken off a
  page; their person id goes on the collection's hidden list and the page is
  rebuilt.

## Running your own collection

1. Share a Drive folder of the event's photos and videos.
2. Copy `collections/example/` to `collections/<your-slug>/` (git-ignored)
   and fill in the folder id, a door photo and the title.
3. Download and scan the folder locally (CPU, no model APIs), then build the
   page data: see `pipeline/README.md`.
4. `node bin/build-dist.mjs --collection collections/<your-slug>` builds
   `dist/`; `bin/check.sh` must print `all ok`.
5. Create a Cloudflare Pages project, set `COLLECTION_PASSWORD_<SLUG>` as a
   secret, deploy `dist/` from the repo root and run `bin/smoke.sh`: see
   `DEPLOY.md`.
