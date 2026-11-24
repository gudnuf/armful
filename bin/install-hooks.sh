#!/usr/bin/env bash
# install-hooks.sh: run bin/check-no-private.sh --pre-push before every push.
# The hook checks the index and every outgoing commit (git passes the refs on stdin).
# It is a local convenience: see README "Checks" for the gate that matters.
# An existing pre-push hook that is not ours is never overwritten.
set -eu
cd "$(git rev-parse --show-toplevel)"
hook="$(git rev-parse --git-path hooks)/pre-push"
mkdir -p "$(dirname "$hook")"
want="$(mktemp)"; trap 'command rm -f "$want"' EXIT
cat > "$want" <<'HOOK'
#!/usr/bin/env bash
# armful privacy guard (installed by bin/install-hooks.sh)
exec "$(git rev-parse --show-toplevel)/bin/check-no-private.sh" --pre-push
HOOK
if [ -e "$hook" ] || [ -L "$hook" ]; then
  if cmp -s "$want" "$hook"; then
    chmod +x "$hook"
    echo "already installed: $hook"
    exit 0
  fi
  {
    echo "install-hooks: a different pre-push hook already exists at $hook; not touching it."
    echo "  Either add this line to that hook (before anything that uploads), passing its stdin through:"
    echo '    "$(git rev-parse --show-toplevel)/bin/check-no-private.sh" --pre-push || exit 1'
    echo "  or move it aside (mv \"$hook\" \"$hook.local\") and run bin/install-hooks.sh again."
  } >&2
  exit 1
fi
cp "$want" "$hook"
chmod +x "$hook"
echo "installed $hook"
