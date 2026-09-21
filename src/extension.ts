import * as vscode from 'vscode';
import { Band, bandFor, BANDS, normalizeThresholds, Thresholds } from './bands';
import { readLiveSessions } from './sessions';
import {
  HeatReading,
  pruneOldFiles,
  readAll,
  resolveBridgeDirectory,
  selectForWorkspace,
} from './bridge';
import { FocusCache, refresh as refreshFocus } from './focus';
import { BridgeStatus, inspectBridge, installBridge } from './install';
import {
  formatResetIn,
  HeatSource,
  METRIC_KEYS,
  formatStatusText,
  heatPercentage,
  Metric,
  MetricKey,
  metricsFor,
  normalizeShow,
} from './metrics';
import { ColorPainter, ColorScope } from './colors';
import { normalizeSurfaces, Surface } from './surfaces';

const POLL_MS = 1000;
/** Base animation tick. Each band decides how many of these pass per frame. */
const FLICKER_TICK_MS = 120;
/** Focus is expensive relative to a file read, so it gets its own slow cadence. */
const FOCUS_INTERVAL_MS = 10000;

interface Settings {
  enabled: boolean;
  colorScope: ColorScope;
  surfaces: Surface[];
  gradient: boolean;
  thresholds: Thresholds;
  animate: boolean;
  showPercentage: boolean;
  hideWhenCold: boolean;
  bridgeDirectory: string;
  staleAfterSeconds: number;
  show: MetricKey[];
  heatFrom: HeatSource;
  pruneAfterDays: number;
  focusRecentFraction: number;
  checkBridge: boolean;
}

/**
 * Which threshold keys the user actually set, as opposed to inherited from the
 * package.json default. normalizeThresholds needs this to know what it may move.
 */
