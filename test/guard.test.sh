#!/usr/bin/env bash
# Guard test: bin/check-no-private.sh must fail closed on private paths,
# password values and keyed strings (in the index and in outgoing history),
# and pass a clean tree. Hermetic: never reads the real patterns file.
# GUARD_SRC=path overrides the guard under test (used to show RED on an old version).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD_SRC="${GUARD_SRC:-$ROOT/bin/check-no-private.sh}"
T="$(mktemp -d)"
trap 'command rm -rf "$T"' EXIT
fails=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }

R="$T/repo"
mkdir -p "$R/bin" "$R/site"
cp "$GUARD_SRC" "$R/bin/check-no-private.sh" 2>/dev/null || { echo "FAIL - bin/check-no-private.sh missing"; exit 1; }
chmod +x "$R/bin/check-no-private.sh" # the hook execs it
cp "$ROOT/bin/install-hooks.sh" "$R/bin/" 2>/dev/null
cp "$ROOT/.gitignore" "$R/"
cd "$R" || exit 1
git init -q -b main
git config user.email t@example.com; git config user.name t; git config commit.gpgsign false

# a patterns file with a made-up keyed string, so the real one is never read
PAT="$T/patterns"
printf 'SECRETKEY123\n' > "$PAT"
export ARMFUL_PRIVATE_PATTERNS="$PAT"

# expect CODE NAME [guard args...]; CODE "nz" = any non-zero
expect() {
  local want="$1" name="$2"; shift 2
  out="$(bash bin/check-no-private.sh "$@" 2>&1)"; rc=$?
  if [ "$want" = nz ] && [ "$rc" != 0 ]; then ok "$name"
  elif [ "$rc" = "$want" ]; then ok "$name"
  else bad "$name (exit $rc, want $want): $out"; fi
}
reset() { git read-tree --empty || bad "reset: read-tree failed"; git clean -fdxq -e bin -e .gitignore; git add -f bin .gitignore; mkdir -p site; }
settle() { git reset -q --hard; git clean -fdxq -e bin -e .gitignore; } # before switching branches
stage() { mkdir -p "$(dirname "$1")"; printf '%s\n' "${2:-x}" > "$1"; git add -f -- "$1"; }

git add -f bin .gitignore
stage site/data.json '{}'
expect 1 "path rule: staged site/data.json -> exit 1"

reset; stage site/app.js
expect 0 "clean tree -> exit 0"

reset; stage collections/example/collection.json '{}'
expect 0 "collections/example/ is allowed -> exit 0"
stage collections/real/collection.json '{}'
expect 1 "collections/real/ -> exit 1"
reset; stage collections/example/local.env 'x'; expect 1 "collections/example/local.env -> exit 1"

reset; stage site/app.js 'const id = "SECRETKEY123";'
expect 1 "keyed hit from ARMFUL_PRIVATE_PATTERNS -> exit 1"

v="hunter2"
reset; stage site/env.txt "$(printf '%s_PASSWORD=%s' GALLERY "$v")"
expect 1 "GALLERY_PASSWORD with a value -> exit 1"
reset; stage site/env.txt "$(printf 'COLLECTION_%s=%s' PASSWORD_EXAMPLE "$v")"
expect 1 "COLLECTION_PASSWORD_* with a value -> exit 1"
reset; stage site/env.txt "$(printf 'GALLERY_PASSWORD=<value>\nconst s = env.GALLERY_PASSWORD;')"
expect 0 "password placeholder / env read -> exit 0"
# other assignment shapes (names split so this file never holds a literal assignment)
reset; stage site/a.sh "$(printf '%s_PASSWORD = "demo-only"' GALLERY)"
expect 1 "spaced assignment with a quoted value -> exit 1"
reset; stage site/a.json "$(printf '{"COLLECTION_%s": "demo-only"}' PASSWORD_EXAMPLE)"
expect 1 "JSON key with a value -> exit 1"
reset; stage site/a.yml "$(printf 'COLLECTION_%s: demo\n' PASSWORD_X)"
expect 1 "YAML key with an unquoted value -> exit 1"
reset; stage site/a.env "$(printf 'export %s_PASSWORD=%s\n' GALLERY "$v")"
expect 1 "shell export with a value -> exit 1"
reset; stage site/ok.txt "$(printf '%s_PASSWORD=\n%s_PASSWORD="change-me"\n%s_PASSWORD = process.env.%s_PASSWORD\nif (env.%s_PASSWORD === x) {}\n{"COLLECTION_%s": ""}\nCOLLECTION_%s: <value>\n' GALLERY GALLERY GALLERY GALLERY GALLERY PASSWORD_EXAMPLE PASSWORD_X)"
expect 0 "empty values, change-me, env reads, comparisons, placeholders -> exit 0"

