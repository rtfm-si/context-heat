# Changelog

## 0.0.1

First release.

- Heats the VS Code chrome as the Claude Code context window fills, from a faint
  amber at 25% to a frantic `MELTDOWN` at 98%. Full fire lands at 70%, which is
  the normal maximum — `critical` and `meltdown` escalate above it.
- Reads the context percentage from Claude Code's own status line payload via a
  bridge script, so Anthropic's number is the number.
- One bridge file per session, matched to the window by workspace folder, so
  several concurrent Claude sessions do not show each other's temperature.
- Optional `fiveHour`, `weekly` and `focus` metrics in the status bar.
- `focus` estimates the share of conversation tokens touching files you are
  still working on, by incremental transcript parsing.
- Gradient tinting: faint at the title bar, full strength at the status bar.
- Only removes colour entries it wrote, in the scope it wrote them. Ownership
  is matched on the base colour rather than the exact value, so keys left behind
  by an earlier build are reclaimed instead of stranded.
