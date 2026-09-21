Yes. With **Claude Code specifically**, this is quite feasible.

Claude Code exposes context information to its status-line integration, including `context_window.used_percentage`, and existing VS Code extensions already read Claude’s local session/transcript data to show context consumption. ([ClaudeMap][1])

The limitation is the **flames themselves**. Normal VS Code extensions cannot access or inject CSS into the main VS Code DOM, so they cannot officially draw animated flames around the entire editor frame. ([Visual Studio Code][2]) But they _can_ change workbench colours, including the actual window border on macOS/Linux with a custom title bar. ([Visual Studio Code][3])

### I think there's a genuinely good extension here

Call it something like **Context Heat**, **Token Temperature**, or **Context Inferno**.

The normal/Marketplace-safe version could progressively change the entire VS Code chrome:

|   Claude context | UI                                       |
| ---------------: | ---------------------------------------- |
|            0–30% | Normal VS Code                           |
|           30–50% | Very subtle amber window border          |
|           50–65% | Orange border + slightly warm status bar |
|           65–80% | Strong orange/red title/window border    |
|           80–90% | Red chrome + `🔥 84%` status indicator   |
|             90%+ | Deep red + `🔥🔥🔥 94%`                  |
| after `/compact` | instantly cools back down                |

On your Mac specifically, `"window.activeBorder"` can colour the **actual outer window border**, provided VS Code uses the custom title bar. ([Visual Studio Code][4])

And I'd make it more playful than merely changing colour:

```text
  23%   Claude ●
  48%   Claude 🌡
  67%   Claude 🔥
  82%   Claude 🔥🔥
  94%   Claude 🔥🔥🔥  COMPACT
```

The Activity Bar, title bar, status bar and outer border could heat up together.

### Getting the Claude value

There are two sensible approaches.

**Best:** use Claude Code's status-line mechanism as a bridge:

```text
Claude Code
    ↓
statusLine JSON
    ↓
context_window.used_percentage
    ↓
~/.claude/context-heat.json
    ↓
VS Code extension watches file
    ↓
UI temperature
```

This is nice because Anthropic is already calculating the context state.

Alternatively, read Claude's local JSONL transcripts. Several existing extensions do exactly that; for example Claude Context Bar calculates context locally from Claude Code session files, while Claude VS Code Status can display context percentage and token counts. ([Visual Studio Marketplace][5])

There is one caveat: Claude's reported percentage has had discrepancies with its internal auto-compact calculation, particularly around system/tool overhead and some extended-context sessions. So I'd treat it as **temperature rather than an exact fuel gauge**. ([GitHub][6])

### But I like your original flame idea better

There is a **non-standard version** that could actually look spectacular:

```text
┌🔥────────────────────────────────────────🔥┐
│                                           │
│               VS CODE                     │
│                                           │
│                                           │
🔥                                           🔥
└🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥┘
                 CONTEXT 91%
```

At low context there'd be nothing.

At ~50%, a tiny glow/embers along the bottom.

At ~70%, small animated flames.

At ~90%, flames crawl substantially around the window perimeter.

At ~98%, the editor is visually **on fire**.

That cannot be done through the supported VS Code extension API because extensions are deliberately prevented from manipulating VS Code's DOM or applying custom stylesheets. ([Visual Studio Code][2]) You could nevertheless build it as a local CSS/workbench modification, but it would be brittle across VS Code updates and unsuitable as a clean Marketplace extension.

A middle ground would work extremely well: **official extension + coloured frame + animated flame meter in the status bar**. It's probably a small extension — perhaps a few hundred lines rather than a major project.

And the metaphor is unusually good: you don't really need to read `73%`. You start noticing that **your editor is getting hot**, which is exactly the information you need.

[1]: https://www.claudemap.org/en/guides/claude-code-statusline-guide?utm_source=chatgpt.com "Claude Code Statusline: The stdin JSON Protocol and Reusable Script Templates (2026)"
[2]: https://code.visualstudio.com/api/extension-capabilities/overview?utm_source=chatgpt.com "Extension Capabilities Overview | Visual Studio Code Extension API"
[3]: https://code.visualstudio.com/api/references/theme-color?utm_source=chatgpt.com "Theme Color | Visual Studio Code Extension API"
[4]: https://code.visualstudio.com/updates/v1_104?utm_source=chatgpt.com "August 2025 (version 1.104)"
[5]: https://marketplace.visualstudio.com/items?itemName=E-MRE.claude-code-statusbar&utm_source=chatgpt.com "Claude VS Code Status - Visual Studio Marketplace"
[6]: https://github.com/anthropics/claude-code/issues/17959?utm_source=chatgpt.com "context_window.used_percentage doesn't match internal context warning calculation · Issue #17959 · anthropics/claude-code · GitHub"