reset; stage site/app.js
out="$(ARMFUL_PRIVATE_PATTERNS="$T/nope" bash bin/check-no-private.sh 2>&1)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -qi warn; then ok "missing patterns file -> warning, exit 0"; else bad "missing patterns file (exit $rc): $out"; fi

# the default location: .git/armful-private-patterns when ARMFUL_PRIVATE_PATTERNS is unset
reset; stage site/app.js 'const id = "SECRETKEY123";'
cp "$PAT" "$(git rev-parse --git-common-dir)/armful-private-patterns"
out="$(env -u ARMFUL_PRIVATE_PATTERNS bash bin/check-no-private.sh 2>&1)"; rc=$?
if [ "$rc" = 1 ]; then ok "default patterns at .git/armful-private-patterns -> exit 1"; else bad "default patterns location (exit $rc, want 1): $out"; fi
command rm -f "$(git rev-parse --git-common-dir)/armful-private-patterns"

# media types the pipeline reads, any case; private dirs at any depth
for p in pipeline/scan/IMG_1.dng site/a.webp x/b.HEIF c.TIFF d.m4v e.Mkv; do
  reset; stage "$p"; expect 1 "media type: $p -> exit 1"
done
for p in pipeline/scan/crops/f.txt site/state/s.txt deep/shots/a.txt functions/.wrangler/x pipeline/x/data.json a/.dev.vars; do
  reset; stage "$p"; expect 1 "private path at depth: $p -> exit 1"
done

# non-ASCII names: never C-quoted past the rules
reset; stage "site/Señora.JPG"
expect 1 "non-ASCII photo name Señora.JPG -> exit 1"
reset; stage "site/café.js" 'const id = "SECRETKEY123";'
expect 1 "non-ASCII file café.js with a keyed string -> exit 1"
reset; stage "site/café.js" 'clean'
expect 0 "non-ASCII clean file -> exit 0"

# an invalid patterns file fails closed
reset; stage site/app.js
printf 'ok\n[unclosed\n' > "$T/badpat"
out="$(ARMFUL_PRIVATE_PATTERNS="$T/badpat" bash bin/check-no-private.sh 2>&1)"; rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q 'invalid pattern list'; then ok "invalid patterns file -> exit 2 (fail closed)"; else bad "invalid patterns file (exit $rc, want 2): $out"; fi
mkdir -p "$T/patdir"
out="$(ARMFUL_PRIVATE_PATTERNS="$T/patdir" bash bin/check-no-private.sh 2>&1)"; rc=$?
if [ "$rc" = 2 ]; then ok "patterns path is a directory -> exit 2"; else bad "patterns path is a directory (exit $rc, want 2): $out"; fi

# history: a file committed then removed from the index is still in what is pushed
reset; git commit -qm base
stage site/data.json '{}'; git commit -qm leak
git rm -q --cached site/data.json; command rm -f site/data.json; git commit -qm unleak
stage site/app.js 'const id = "SECRETKEY123";'; git commit -qm keyed
git rm -q --cached site/app.js; command rm -f site/app.js; git commit -qm unkeyed
expect 0 "index check alone misses the removed files -> exit 0"
expect 1 "--history over all commits finds them -> exit 1" --history HEAD
expect 0 "--history over the clean commit only -> exit 0" --history -1 HEAD~4
Z=0000000000000000000000000000000000000000
expect 1 "--pre-push, new branch (remote sha zero) -> exit 1" --pre-push <<< "refs/heads/main $(git rev-parse HEAD) refs/heads/main $Z"
expect 0 "--pre-push, branch deletion -> exit 0" --pre-push <<< "(delete) $Z refs/heads/main $(git rev-parse HEAD)"

