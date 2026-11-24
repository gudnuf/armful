# Deploying armful

armful.photos is one Cloudflare Pages project, `armful` (direct upload,
production branch `main`). `dist/index.html` is the home page, `dist/<slug>/`
is a collection, and `functions/_middleware.js` gates every path under a
collection prefix with that collection's own secret.

The live collection is `bnf-ytt-spain-2026`; its secret is
`COLLECTION_PASSWORD_BNF_YTT_SPAIN_2026`. Opt-out requests go to
photos@armful.photos.

Every command below runs **from the repo root**: `wrangler pages deploy`
only uploads `functions/` (the gate) when it runs from the folder that holds
it. A deploy from anywhere else ships the collection ungated.

Wrangler is pinned: always `npx wrangler@4.167.0`, the version the gate tests
run under.

## What already exists (first time only, done)

These are recorded for a rebuild from scratch; they are all in place.

```bash
npx wrangler@4.167.0 login
npx wrangler@4.167.0 pages project create armful --production-branch main
```

- Custom domain: Pages, `armful`, Custom domains, Set up a domain:
  `armful.photos` (active). `www.armful.photos` 301s to the apex (a redirect
  rule on the zone).
- Email Routing: photos@armful.photos is live and forwards to the maintainer.

## Credentials

- **Deploy token.** A scoped API token (Pages edit on this account, nothing
  else) lives in your Cloudflare env file, outside the repo, holding
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Point `ARMFUL_CF_ENV`
  at it and source it with `set -a; . "$ARMFUL_CF_ENV"; set +a` (never `cat`
  it, never `echo` the token, never pass it on a command line).
- **Collection passphrase.** Lives in your local passphrase file, outside
  the repo. It never goes in git, a chat or a command argument. It must be at least 16 characters: a shorter
  secret is treated as unset and the collection answers 503.

## 1. Set the collection secret (once, and whenever the passphrase changes)

```bash
set -a; . "$ARMFUL_CF_ENV"; set +a
npx wrangler@4.167.0 pages secret put COLLECTION_PASSWORD_BNF_YTT_SPAIN_2026 --project-name armful
# paste the passphrase at the prompt; or pipe it from the passphrase file:
#   npx wrangler@4.167.0 pages secret put COLLECTION_PASSWORD_BNF_YTT_SPAIN_2026 --project-name armful < PASSPHRASE_FILE
```

Changing the passphrase logs everyone out of this one collection (the cookie
is an HMAC of it). A secret change takes effect on the next deploy.

## 2. Build

The real collection lives in `collections/bnf-ytt-spain-2026/` (git-ignored:
`collection.json`, `hidden.json`, `state/`, `local.env`, `dist/`). Its
`local.env` sets `ARMFUL_SCAN_ROOT` and `ARMFUL_FOOTAGE` for your machine.
`python` is a Python with numpy and Pillow (or `uv run --with numpy --with
pillow python3`).

```bash
. collections/bnf-ytt-spain-2026/local.env
python -I pipeline/gallery/build_site.py --collection collections/bnf-ytt-spain-2026
node bin/build-dist.mjs --collection collections/bnf-ytt-spain-2026
```

`build_site.py` writes `collections/bnf-ytt-spain-2026/dist/data.json`;
`build-dist.mjs` wipes and rebuilds `dist/` (git-ignored) from `site/`,
`home/` and that data.

Before deploying, `bin/check.sh` should print `all ok`.

## 3. Deploy

```bash
set -a; . "$ARMFUL_CF_ENV"; set +a
npx wrangler@4.167.0 pages deploy dist --project-name armful --branch main
```

From the repo root, always (see the top). `--branch main` makes it the
production deployment on armful.photos.

## 4. Check it (every deploy)

`bin/smoke.sh` runs all of these and prints one `ok` / `FAIL` line each. The
passphrase comes only from the environment, read from your local passphrase
file, never typed on the command line:

```bash
ARMFUL_PASSWORD="$(cat PASSPHRASE_FILE)" ARMFUL_EXPECT_FILES=<file count> \
  bin/smoke.sh https://armful.photos bnf-ytt-spain-2026
```

Without `ARMFUL_PASSWORD` it runs everything except the two right-password
checks. The same checks by hand:

