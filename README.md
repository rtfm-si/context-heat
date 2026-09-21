# Context Heat

Your editor gets hot as your Claude Code context window fills up.

You stop reading `73%`. You just notice the window is getting warm.

| Context | Band | What you see |
| ---: | --- | --- |
| 0–25% | cold | normal VS Code, `● Claude` |
| 25–45% | warm | faint amber title bar, `🌡 34%` |
| 45–60% | toasty | orange chrome, `🔥 52%` |
| 60–70% | hot | strong orange, slow flicker, `🔥🔥 65%` |
| **70–80%** | **blazing** | **on fire — full red chrome, `🔥🔥🔥 74%`** |
| 80–98% | critical | harsher red, fast flicker, `💥🔥🔥 85%  COMPACT` |
| 98%+ | meltdown | frantic, `💥🔥💥 99%  MELTDOWN` |
| after `/compact` | — | cools back down within a second |

**70% is the normal maximum.** That is where you are "on fire" — by the time
you have used 70% of a window you already want to be wrapping up, so the scale
tops out there rather than saving the drama for 90%. `critical` and `meltdown`
sit above it as real escalation: harsher colour, faster flicker, and a label
that shouts. They should be rare, which is what makes them mean something.

## Showing more than context

The same payload carries your rate limits, so the status bar can show all three:

```json
"contextHeat.show": ["context", "fiveHour", "weekly"]
```

```
🔥🔥 ctx 74% · 5h 34% · 7d 77%
```

With just `["context"]` — the default — it reads `🔥🔥 74%` exactly as before;
labels only appear once there is something to tell apart. The tooltip always
shows all three, with reset times.

**The temperature follows your 5-hour session limit by default**, not the
context window — that is usually the budget that actually stops you working.
Set `contextHeat.heatFrom` to `context`, `weekly`, or `hottest` (the highest of
the three) to change it.

Heat is independent of display: it can follow a number the status bar is not
showing, and the tooltip lists everything regardless. If Claude Code does not
report the chosen limit, it falls back to the context window rather than going
cold — a window that quietly stopped reacting reads as a broken extension.

A rate limit Claude Code did not report is omitted rather than shown as `0%` —
on a status bar, "none used" and "don't know" must not look identical.

## The gradient

VS Code has no gradient — every theme key is one flat colour. But the chrome is
physically stacked, so ramping intensity down that stack reads as one:

```
┌──────────────────────────────┐
│  title bar      30%  ░░░░░░  │   faint
│  tabs           47%  ▒▒▒▒▒▒  │
│  side bar       61%  ▒▒▒▒▒▒  │
│  activity bar   69%  ▓▓▓▓▓▓  │
│  panel          86%  ▓▓▓▓▓▓  │
│  status bar    100%  ██████  │   full strength
└──────────────────────────────┘
```

The ramp is alpha, not a pre-mixed colour, so it composites over whatever your
theme already draws and works in light and dark alike. A fixed blend would have
had to assume a dark background.

Foreground colours are only forced where the tint is near-opaque. At low alpha
the theme's own foreground still contrasts correctly against its own background
— overriding it there is how you get dark-on-dark text.

By default only `titleBar`, `activityBar`, `statusBar` and `windowBorder` are
tinted, which leaves a dark gap through the middle of the window. Enable the
rest for a continuous ramp:

```json
"contextHeat.surfaces": ["titleBar", "tabs", "sideBar", "activityBar", "panel", "statusBar", "windowBorder"]
```

`"contextHeat.gradient": false` gives the old flat tint on every surface.

## Focus: how much of your context is about what you're doing now

```json
"contextHeat.show": ["context", "focus"]
```
```
🔥🔥 ctx 74% · fcs 58%
```

A Claude session has one `cwd`, so "other work threads" cannot mean other
projects — within a session it means earlier sub-tasks. So focus measures
working-set overlap over time: **the share of conversation tokens that touch a
file you are still touching.**

Each transcript record is attributed to the files it mentions, and records with
no path of their own inherit from the turn that caused them — tool results and
follow-up prose belong to the thing that produced them. That carry-forward is
what makes it work: raw path coverage is 66%, and inheritance takes it to 100%.

Two things it is **not**, and the tooltip says so:

- **Not semantic relevance.** That needs embeddings, which means a network call
  per sample. This is structural — which files a record mentions.
- **Not a share of the context window.** The system prompt, tool definitions,
  `CLAUDE.md` and skills are real context that never appears in a transcript.
  Focus and context% are not parts of one whole, and mustn't be read that way.

Focus never drives the temperature. 90% focus is excellent; setting the window
on fire for doing well would be backwards.

Transcripts reach tens of megabytes, so parsing is incremental — only the bytes
appended since last time — on its own 10s cadence, never the 1s poll. A 16MB
transcript costs 113ms once, then 0ms. If the file is truncated or replaced the
byte cursor is discarded and it starts over.