# the installed hook blocks a real push
git init -q --bare "$T/remote.git"; git remote add origin "$T/remote.git"
bash bin/install-hooks.sh >/dev/null
pout="$(git push origin main 2>&1)"; prc=$?
if [ "$prc" != 0 ] && printf '%s' "$pout" | grep -q 'private: .*site/data.json'; then ok "pre-push hook blocks pushing the leaking history (and names data.json)"
else bad "pre-push hook did not block for the right reason (exit $prc): $pout"; fi
if [ -z "$(git ls-remote "$T/remote.git" 2>/dev/null)" ]; then ok "remote received nothing"; else bad "remote received refs"; fi
# a clean branch from the clean base pushes, and a later clean commit only checks the new range
git checkout -q -b clean HEAD~4
if git push -q origin clean >/dev/null 2>&1; then ok "pre-push hook lets a clean branch through"; else bad "clean branch push blocked"; fi
stage site/ok.js; git commit -qm more
expect 0 "--pre-push on remote..local range of a clean commit -> exit 0" --pre-push <<< "refs/heads/clean $(git rev-parse HEAD) refs/heads/clean $(git rev-parse HEAD~1)"

# a merge commit that itself adds a file (an "evil merge") is checked too
git checkout -q -b side clean
stage site/side.js; git commit -qm side
git checkout -q clean
stage site/main.js; git commit -qm main
base="$(git rev-parse HEAD)"
git merge -q --no-ff --no-commit side >/dev/null 2>&1
stage site/data.json '{}'
git commit -qm "merge side"
git rm -q --cached site/data.json; command rm -f site/data.json; git commit -qm "drop data"
expect 1 "--history sees what a merge commit adds -> exit 1" --history HEAD~2..HEAD
git checkout -q -b mergeclean "$base"
git merge -q --no-ff -m "clean merge" side >/dev/null 2>&1
expect 0 "--history over a clean merge commit -> exit 0" --history -1 HEAD

# index mode reads the staged blob, not the working-tree file
reset; stage site/app.js 'const id = "SECRETKEY123";'; printf 'clean\n' > site/app.js
expect 1 "staged keyed blob, clean working file -> exit 1"
reset; stage site/app.js 'clean'; printf 'const id = "SECRETKEY123";\n' > site/app.js
expect 0 "clean staged blob, unstaged keyed edit -> exit 0"

# opaque payloads: binary blobs outside the allowlist, LFS pointers, symlinks, gitlinks
reset; mkdir -p site; printf 'PK\003\004\000\000zip-ish\000' > site/blob.bin; git add -f site/blob.bin
expect 1 "binary blob with an unlisted extension -> exit 1"
reset; printf 'face\000data' > site/faces.dat; git add -f site/faces.dat
expect 1 "binary blob with a made-up extension -> exit 1"
reset; mkdir -p site/fonts; printf 'wOF2\000\001\000\000' > site/fonts/Inter.woff2; git add -f site/fonts/Inter.woff2
expect 0 "binary woff2 under site/fonts/ (allowlist) -> exit 0"
reset; mkdir -p site/other; printf 'wOF2\000\001\000\000' > site/other/Inter.woff2; git add -f site/other/Inter.woff2
expect 1 "binary woff2 outside site/fonts/ -> exit 1"
# the allowlist is path AND content: another binary renamed into site/fonts/ is not a font
reset; mkdir -p site/fonts; printf '\377\330\377\340\000\020JFIF\000' > site/fonts/Inter.woff2; git add -f site/fonts/Inter.woff2
expect 1 "non-woff2 binary renamed to site/fonts/*.woff2 -> exit 1"
if printf '%s' "$out" | grep -q 'private: site/fonts/Inter.woff2 (.*not woff2'; then ok "the diagnostic says the content is not woff2"; else bad "wrong diagnostic for a fake woff2: $out"; fi
reset; mkdir -p site/fonts; printf 'wOF\000\001\000\000\000' > site/fonts/Short.woff2; git add -f site/fonts/Short.woff2
expect 1 "binary with a near-miss woff2 magic under site/fonts/ -> exit 1"
# the home page's generated cards: home/og/*.png with the PNG signature, nowhere else
PNGB='\211PNG\r\n\032\n\000\000\000\rIHDR\000\000\000\001'
reset; mkdir -p home/og; printf "$PNGB" > home/og/og.png; git add home/og/og.png
expect 0 "png under home/og/ (allowlist, not git-ignored) -> exit 0"
reset; mkdir -p site; printf "$PNGB" > site/og.png; git add -f site/og.png
expect 1 "png outside home/og/ -> exit 1"
reset; mkdir -p home/og/sub; printf "$PNGB" > home/og/sub/x.png; git add -f home/og/sub/x.png
expect 1 "png in a folder under home/og/ -> exit 1"
reset; mkdir -p home/og; printf "$PNGB" > home/og/og.PNG; git add -f home/og/og.PNG
expect 1 "upper-case .PNG under home/og/ -> exit 1"
reset; mkdir -p home/og; printf '\377\330\377\340\000\020JFIF\000' > home/og/og.png; git add -f home/og/og.png
expect 1 "non-png binary named home/og/*.png -> exit 1"
if printf '%s' "$out" | grep -q 'private: home/og/og.png (.*not png'; then ok "the diagnostic says the content is not png"; else bad "wrong diagnostic for a fake png: $out"; fi
reset; mkdir -p home/og; printf 'not a png at all\n' > home/og/og.png; git add -f home/og/og.png
expect 1 "text named home/og/*.png -> exit 1"
reset; mkdir -p home/og; printf '\211PNG\r\n\032\000\000' > home/og/og.png; git add -f home/og/og.png
expect 1 "near-miss png signature under home/og/ -> exit 1"
reset; stage site/big.bin "$(printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize 12' 0)"
expect 1 "Git LFS pointer -> exit 1"
reset; ln -s ../../elsewhere site/link; git add -f site/link
expect 1 "symlink -> exit 1"
reset; git update-index --add --cacheinfo "160000,$(git rev-parse HEAD),vendor/sub"
expect 1 "gitlink (submodule) -> exit 1"
reset; stage "site/SECRETKEY123.txt" 'clean'
expect 1 "keyed string in a path name (index) -> exit 1"
out="$(bash bin/check-no-private.sh 2>&1)"; if printf '%s' "$out" | grep -q SECRETKEY123; then bad "diagnostic echoed the keyed name"; else ok "diagnostic withholds the keyed name"; fi

