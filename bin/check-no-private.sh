#!/usr/bin/env bash
# check-no-private.sh: fail closed if anything private is tracked, staged or pushed.
#
# armful is a public repo. Rules:
#   1. path rules: page data, hidden lists, scan output, photos, video (every
#      type the pipeline reads, any case), per-collection config (anything
#      under collections/ except example/), wrangler secrets and state, face
#      crops, screenshots, local state (those dirs at any depth);
#   2. opaque payloads: any binary blob outside the allowlist, Git LFS pointers,
#      symlinks (mode 120000) and gitlinks (mode 160000). The allowlist is path AND
#      content: site/fonts/*.woff2 must start with the woff2 magic bytes, and
#      home/og/*.png (the generated link-preview card and touch icon, exempt from
#      the photo rule) with the PNG signature;
#   3. a password variable assigned a real value (GALLERY_PASSWORD,
#      COLLECTION_PASSWORD_*; `=` or `:`, quoted or not, spaces allowed).
#      Empty values, placeholders (<value>, $VAR, change-me, ...) and env
#      reads pass;
#   4. keyed strings (private ids and the like), one ERE per line, read from
#      ${ARMFUL_PRIVATE_PATTERNS:-<git common dir>/armful-private-patterns}
#      (i.e. .git/armful-private-patterns, shared by every worktree), checked
#      against file contents, path names and (in --history) commit messages.
#      That file is never committed (it lives inside .git, or wherever
#      ARMFUL_PRIVATE_PATTERNS points outside the repo); this script holds no
#      private string. If it is missing the guard warns and checks the other
#      rules only; if it is not a valid pattern list the guard stops (exit 2).
#
# usage:
#   bin/check-no-private.sh                    the index: every staged entry (mode, path, blob)
#   bin/check-no-private.sh --history ARGS...  every commit `git rev-list ARGS...` lists: each entry
#                                              it adds or changes (mode, path, whole blob), its message
#   bin/check-no-private.sh --pre-push         the pre-push hook: the index check, then --history over
#                                              each outgoing ref (lines "<lref> <lsha> <rref> <rsha>" on
#                                              stdin). A known old tip: old..new (covers force pushes).
#                                              A new ref, or an old tip not present locally: everything
#                                              reachable from the local tip.
# exit: 0 clean, 1 private content found, 2 the guard could not run (fail closed).
set -u -o pipefail # a failing git in a pipe must not pass as "no output"
export LC_ALL=C
cd "$(git rev-parse --show-toplevel)" || exit 2

if [ -n "${ARMFUL_PRIVATE_PATTERNS:-}" ]; then
  PATTERNS="$ARMFUL_PRIVATE_PATTERNS"
else # inside .git (the common dir, so worktrees share it), as an absolute path
  GITDIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || GITDIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)" || exit 2
  PATTERNS="$GITDIR/armful-private-patterns"
fi
MEDIA='tsv|npy|npz|jpe?g|png|gif|heic|heif|avif|dng|webp|tiff?|bmp|raw|cr2|cr3|nef|arw|orf|rw2|mov|mp4|m4v|avi|mkv|webm|3gp|mts'
# the only binary blobs allowed (svg is text), each with the magic bytes its content must start with
FONT_OK='^site/fonts/[^/]+\.woff2$'; WOFF2_MAGIC=774f4632        # "wOF2", the first four bytes of every woff2 file
OG_OK='^home/og/[^/]+\.png$';        PNG_MAGIC=89504e470d0a1a0a  # the eight-byte PNG signature
# allowed_magic PATH: the hex magic an allowlisted path must carry, and its kind; nothing if not allowlisted
allowed_magic() {
  if printf '%s\n' "$1" | grep -E "$FONT_OK" >/dev/null; then echo "$WOFF2_MAGIC woff2"
  elif printf '%s\n' "$1" | grep -E "$OG_OK" >/dev/null; then echo "$PNG_MAGIC png"
  fi
}

bad=0
flag() { echo "private: $1" >&2; bad=1; }
die() { echo "check-no-private: ERROR: $1" >&2; exit 2; }

TMP="$(mktemp -d)" || die "mktemp failed"
trap 'command rm -rf "$TMP"' EXIT
: > "$TMP/seen"

# keyed patterns: blank lines dropped (they would match everything), then validated
PATS=""
if [ -e "$PATTERNS" ]; then
  [ -f "$PATTERNS" ] && [ -r "$PATTERNS" ] || die "keyed pattern list $PATTERNS is not a readable file"
  grep -v '^[[:space:]]*$' "$PATTERNS" > "$TMP/pats"
  [ $? -le 1 ] || die "could not read $PATTERNS"
  if [ -s "$TMP/pats" ]; then
    grep -E -f "$TMP/pats" /dev/null >/dev/null 2>&1
    [ $? -le 1 ] || die "invalid pattern list in $PATTERNS (grep -E rejects it)"
    PATS="$TMP/pats"
  fi