`contextHeat.focusRecentFraction` (default `0.2`) sets what counts as "now".

## How it works

Claude Code hands its status line a JSON blob on stdin every render. That blob
already contains `context_window.used_percentage` — Anthropic has done the hard
part. We tee it to disk and let the extension read it.

```
Claude Code
    ↓ statusLine JSON on stdin
bin/context-heat-statusline.sh          ← parks the payload, pipes through to your real status line
    ↓ ~/.claude/context-heat/<session-id>.json   (Claude's payload, verbatim)
VS Code extension (polls 1s)
    ↓
status bar item + workbench.colorCustomizations
```

**The bridge does no parsing.** An earlier version extracted the fields with
`node -e`. That runs on every status line render, and backgrounding it did not
help — it contended for CPU with the status line's own node process:

| | per render |
| --- | ---: |
| ccstatusline alone | ~754ms |
| with node-parsing bridge | ~1107ms |
| with current bridge | ~774ms |

So the bridge now does one `sed` to find the session id (~3ms), writes Claude's
payload verbatim, and the extension does the parsing. That also means every
field is available to the extension without ever touching the bridge again.

**One file per session, not one shared file.** Several Claude sessions run at
once — a shared file means last-writer-wins and every window shows the wrong
number. Each window matches the session whose `cwd` is inside its workspace
folder, and shows nothing if there isn't one.

## Install

```sh
npm install
npm run package
code --install-extension context-heat-0.0.1.vsix
```

You do not need the Marketplace to use this.

On first launch the extension notices the bridge is missing and offers to
install it: it copies the script to `~/.claude/` and points Claude Code's
`statusLine` at it. Restart Claude Code and it starts working.

It also notices when the installed script is older than the one shipped, and
offers to update. Declining is remembered per version, so it asks once rather
than every launch. **Context Heat: Install or Update Statusline Bridge** runs
the same check on demand, and `contextHeat.checkBridge` turns the startup check
off entirely.

It will not touch a `~/.claude/settings.json` it cannot parse, and it backs the
file up to `settings.json.context-heat.bak` before writing.

