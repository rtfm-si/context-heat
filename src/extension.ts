import * as vscode from 'vscode';
import { Band, bandFor, BANDS, normalizeThresholds, Thresholds } from './bands';
import {
  HeatReading,
  pruneOldFiles,
  readAll,
  resolveBridgeDirectory,
  selectForWorkspace,
} from './bridge';
import { FocusCache, refresh as refreshFocus } from './focus';
import {
  formatResetIn,
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
  heatFrom: 'context' | 'hottest';
  pruneAfterDays: number;
  focusRecentFraction: number;
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
    show: normalizeShow(c.get('show')),
    heatFrom: c.get<'context' | 'hottest'>('heatFrom', 'context'),
    pruneAfterDays: c.get<number>('pruneAfterDays', 7),
    focusRecentFraction: c.get<number>('focusRecentFraction', 0.2),
  };
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function tooltip(
  reading: HeatReading | null,
  band: Band,
  metrics: Metric[],
  simulated: number | null,
  focus: number | null,
  showsFocus: boolean
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
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
    return md;
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
  const age = Math.round((now - reading.ts) / 1000);
  md.appendMarkdown(`\n\n_Updated ${age}s ago._`);
  return md;
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

  /** The number that actually drives the temperature. */
  function effectivePercentage(): number | null {
    return heatPercentage(currentMetrics(), settings.heatFrom, contextPercentage());
  }

  function render() {
    const pct = effectivePercentage();

    if (!settings.enabled) {
      item.hide();
      return;
    }
    if (pct === null) {
      // No session for this window. Show a quiet marker rather than a wrong number.
      item.text = '$(circle-outline) Claude';
      item.tooltip = tooltip(null, BANDS.cold, [], simulated, null, false);
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

    item.text = formatStatusText(glyph, metrics, settings.showPercentage, band.suffix);
    item.tooltip = tooltip(
      reading,
      band,
      metrics,
      simulated,
      focusCache?.focus ?? null,
      settings.show.includes('focus')
    );
    item.backgroundColor = band.itemBackground
      ? new vscode.ThemeColor(`statusBarItem.${band.itemBackground}Background`)
      : undefined;

    if (band.name === 'cold' && settings.hideWhenCold) {
      item.hide();
    } else {
      item.show();
    }
  }

  async function tick() {
    const pctBefore = effectivePercentage();
    if (simulated === null) {
      const all = readAll(settings.bridgeDirectory, settings.staleAfterSeconds);
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
    vscode.commands.registerCommand('contextHeat.showStatus', () => {
      const all = readAll(settings.bridgeDirectory, settings.staleAfterSeconds);
      output.appendLine('');
      output.appendLine(`Bridge dir: ${settings.bridgeDirectory}`);
      output.appendLine(`Workspace:  ${workspacePaths().join(', ') || '(none)'}`);
      output.appendLine(`Sessions:   ${all.length}`);
      for (const r of all) {
        const mark = reading && r.sessionId === reading.sessionId ? '->' : '  ';
        output.appendLine(`${mark} ${String(Math.round(r.usedPercentage)).padStart(3)}%  ${r.cwd ?? '?'}`);
      }
      output.show(true);
    })
  );

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

  void tick();
}

export async function deactivate() {
  // Leaving a user's window permanently red would be the worst possible bug.
  // Scope-less clear() = only what this session actually painted.
  await livePainter?.clear();
  livePainter = null;
}
