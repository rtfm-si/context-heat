#!/bin/sh
# context-heat bridge
#
# Claude Code pipes its statusLine JSON to this script on stdin. We park the
# payload where the VS Code extension can find it, then hand it untouched to the
# real status line.
#
# This runs on every status line render, so it must stay cheap. An earlier
# version parsed the JSON here with `node -e`; backgrounding it did not help,
# because it contended for CPU with the status line's own node process and cost
# ~350ms per render. All it needs to do is find the session id, which one sed
# does in ~3ms. The extension does the real parsing.
#
# Wire it up in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "~/.claude/context-heat-statusline.sh" }

set -u

HEAT_DIR="${CONTEXT_HEAT_DIR:-$HOME/.claude/context-heat}"
# The status line you actually want to look at. Set to "" to render nothing.
INNER_STATUSLINE="${CONTEXT_HEAT_INNER-npx -y ccstatusline@latest}"

input=$(cat)

# The character class doubles as filename sanitising: no slashes, no dots-dots.
session_id=$(
  printf '%s' "$input" | tr -d '\n' |
    sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]\{1,128\}\)".*/\1/p'
)

# No session id means we skip the write. There is deliberately no fallback
# filename: two sessions that both failed extraction would collide on it, and
# last-writer-wins across sessions is the exact bug per-session keying exists
# to prevent. A missing sample is harmless; a wrong one is not.
if [ -n "$session_id" ] && mkdir -p "$HEAT_DIR" 2>/dev/null; then
  tmp="$HEAT_DIR/.$session_id.$$.tmp"
  # Write-then-rename so the extension never reads a half-written file.
  if printf '%s' "$input" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$HEAT_DIR/$session_id.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
fi

if [ -n "$INNER_STATUSLINE" ]; then
  printf '%s' "$input" | sh -c "$INNER_STATUSLINE"
fi