# history: binary, keyed path names and commit messages
settle; git checkout -q -b hist "$base"
printf 'x\000y' > site/h.bin; git add -f site/h.bin; git commit -qm "binary"
git rm -q --cached site/h.bin; command rm -f site/h.bin; git commit -qm "drop binary"
expect 1 "--history: a binary blob added then removed -> exit 1" --history -2 HEAD
git checkout -q -b hist2 "$base"
stage "site/SECRETKEY123.js" 'clean'; git commit -qm "keyed name"
git rm -q --cached "site/SECRETKEY123.js"; command rm -f "site/SECRETKEY123.js"; git commit -qm "drop it"
expect 1 "--history: keyed string in an added path name -> exit 1" --history -2 HEAD
git checkout -q -b hist3 "$base"
git commit -q --allow-empty -m "note: SECRETKEY123"
expect 1 "--history: keyed string in a commit message -> exit 1" --history -1 HEAD
git commit -q --allow-empty -m "$(printf 'set %s_PASSWORD=%s' GALLERY "$v")"
expect 1 "--history: password value in a commit message -> exit 1" --history -1 HEAD

# pre-push: a non-fast-forward (force) push of rewritten history is checked old..new.
# The leak lives only in history: the rewrite adds data.json, then a follow-up commit drops it, so
# the index is clean and only the old..new range can block. hist_diag: a history diagnostic
# ("private: <sha7>:site/data.json"), which the index check (no "<sha7>:" prefix) cannot print.
hist_diag() { printf '%s' "$1" | grep -Eq "private: $2:site/data\.json \(forbidden path\)"; }
settle; git checkout -q --orphan rewrite; reset
stage site/data.json '{}'; git commit -qm "rewritten root with data"
leak="$(git rev-parse HEAD)"
git rm -q --cached site/data.json; command rm -f site/data.json; git commit -qm "drop data"
new="$(git rev-parse HEAD)"
old="$(git rev-parse origin/clean)"
expect 0 "force-push setup: the index check alone is clean -> exit 0"
if git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then bad "force-push setup: the push would be a fast-forward"; else ok "force-push setup: new tip does not descend from the remote tip"; fi
pout="$(git push -f origin rewrite:clean 2>&1)"; prc=$?
if [ "$prc" != 0 ] && hist_diag "$pout" "${leak:0:7}"; then ok "force push of rewritten history is blocked by the old..new range (names <leak sha>:site/data.json)"
else bad "force push not blocked for the right reason (exit $prc): $pout"; fi
[ "$(git ls-remote "$T/remote.git" refs/heads/clean | cut -f1)" = "$old" ] && ok "remote clean unchanged" || bad "remote clean moved"
expect 1 "--pre-push, non-fast-forward line (known old tip) -> exit 1" --pre-push <<< "refs/heads/rewrite $new refs/heads/clean $old"
if hist_diag "$out" "${leak:0:7}"; then ok "non-fast-forward line: the diagnostic is the history one, for the leak commit"; else bad "non-fast-forward line: no history diagnostic: $out"; fi
if printf '%s' "$out" | grep -q 'private: site/'; then bad "non-fast-forward line: an index diagnostic appeared: $out"; else ok "non-fast-forward line: no index diagnostic"; fi
# negative control: the same tip and the same clean index, but a range that leaves the leak commit out
# passes. So the two blocks above come from old..new reaching the leak commit, nothing else.
expect 0 "control: same tip, range excluding the leak commit (leak..new) -> exit 0" --pre-push <<< "refs/heads/rewrite $new refs/heads/clean $leak"
if printf '%s' "$out" | grep -q '1 outgoing commits'; then ok "control: exactly the one clean commit was checked"; else bad "control: wrong commit count: $out"; fi
# and a clean force push (rewritten history with no leak) goes through: the range is not over-blocking
settle; git checkout -q --orphan rewrite2; reset
stage site/app.js; git commit -qm "rewritten root, clean"
if git push -q -f origin rewrite2:clean >/dev/null 2>&1; then ok "clean force push of rewritten history goes through"; else bad "clean force push blocked"; fi