else
  echo "check-no-private: warning: no keyed patterns at $PATTERNS; checking the other rules only" >&2
fi

# keyed_hit TEXT_FILE: 0 if any keyed pattern matches, 1 if none (exit 2 on grep error)
keyed_hit() {
  [ -n "$PATS" ] || return 1
  grep -qE -f "$PATS" -- "$1"; local rc=$?
  [ $rc -le 1 ] || die "grep failed"
  return $rc
}

# check_path PATH WHERE: rule 1, and rule 4 on the name itself
check_path() {
  local p="$1" where="$2"
  if printf '%s\n' "$p" | grep -E '(^|/)(data|hidden)\.json$|(^|/)\.dev\.vars$|(^|/)(shots|state|crops|\.wrangler)/' >/dev/null; then
    flag "$where$p (forbidden path)"
  elif printf '%s\n' "$p" | grep -E '(^|/)local\.env$' >/dev/null; then
    flag "$where$p (local env: real paths)"
  elif printf '%s\n' "$p" | grep -iE "\\.($MEDIA)\$" >/dev/null && ! printf '%s\n' "$p" | grep -E "$OG_OK" >/dev/null; then
    flag "$where$p (forbidden file type)"
  elif printf '%s\n' "$p" | grep -E '^collections/' >/dev/null && ! printf '%s\n' "$p" | grep -E '^collections/example/' >/dev/null; then
    flag "$where$p (collection config: only collections/example/ is public)"
  fi
  printf '%s\n' "$p" > "$TMP/name"
  keyed_hit "$TMP/name" && flag "${where}<path> (keyed string in a path name; name withheld)"
  return 0
}

