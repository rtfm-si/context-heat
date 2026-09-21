# Changelog

## 0.0.4

- Added a **Set up Context Heat** walkthrough, so installing the bridge and
  choosing what to show no longer means reading the README first.
- Settings are grouped into Temperature, Colours, Focus and Bridge sections
  rather than one flat list of sixteen.
- `contextBasis` can measure context against the auto-compact threshold instead
  of the whole window, which is why this and ccstatusline disagreed: ccstatusline
  divides by a usable window, so 32% of 1M reads as 40% there.
- `staleAfterSeconds` renamed to `forgetEndedAfterSeconds`. The old name read as
  "ignore sessions that have gone quiet", which was the wrong mental model and
  the cause of the idle-session bug.
- A session whose state cannot be determined reports as unknown rather than
  claiming it has ended.
- The bridge install flow is now covered by the test suite.

## 0.0.3

- Idle sessions are no longer treated as finished. Liveness now comes from
  Claude Code's session registry and a process check, so a session left open
  keeps its temperature however long it sits. Only sessions whose process has
  gone are aged out.
- Fixed the hover tooltip redrawing every second. It carried a live "updated Ns
  ago" counter and was reassigned on every tick, which tore down an open hover.
- `heatFrom` defaults to `context` again.

## 0.0.2

- The extension now offers to install the statusline bridge on first launch, and
  to update it when the shipped script changes. An existing `statusLine` command
  is preserved as `CONTEXT_HEAT_INNER` rather than replaced.
- `heatFrom` can name a specific metric. It defaults to `fiveHour`: the 5-hour
  session limit is usually the budget that stops you working.
- `show` defaults to context, weekly and focus.

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