To wire it by hand instead:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/context-heat-statusline.sh",
  "padding": 0
}
```

### Keeping your existing status line

The bridge wraps rather than replaces. If you already had a `statusLine`
command, installing moves it to `CONTEXT_HEAT_INNER` and the bridge pipes
through to it, so your status line renders exactly as it did. Silently
replacing it would be the worst possible first impression.

To change what it wraps, or wrap nothing:

```sh
CONTEXT_HEAT_INNER="my-statusline --flags"   # something else
CONTEXT_HEAT_INNER=""                        # render nothing
```

If the bridge ever breaks it fails silently and your status line still renders.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `contextHeat.enabled` | `true` | master switch |
| `contextHeat.show` | `["context", "weekly", "focus"]` | also `fiveHour` |
| `contextHeat.heatFrom` | `fiveHour` | or `context`, `weekly`, `hottest` |
| `contextHeat.colorScope` | `workspace` | `workspace` \| `global` \| `off` |
| `contextHeat.gradient` | `true` | ramp intensity down the window |
| `contextHeat.surfaces` | `titleBar`, `activityBar`, `statusBar`, `windowBorder` | also `tabs`, `sideBar`, `panel` |
| `contextHeat.thresholds` | `25/45/60/70/80/98` | where each band starts |
| `contextHeat.animate` | `true` | flicker the flames when hot |
| `contextHeat.showPercentage` | `true` | number next to the flames |
| `contextHeat.hideWhenCold` | `false` | hide entirely below the first band |
| `contextHeat.staleAfterSeconds` | `900` | ignore finished sessions |
| `contextHeat.focusRecentFraction` | `0.2` | tail of the conversation that counts as "now" |
| `contextHeat.checkBridge` | `true` | check the bridge is installed at startup |
| `contextHeat.pruneAfterDays` | `7` | delete old bridge files at startup |

### Configuring what counts as "on fire"

`blazing` is the on-fire threshold. Move it and the bands below get out of the
way on their own — you do not have to restate the whole scale:

```json
"contextHeat.thresholds": { "blazing": 55 }
```

That puts full fire at 55% and compresses `warm`/`toasty`/`hot` beneath it.
`critical` and `meltdown` stay where they are. The same works upward: setting
`"warm": 75` pushes every band above it up past 75, so nothing below 75%
registers at all.

Set any subset. Values are clamped to 0–100, and if two of your own values
conflict the higher band wins so no band becomes unreachable.

### colorScope

`workspace` writes `workbench.colorCustomizations` into each repo's
`.vscode/settings.json`, so each window heats independently — correct, because
the sessions are independent. Add to your global gitignore if you'd rather not
commit it:

```
.vscode/settings.json
```

`global` avoids that but heats **every** window together, including ones with no
Claude session. `off` never writes settings at all — status bar only.

The extension only removes entries whose **colour** is one of its own, in the
**scope** it actually wrote to. Matching ignores the alpha suffix, so a key an
older build wrote with a different alpha is reclaimed rather than stranded on
your settings forever. If you have hand-set
`titleBar.activeBackground` in your own settings, it survives paint, deactivate
and reset untouched — owning a key is not the same as having written it.

### Surfaces and the gradient

Listed top to bottom: `titleBar`, `tabs`, `sideBar`, `activityBar`, `panel`,
`statusBar`, plus `windowBorder` which wraps the whole window and always takes
full strength — it is the outline of the fire, not part of the ramp.

### windowBorder

`window.activeBorder` colours the actual outer window border, but only when
VS Code draws its own title bar. If the border doesn't change, set:

```json
"window.titleBarStyle": "custom"
```

## Commands

- **Context Heat: Simulate Temperature** — force a percentage. You can't reach
  94% on demand, so without this the top bands ship untested.
- **Context Heat: Clear Simulation**
- **Context Heat: Reset Colors** — strip every colour this extension wrote. If
  the session is still hot it tells you the colours will return on the next
  poll, and offers to stop colouring altogether.
- **Context Heat: Show Bridge Status** — lists every session the bridge sees and
  which one this window matched. First stop when the number looks wrong.

## Caveats

If a colour write fails — VS Code refuses workspace-scope writes in some
window configurations — you get one warning with a fix attached, not silence
and an editor that never tints.


`used_percentage` arrives **integer-rounded**, so the resolution is 1% — fine for
bands, no use for smooth gradients. It has also
[historically disagreed](https://github.com/anthropics/claude-code/issues/17959)
with Claude's internal auto-compact calculation around system and tool overhead.
Treat it as a temperature, not a fuel gauge. That is the entire point.

## What this deliberately isn't

The idea sketch wanted literal animated flames crawling around the editor
perimeter. Extensions cannot touch VS Code's DOM or inject stylesheets, so that
needs `custom-css-and-js-loader` patching the workbench — which breaks on every
VS Code update and cannot ship to the Marketplace. Coloured chrome plus a
flickering status bar gets most of the feeling for none of the fragility.

## Development

```sh
npm install
npm test      # compiles, then 115 assertions over the band scale, session
              # selection, payload parsing, metrics, the gradient ramp,
              # colour ownership, incremental transcript parsing, and
              # settings read/merge/restore
npm run package
```

The tests drive the compiled extension against a stubbed `vscode` module, so
the band logic, session matching and colour read/merge/restore paths run for
real without an Extension Host.

## Publishing

The two things that are not ready are the two only you can supply: a registered
publisher id, and a real repository URL. `publisher` and `repository` in
`package.json` are placeholders.

**1. Register a publisher** at
<https://marketplace.visualstudio.com/manage>. The id you pick there must match
`publisher` in `package.json` exactly.

**2. Get a Personal Access Token.** From your Azure DevOps organisation
(<https://dev.azure.com>): User settings → Personal access tokens → New token,
with **Organization: all accessible organizations** and **Scopes: Marketplace →
Manage**. The org-wide setting is the step people miss; a token scoped to one
organisation fails at publish with an unhelpful error.

**3. Publish.**

```sh
npx @vscode/vsce login <publisher>     # paste the PAT once
npm test && npm run package
npx @vscode/vsce publish               # or: publish minor / publish 0.1.0
```

`vsce publish <version>` bumps `package.json`, commits and tags — which needs a
git repo. `git init` first, or pass `--no-git-tag-version`.

CI instead of interactive login: set `VSCE_PAT` and run `npx @vscode/vsce
publish -p "$VSCE_PAT"`.

### Open VSX

Cursor, Windsurf, VSCodium and Theia use [Open VSX](https://open-vsx.org), not
the Microsoft Marketplace. Publishing to one does not publish to the other:

```sh
npx ovsx publish context-heat-0.0.1.vsix -p <open-vsx-token>
```

### You do not need to publish to use this

`code --install-extension context-heat-0.0.1.vsix` installs the packaged file
directly, and `npm run package` rebuilds it. Publishing is only for handing it
to other people.

## The icon

`media/icon.svg` is the source; `media/icon.png` is what ships.

```sh
./media/build-icon.sh
```

It renders through macOS QuickLook rather than ImageMagick directly, because
ImageMagick's built-in SVG renderer ignores `linearGradient` and fills the flame
flat black. The script trims QuickLook's padding and squares the result to the
128×128 the Marketplace wants.

## Licence

MIT
