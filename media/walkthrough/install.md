Context Heat reads the context percentage that Claude Code already calculates
and hands to its status line.

To get at it, a small script needs to live in `~/.claude/` and Claude Code's
`statusLine` needs to point at it. The button below does both.

If you already have a status line — `ccstatusline`, or anything else — it is
kept and rendered through the bridge, so nothing about it changes.

Your `settings.json` is backed up first, and a file that cannot be parsed is
left alone rather than rewritten.