function explicitThresholdKeys(c: vscode.WorkspaceConfiguration): string[] {
  const i = c.inspect<Record<string, unknown>>('thresholds');
  const set = new Set<string>();
  for (const layer of [i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue]) {
    if (layer && typeof layer === 'object') {
      Object.keys(layer).forEach((k) => set.add(k));
    }
  }
  return [...set];
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('contextHeat');
  return {
    enabled: c.get<boolean>('enabled', true),
    colorScope: c.get<ColorScope>('colorScope', 'workspace'),
    surfaces: normalizeSurfaces(
      c.get('surfaces', ['titleBar', 'activityBar', 'statusBar', 'windowBorder'])
    ),
    gradient: c.get<boolean>('gradient', true),
    thresholds: normalizeThresholds(c.get('thresholds'), explicitThresholdKeys(c)),
    animate: c.get<boolean>('animate', true),
    showPercentage: c.get<boolean>('showPercentage', true),
    hideWhenCold: c.get<boolean>('hideWhenCold', false),
    bridgeDirectory: resolveBridgeDirectory(c.get<string>('bridgeDirectory', '')),
    staleAfterSeconds: c.get<number>('staleAfterSeconds', 900),
    show: normalizeShow(c.get('show', ['context', 'weekly', 'focus'])),
    heatFrom: c.get<HeatSource>('heatFrom', 'context'),
    pruneAfterDays: c.get<number>('pruneAfterDays', 7),
    focusRecentFraction: c.get<number>('focusRecentFraction', 0.2),
    checkBridge: c.get<boolean>('checkBridge', true),
  };
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/**
 * Build the hover as a plain string.
 *
 * render() runs every second, and on every flicker frame. Assigning a fresh
 * MarkdownString each time tears down an open hover and redraws it, so the
 * popup flickers while you are trying to read it. Producing a string lets the
 * caller assign only when the content actually changed — which also means the
 * content must be *stable*: a live "updated 3s ago" counter would defeat the
 * whole thing by differing on every tick.
 */
function tooltipMarkdown(
  reading: HeatReading | null,
  band: Band,
  metrics: Metric[],
  simulated: number | null,
  focus: number | null,
  showsFocus: boolean
): string {
  const lines: string[] = [];
  const md = {
    appendMarkdown(text: string) {
      lines.push(text);
    },
  };
  md.appendMarkdown(`**Context Heat** — ${band.blurb}\n\n`);

  if (simulated !== null) {
    md.appendMarkdown(
      `_Simulating ${simulated}%._ Run **Context Heat: Clear Simulation** to resume.\n\n`
    );
  }
  if (!reading) {
    md.appendMarkdown(
      'No Claude Code session found for this folder.\n\n' +
        'Check that `statusLine` in `~/.claude/settings.json` points at ' +
        '`context-heat-statusline.sh`.'
    );
    return lines.join('');
  }

  // The tooltip always shows all three, whatever the status bar is set to
  // display — it is where you look when you want the full picture.
  const all = metricsFor(reading, ['context', 'fiveHour', 'weekly', 'focus'], focus);
  const now = Date.now();
  for (const m of all) {
    const shown = metrics.some((x) => x.key === m.key);
    const reset = formatResetIn(m.resetsAt, now);
    const bullet = `${shown ? '**' : ''}${m.long}: ${Math.round(m.percentage)}%${shown ? '**' : ''}`;
    md.appendMarkdown(`- ${bullet}${reset ? ` _(resets in ${reset})_` : ''}\n`);
  }

  if (typeof focus === 'number') {
    md.appendMarkdown(
      '\n_Focus is the share of **conversation** tokens touching files you are\n' +
        'still working on — not of the context window, and not semantic._\n'
    );
  } else if (showsFocus) {
    // Focus is withheld until there is enough conversation to mean anything.
    // Saying why reads better than a silently missing row.
    md.appendMarkdown('\n_Working-set focus: not enough conversation yet._\n');
  }

  if (reading.contextWindowSize) {
    const used = Math.round((reading.usedPercentage / 100) * reading.contextWindowSize);
    md.appendMarkdown(
      `\n${used.toLocaleString()} / ${reading.contextWindowSize.toLocaleString()} tokens\n`
    );
  }
  if (reading.model) {
    md.appendMarkdown(`\nModel: ${reading.model}`);
  }
  if (reading.sessionName) {
    md.appendMarkdown(`\nSession: ${reading.sessionName}`);
  }
  // Deliberately coarse, and only when it is worth saying. A per-second
  // counter here is what made the hover redraw constantly.
  if (reading.live) {
    const idleMinutes = Math.floor((now - reading.ts) / 60000);
    md.appendMarkdown(
      idleMinutes >= 2 ? `\n\n_Session running, idle ${idleMinutes}m._` : '\n\n_Session running._'
    );
  } else {
    md.appendMarkdown('\n\n_Session has ended._');
  }
  return lines.join('');
}

/**
 * Held at module scope so deactivate() can clean up using the painter that did
 * the painting. A fresh painter has no record of which scopes it touched, and
 * would go stripping colours out of scopes this window never wrote to.
 */
let livePainter: ColorPainter | null = null;

export function activate(context: vscode.ExtensionContext) {
  const item = vscode.window.createStatusBarItem('contextHeat', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Context Heat';
  item.command = 'contextHeat.showStatus';
  context.subscriptions.push(item);

  const painter = new ColorPainter();
  livePainter = painter;
  const output = vscode.window.createOutputChannel('Context Heat');
  context.subscriptions.push(output);

  let settings = readSettings();
  let reading: HeatReading | null = null;
  let simulated: number | null = null;
  let currentBand: Band = BANDS.cold;
  let frame = 0;
  let focusCache: FocusCache | null = null;

  /**
   * Transcripts run to tens of megabytes, so this never runs on the poll timer.
   * Parsing is incremental — only bytes appended since last time — but even the
   * cold read is kept off the 1s path.
   */
  function refreshFocusIfDue() {
    if (!settings.show.includes('focus')) {
      focusCache = null;
      return;
    }
    const path = reading?.transcriptPath;
    if (!path) {
      return;
    }
    if (focusCache && Date.now() - focusCache.computedAt < FOCUS_INTERVAL_MS) {
      return;
    }
    try {
      focusCache = refreshFocus(path, focusCache, settings.focusRecentFraction);
    } catch {
      // A transcript we cannot read just means no focus number.
    }
  }

  function currentMetrics(): Metric[] {
    const metrics = metricsFor(reading, settings.show, focusCache?.focus ?? null);
    if (simulated === null) {
      return metrics;
    }
    // While simulating, the context number is the dial being turned; the rate
    // limits are still real, so leave them alone.
    return metrics.map((m) => (m.key === 'context' ? { ...m, percentage: simulated! } : m));
  }

  /** The context number on its own, before `heatFrom` gets a say. */
  function contextPercentage(): number | null {
    if (simulated !== null) {
      return simulated;
    }
    return reading ? reading.usedPercentage : null;
  }

  /**
   * Every metric, displayed or not. The temperature can follow a number the
   * status bar is not showing, and the tooltip lists them all regardless.
   */
  function allMetrics(): Metric[] {
    const metrics = metricsFor(reading, METRIC_KEYS, focusCache?.focus ?? null);
    if (simulated === null) {
      return metrics;
    }
    return metrics.map((m) => (m.key === 'context' ? { ...m, percentage: simulated! } : m));
  }

  /** The number that actually drives the temperature. */
  function effectivePercentage(): number | null {
    // Simulation overrides whatever the heat source is. Otherwise, with
    // `heatFrom` set to anything but context, the Simulate command would move
    // a number nothing is watching and appear to do nothing at all.
    if (simulated !== null) {
      return simulated;
    }
    return heatPercentage(allMetrics(), settings.heatFrom, contextPercentage());
  }

  /**
   * Only touch the status bar item when something changed. Reassigning these
   * every tick is what made an open hover flicker.
   */
  let lastText: string | null = null;
  let lastTooltip: string | null = null;
  let lastBackground: 'warning' | 'error' | undefined | null = null;

  function setText(text: string) {
    if (lastText !== text) {
      lastText = text;
      item.text = text;
    }
  }

  function setTooltip(markdown: string) {
    if (lastTooltip === markdown) {
      return;
    }
    lastTooltip = markdown;
    const md = new vscode.MarkdownString(markdown, true);
    md.isTrusted = true;
    item.tooltip = md;
  }

  function render() {
    const pct = effectivePercentage();

    if (!settings.enabled) {
      item.hide();
      return;
    }
    if (pct === null) {
      // No session for this window. Show a quiet marker rather than a wrong number.
      setText('$(circle-outline) Claude');
      setTooltip(tooltipMarkdown(null, BANDS.cold, [], simulated, null, false));
      item.backgroundColor = undefined;
      if (settings.hideWhenCold) {
        item.hide();
      } else {
        item.show();
      }
      return;
    }

    const band = currentBand;
    const frames = settings.animate ? band.frames : band.frames.slice(0, 1);
    const glyph = frames[frame % frames.length];
    const metrics = currentMetrics();

    setText(formatStatusText(glyph, metrics, settings.showPercentage, band.suffix));
    setTooltip(
      tooltipMarkdown(
        reading,
        band,
        metrics,
        simulated,
        focusCache?.focus ?? null,
        settings.show.includes('focus')
      )
    );
    const background = band.itemBackground
      ? new vscode.ThemeColor(`statusBarItem.${band.itemBackground}Background`)
      : undefined;
    if (lastBackground !== band.itemBackground) {
      lastBackground = band.itemBackground;
      item.backgroundColor = background;
    }

    if (band.name === 'cold' && settings.hideWhenCold) {
      item.hide();
    } else {
      item.show();
    }
  }

  async function tick() {
    const pctBefore = effectivePercentage();
    if (simulated === null) {
      const all = readAll(settings.bridgeDirectory, settings.staleAfterSeconds, readLiveSessions());
      reading = selectForWorkspace(all, workspacePaths());
    }
    refreshFocusIfDue();
    const pct = effectivePercentage();
    const nextBand = pct === null ? BANDS.cold : bandFor(pct, settings.thresholds);

    // Only touch settings.json when the band actually changes. Writing every
    // poll would thrash the file and fight Settings Sync.
    if (nextBand.name !== currentBand.name || pctBefore === null) {
      currentBand = nextBand;
      frame = 0;
      if (settings.enabled) {
        try {
          const wrote = await painter.apply(
            nextBand,
            settings.colorScope,
            settings.surfaces,
            settings.gradient
          );
          if (wrote) {
            output.appendLine(
              `${new Date().toISOString()} band -> ${nextBand.name} (${pct === null ? 'n/a' : Math.round(pct)}%)`
            );
          }
        } catch (err) {
          output.appendLine(`${new Date().toISOString()} color write failed: ${String(err)}`);
          void reportColorFailure(err);
        }
      }
    }
    render();
  }

  const pollTimer = setInterval(() => void tick(), POLL_MS);
  /**
   * A failed colour write is the most likely way this extension looks broken:
   * VS Code refuses some workspace-scope writes, the chrome simply never tints,
   * and an output channel nobody has open is not a signal. Say it once, with
   * the fix attached, then go quiet so a repeating failure is not a nag.
   */
  let reportedColorFailure = false;
  async function reportColorFailure(err: unknown) {
    if (reportedColorFailure) {
      return;
    }
    reportedColorFailure = true;
    const choice = await vscode.window.showWarningMessage(
      `Context Heat could not write colours to ${settings.colorScope} settings: ${String(err)}`,
      'Use global settings',
      'Status bar only',
      'Show log'
    );
    const config = vscode.workspace.getConfiguration('contextHeat');
    if (choice === 'Use global settings') {
      await config.update('colorScope', 'global', vscode.ConfigurationTarget.Global);
    } else if (choice === 'Status bar only') {
      await config.update('colorScope', 'off', vscode.ConfigurationTarget.Global);
    } else if (choice === 'Show log') {
      output.show(true);
    }
  }

  let lastFlick = 0;
  const flickerTimer = setInterval(() => {
    const rate = currentBand.flickerMs;
    if (!settings.animate || rate <= 0 || currentBand.frames.length < 2) {
      return;
    }
    const now = Date.now();
    if (now - lastFlick < rate) {
      return;
    }
    lastFlick = now;
    frame++;
    render();
  }, FLICKER_TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
  context.subscriptions.push({ dispose: () => clearInterval(flickerTimer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('contextHeat')) {
        return;
      }
      const previous = settings;
      settings = readSettings();
      if (previous.colorScope !== settings.colorScope || !settings.enabled) {
        await painter.clear(previous.colorScope);
      }
      currentBand = BANDS.cold;
      await tick();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('contextHeat.simulate', async () => {
      const picks = ['0', '30', '50', '65', '70', '85', '98', '100'];
      const choice = await vscode.window.showQuickPick(
        picks.map((p) => ({
          label: `${p}%`,
          description: bandFor(Number(p), settings.thresholds).blurb,
          value: Number(p),
        })),
        { title: 'Context Heat: simulate a context percentage' }
      );
      if (!choice) {
        return;
      }
      simulated = choice.value;
      currentBand = BANDS.cold;
      await tick();
    }),
    vscode.commands.registerCommand('contextHeat.clearSimulation', async () => {
      simulated = null;
      currentBand = BANDS.cold;
      await tick();
    }),
    vscode.commands.registerCommand('contextHeat.reset', async () => {
      simulated = null;
      await painter.clear('off'); // explicit user intent: sweep both scopes
      currentBand = BANDS.cold;

      // Clearing is not the same as stopping. If the session is still hot and
      // we are still enabled, the next poll repaints within a second — so say
      // so rather than letting the colours "come back" and look broken.
      const pct = effectivePercentage();
      const willRepaint =
        settings.enabled &&
        settings.colorScope !== 'off' &&
        pct !== null &&
        bandFor(pct, settings.thresholds).name !== 'cold';

      if (willRepaint) {
        const choice = await vscode.window.showInformationMessage(
          `Context Heat: colours cleared, but this session is still at ${Math.round(pct)}% — ` +
            'they will return on the next poll.',
          'Stop colouring',
          'OK'
        );
        if (choice === 'Stop colouring') {
          await vscode.workspace
            .getConfiguration('contextHeat')
            .update('colorScope', 'off', vscode.ConfigurationTarget.Global);
          settings = readSettings();
          await painter.clear('off');
        }
      } else {
        void vscode.window.showInformationMessage('Context Heat: colours cleared.');
      }
      await tick();
    }),
    vscode.commands.registerCommand('contextHeat.installBridge', () => checkBridge(true)),
    vscode.commands.registerCommand('contextHeat.showStatus', () => {
      const all = readAll(settings.bridgeDirectory, settings.staleAfterSeconds, readLiveSessions());
      output.appendLine('');
      output.appendLine(`Bridge dir: ${settings.bridgeDirectory}`);
      output.appendLine(`Workspace:  ${workspacePaths().join(', ') || '(none)'}`);
      output.appendLine(`Sessions:   ${all.length}`);
      for (const r of all) {
        const mark = reading && r.sessionId === reading.sessionId ? '->' : '  ';
        const state = r.live ? 'live' : 'ended';
        output.appendLine(
          `${mark} ${String(Math.round(r.usedPercentage)).padStart(3)}%  ${state.padEnd(5)} ${r.cwd ?? '?'}`
        );
      }
      output.show(true);
    })
  );

  /**
   * Installing the extension does not install the bridge, and without the
   * bridge nothing works — so offer, rather than leaving someone with a status
   * bar that says "no session found" and a README to go and read.
   *
   * A declined version is remembered so this asks once, not every launch.
   */
  async function checkBridge(explicit: boolean) {
    if (!explicit && !settings.checkBridge) {
      return;
    }
    const shipped = vscode.Uri.joinPath(
      context.extensionUri,
      'bin',
      'context-heat-statusline.sh'
    ).fsPath;

    let status: BridgeStatus;
    try {
      status = inspectBridge(shipped);
    } catch {
      return;
    }

    if (status.state === 'current' && status.wired) {
      if (explicit) {
        void vscode.window.showInformationMessage(
          `Context Heat: bridge is installed and wired up (${status.installedPath}).`
        );
      }
      return;
    }

    const dismissKey = `bridgeDismissed:${status.shippedHash}:${status.wired}`;
    if (!explicit && context.globalState.get<boolean>(dismissKey)) {
      return;
    }

    const needsWiring = !status.wired;
    const message =
      status.state === 'missing'
        ? 'Context Heat needs a small bridge script in ~/.claude to read your context percentage.'
        : status.state === 'outdated'
          ? 'Context Heat: the installed bridge script is from an older version.'
          : 'Context Heat: the bridge is installed, but Claude Code is not pointed at it.';

    const primary = needsWiring ? 'Install and wire up' : 'Update script';
    const actions = [primary];
    if (needsWiring && status.state !== 'current') {
      actions.push('Copy script only');
    }
    actions.push('Not now');

    const choice = await vscode.window.showInformationMessage(
      message +
        (needsWiring && status.existingCommand
          ? ' Your current status line is kept and rendered through it.'
          : ''),
      ...actions
    );

    if (choice === undefined || choice === 'Not now') {
      if (!explicit) {
        await context.globalState.update(dismissKey, true);
      }
      return;
    }

    try {
      const result = installBridge(shipped, { wire: choice === primary && needsWiring });
      const parts: string[] = [];
      if (result.copiedScript) {
        parts.push(`installed ${status.installedPath}`);
      }
      if (result.wiredStatusLine) {
        parts.push('pointed Claude Code at it');
      }
      if (result.preservedInner) {
        parts.push(`kept \`${result.preservedInner}\` as your status line`);
      }
      if (result.backupPath) {
        parts.push(`backup at ${result.backupPath}`);
      }
      const followUps = result.backupPath ? ['Show settings'] : [];
      const action = await vscode.window.showInformationMessage(
        `Context Heat: ${parts.join(', ')}. Restart Claude Code for it to take effect.`,
        ...followUps
      );
      if (action === 'Show settings') {
        const doc = await vscode.workspace.openTextDocument(status.claudeSettingsPath);
        await vscode.window.showTextDocument(doc);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Context Heat: could not install the bridge — ${String(err)}`);
    }
  }

  // One file per session was written and none were ever removed. Prune at
  // activation rather than in the bridge: a `find` spawn per status line render
  // would put back the cost we just took out of it.
  try {
    const removed = pruneOldFiles(settings.bridgeDirectory, settings.pruneAfterDays);
    if (removed > 0) {
      output.appendLine(`${new Date().toISOString()} pruned ${removed} stale bridge file(s)`);
    }
  } catch {
    // Housekeeping is never worth failing activation over.
  }

  void checkBridge(false);
  void tick();
}

export async function deactivate() {
  // Leaving a user's window permanently red would be the worst possible bug.
  // Scope-less clear() = only what this session actually painted.
  await livePainter?.clear();
  livePainter = null;
}