# pre-push: a tip already tracked under an unrelated remote is still checked for a new destination ref
git init -q --bare "$T/other.git"; git remote add other "$T/other.git"
settle; git checkout -q -b leakb "$base"; stage site/data.json '{}'; git commit -qm "leak for other"
git push -q --no-verify other leakb >/dev/null 2>&1 || bad "setup: push to other failed"
[ -n "$(git rev-parse -q --verify refs/remotes/other/leakb)" ] && ok "setup: leak tip tracked under remote other" || bad "setup: no tracking ref"
git rm -q --cached site/data.json; command rm -f site/data.json; git commit -qm "drop it" # the index is clean again
pout="$(git push origin leakb 2>&1)"; prc=$?
if [ "$prc" != 0 ] && printf '%s' "$pout" | grep -q 'private: .*site/data.json'; then ok "new ref whose tip another remote tracks is still blocked"
else bad "tip tracked by an unrelated remote slipped through (exit $prc): $pout"; fi
expect 1 "--pre-push, new ref, old tip unknown locally -> exit 1" --pre-push <<< "refs/heads/leakb $(git rev-parse HEAD) refs/heads/leakb 1234567890123456789012345678901234567890"

# install-hooks: idempotent for ours, never clobbers someone else's
out="$(bash bin/install-hooks.sh 2>&1)"; rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'already installed' && ok "install-hooks twice -> already installed" || bad "install-hooks rerun (exit $rc): $out"
R2="$T/repo2"; mkdir -p "$R2/bin"; cp "$R/bin/install-hooks.sh" "$R2/bin/"
( cd "$R2" && git init -q -b main && printf '#!/bin/sh\necho other-hook\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push )
before="$(cat "$R2/.git/hooks/pre-push")"
out="$(cd "$R2" && bash bin/install-hooks.sh 2>&1)"; rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'already exists' && [ "$(cat "$R2/.git/hooks/pre-push")" = "$before" ]; then ok "install-hooks stops on a different existing hook, leaves it intact"
else bad "install-hooks over an existing hook (exit $rc): $out"; fi

# a worktree reads the patterns from the common .git dir
settle; cp "$PAT" "$(git rev-parse --git-common-dir)/armful-private-patterns"
mkdir -p "$T/sub"; git worktree add -q --detach "$T/sub/wt" HEAD >/dev/null 2>&1
if [ -d "$T/sub/wt" ]; then
  (cd "$T/sub/wt" && git read-tree --empty && printf 'const id = "SECRETKEY123";\n' > k.js && git add -f k.js) >/dev/null 2>&1
  out="$(cd "$T/sub/wt" && env -u ARMFUL_PRIVATE_PATTERNS bash "$R/bin/check-no-private.sh" 2>&1)"; rc=$?
  if [ "$rc" = 1 ]; then ok "a worktree reads the common .git patterns -> exit 1"; else bad "worktree default patterns (exit $rc, want 1): $out"; fi
  git worktree remove --force "$T/sub/wt" >/dev/null 2>&1
else bad "could not add a worktree"; fi
command rm -f "$(git rev-parse --git-common-dir)/armful-private-patterns"

[ "$fails" = 0 ] && { echo "PASS guard"; exit 0; } || { echo "FAIL guard: $fails"; exit 1; }