```bash
B=https://armful.photos; S=bnf-ytt-spain-2026
curl -sI "$B/" | grep -iE '^HTTP|^x-robots-tag'                 # 200, and NO X-Robots-Tag line
curl -sI "$B/$S" | grep -iE '^HTTP|^location'                   # 301, Location: /bnf-ytt-spain-2026/
curl -sI "$B/$S/" | grep -iE '^HTTP|^x-robots-tag'              # 401 (the door), X-Robots-Tag: noindex, ...
curl -s -o /dev/null -w '%{http_code}\n' "$B/$S/data.json"      # 401
curl -s "$B/$S/data.json" | head -c 15; echo                    # <!doctype html> (the door), not JSON
curl -s --path-as-is -o /dev/null -w '%{http_code}\n' "$B/$S%2Fdata.json"   # not 200 (400)
curl -s --path-as-is -o /dev/null -w '%{http_code}\n' "$B//$S/data.json"    # not 200 (400)
curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-urlencode p=wrong-guess --data-urlencode to= "$B/$S/__gate"   # 401
# right passphrase: from stdin, so it is never in argv or shell history
printf '%s' "$ARMFUL_PASSWORD" | curl -s -o /dev/null -w '%{http_code}\n' -c /tmp/armful.jar \
  -X POST --data-urlencode 'p@-' --data-urlencode to= "$B/$S/__gate"   # 303, cookie armful_bnf-ytt-spain-2026 set
curl -s -b /tmp/armful.jar "$B/$S/data.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).files.length))'   # the file count
rm -f /tmp/armful.jar
```

## 5. Dashboard settings (must be set; the security review's list)

Check each of these once after setup and after any project change:

1. **Fail closed when Functions run out.** Pages, `armful`, Settings,
   Functions (Runtime): set the behaviour when the daily Functions quota is
   exhausted to **Fail closed**. On the default (fail open) Cloudflare serves
   static assets without running the middleware, and the collection's
   `data.json` goes out ungated.
2. **No `_routes.json` excludes** for a collection prefix, ever. The build
   writes none; the middleware must run on every path under `/<slug>/`.
3. **Rate-limit the door.** Security, WAF, Rate limiting rules: requests
   with method `POST` and URI path ending in `/__gate`, about 10 per minute
   per IP, action Block (10 minutes).
4. **pages.dev to the apex.** A Bulk Redirect from `armful.pages.dev` to
   `https://armful.photos` (preserve path and query). Preview hosts
   (`*.armful.pages.dev`) already send `X-Robots-Tag: noindex` via `_headers`.

## The opt-out loop

Someone writes to photos@armful.photos asking to be taken off the page:

1. Find their person id: open the collection, tap their face, read the id
   from the URL hash (`#p=<id>`).
2. Add it to `collections/bnf-ytt-spain-2026/hidden.json` (git-ignored; a
   JSON list of integers, e.g. `[17, 203]`).
3. Rebuild with the saved id map in place (`build_site.py` refuses to build
   a collection that hides anyone when `state/person_faces.json` is missing,
   because renumbered ids would hide the wrong people):
   ```bash
   . collections/bnf-ytt-spain-2026/local.env
   python -I pipeline/gallery/build_site.py --collection collections/bnf-ytt-spain-2026
   node bin/build-dist.mjs --collection collections/bnf-ytt-spain-2026
   ```
4. Deploy (step 3) and run `bin/smoke.sh` (step 4). The file count stays
   the same: hiding a person removes their face, not the photos, which
   remain in the shared Drive folder.
5. Confirm their face is gone (`#p=<id>` now loads the full wall), then
   reply to them.

## Phone pass (iPhone Safari, after a deploy that changes the page)

- [ ] armful.photos/bnf-ytt-spain-2026: the door shows (photo, wordmark,
      field), nothing else.
- [ ] Passphrase: a wrong one shakes the field; the right one opens the wall.
- [ ] Rail: the people pill opens the list upward; it scrolls; `+N more`
      opens the rest; tap outside closes it; the pill does not move.
- [ ] Hold two people: the wall narrows to the photos they share; the pair
      overlaps ("together").
- [ ] Tap the pair: it separates ("any"), the wall widens; tap again to go
      back to together.
- [ ] Previewer: tap a photo, swipe left and right, the counter follows;
      the phone's Back closes the previewer (not the page) and the hold is
      still there.