# check_password FILE LABEL: rule 3; prints LABEL:line only, never the value
check_password() {
  local out
  out="$(awk '
    function allowed(v, lv) {
      lv = tolower(v)
      if (v == "") return 1
      if (v ~ /^[$<%]/ || v ~ /^\{\{/) return 1                       # $VAR, ${VAR}, <value>, %(x)s, {{ x }}
      if (lv ~ /^(process\.env|env\.|os\.environ|os\.getenv|getenv\(|context\.env)/) return 1
      if (lv ~ /^(change[-_]?me|placeholder|example|redacted|your[-_]?password([-_]?here)?|password[-_]?here|todo|none|null|undefined|secret[-_]?here)$/) return 1
      if (v ~ /^(x+|\*+|\.\.\.)$/) return 1
      return 0
    }
    {
      line = $0
      while (match(line, /(GALLERY_PASSWORD|COLLECTION_PASSWORD_[A-Z0-9_]+)["\047]?[ \t]*[:=][ \t]*/)) {
        rest = substr(line, RSTART + RLENGTH)
        sep = substr(line, RSTART, RLENGTH)
        line = rest
        if (rest ~ /^=/) continue                                       # ==, === comparisons
        if (sep ~ /:[ \t]*$/ && rest ~ /^:/) continue                    # :: and :=-style operators
        q = substr(rest, 1, 1)
        if (q == "\"" || q == "\047" || q == "`") {
          v = substr(rest, 2); i = index(v, q); if (i > 0) v = substr(v, 1, i - 1)
        } else {
          v = rest; sub(/[ \t,;)}#].*$/, "", v)
        }
        if (!allowed(v)) { print NR; break }
      }
    }' "$1")" || die "awk failed on $2"
  [ -n "$out" ] && while IFS= read -r l; do flag "$2:$l (password value)"; done <<< "$out"
  return 0
}

# check_keyed FILE LABEL: rule 4 on contents; prints LABEL:line only
check_keyed() {
  [ -n "$PATS" ] || return 0
  local out rc
  out="$(grep -naE -f "$PATS" -- "$1")"; rc=$?
  [ $rc -le 1 ] || die "grep failed on $2"
  [ $rc -eq 0 ] && while IFS= read -r l; do flag "$2:${l%%:*} (keyed string)"; done <<< "$out"
  return 0
}

is_binary() { # a NUL in the first 8000 bytes, as git decides
  local a b
  a="$(head -c 8000 "$1" | wc -c)" || die "head failed"
  b="$(head -c 8000 "$1" | tr -d '\000' | wc -c)" || die "tr failed"
  [ "$a" != "$b" ]
}

# check_entry MODE OID PATH WHERE: rules 1-4 on one tree/index entry (content checks cached by oid)
check_entry() {
  local mode="$1" oid="$2" p="$3" where="$4" label magic want kind
  label="$where$p"
  check_path "$p" "$where"
  case "$mode" in
    120000) flag "$label (symlink: not allowed)"; return 0 ;;
    160000) flag "$label (gitlink / submodule: not allowed)"; return 0 ;;
    100644|100755) ;;
    *) flag "$label (unsupported mode $mode)"; return 0 ;;
  esac
  git cat-file blob "$oid" > "$TMP/blob" || die "git cat-file blob $oid ($label) failed"
  read -r want kind <<< "$(allowed_magic "$p")"
  if [ -n "$want" ]; then # an allowlisted path: its content must be that kind, binary or not
    magic="$(head -c $((${#want} / 2)) "$TMP/blob" | od -An -tx1 | tr -d ' \n')" || die "od failed on $label"
    [ "$magic" = "$want" ] || { flag "$label (file on the allowlist path is not $kind: wrong magic bytes)"; return 0; }
    is_binary "$TMP/blob" && return 0
  elif is_binary "$TMP/blob"; then
    flag "$label (binary file outside the allowlist)"
    return 0
  fi
  if head -c 200 "$TMP/blob" | grep -E '^version https://git-lfs\.github\.com/spec/' >/dev/null; then
    flag "$label (Git LFS pointer: the payload is not checked, not allowed)"
    return 0
  fi
  grep -qxF -- "$oid" "$TMP/seen" && return 0 # same content already checked
  printf '%s\n' "$oid" >> "$TMP/seen"
  check_password "$TMP/blob" "$label"
  check_keyed "$TMP/blob" "$label"
}

check_index() {
  local meta p mode oid stage n=0
  # -s -z: mode, object id and stage of each entry; names raw, never C-quoted
  git ls-files -s -z > "$TMP/index" || die "git ls-files failed"
  while IFS= read -r -d '' rec; do
    meta="${rec%%$'\t'*}"; p="${rec#*$'\t'}"
    read -r mode oid stage <<< "$meta"
    [ "$stage" = 0 ] || { flag "$p (unmerged index entry, stage $stage)"; continue; }
    check_entry "$mode" "$oid" "$p" ""
    n=$((n + 1))
  done < "$TMP/index"
  NFILES=$n
}

# check_history ARGS...: every commit rev-list ARGS lists
check_history() {
  local c sc nc=0 hdr p newmode newoid status
  git rev-list "$@" > "$TMP/commits" 2>"$TMP/err" || die "git rev-list $* failed: $(cat "$TMP/err")"
  while IFS= read -r c; do
    nc=$((nc + 1)); sc="${c:0:7}"
    # the message
    git cat-file commit "$c" | sed '1,/^$/d' > "$TMP/msg" || die "git cat-file commit $c failed"
    check_password "$TMP/msg" "$sc:<commit message>"
    check_keyed "$TMP/msg" "$sc:<commit message>"
    # every entry the commit adds or changes; -m: merges against each parent; --no-renames: one path per record
    git diff-tree -m -r -z --root --no-commit-id --no-renames --raw --diff-filter=AMT "$c" > "$TMP/raw" \
      || die "git diff-tree $c failed"
    while IFS= read -r -d '' hdr; do
      IFS= read -r -d '' p || die "truncated diff-tree output for $c"
      # hdr: ":oldmode newmode oldoid newoid status"
      read -r _ newmode _ newoid status <<< "${hdr#:}"
      check_entry "$newmode" "$newoid" "$p" "$sc:"
    done < "$TMP/raw"
  done < "$TMP/commits"
  NCOMMITS=$((${NCOMMITS:-0} + nc))
}

finish() {
  if [ "$bad" = 1 ]; then
    echo "check-no-private: FAILED: $1" >&2
    exit 1
  fi
  echo "check-no-private: ok ($2)"
  exit 0
}

case "${1:-}" in
  "")
    check_index
    finish "remove the entries above from git (git rm --cached) or scrub them" "$NFILES files"
    ;;
  --history)
    shift
    [ $# -gt 0 ] || die "--history needs rev-list arguments, e.g. --all or origin/main..HEAD"
    check_history "$@"
    finish "a commit in the range carries the items above; rewrite it before pushing" "${NCOMMITS:-0} commits"
    ;;
  --pre-push)
    check_index
    while read -r lref lsha rref rsha; do
      [ -n "${lsha:-}" ] || continue
      [[ "$lsha" =~ ^0+$ ]] && continue # deleting a remote ref: nothing leaves
      if [[ "$rsha" =~ ^0+$ ]] || ! git cat-file -e "$rsha^{commit}" 2>/dev/null; then
        check_history "$lsha" # new ref, or an old tip we do not have: all history the tip carries
      else
        check_history "$rsha..$lsha" # newly reachable from the ref (fast-forward or force push)
      fi
    done
    finish "do not push: the index or an outgoing commit carries the items above" "$NFILES files, ${NCOMMITS:-0} outgoing commits"
    ;;
  *)
    die "unknown argument $1 (see the header of this script)"
    ;;
esac
