import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The extension is inert until the bridge script is on disk and Claude Code's
 * statusLine points at it. Installing the extension does not do that, so
 * without this the first-run experience is a status bar that says "no session
 * found" and a README you have to go and read.
 *
 * Everything here only ever *reports*. Writing to a user's Claude config is
 * offered, never done on our own initiative.
 */

export type BridgeState = 'missing' | 'outdated' | 'current';

export interface BridgeStatus {
  state: BridgeState;
  /** Where the bridge should live. */
  installedPath: string;
  claudeSettingsPath: string;
  /** Whether statusLine already points at the bridge. */
  wired: boolean;
  /** What statusLine runs today, if it is not already us. */
  existingCommand: string | null;
  /** Identifies this version of the script, for remembering a dismissal. */
  shippedHash: string;
}

function claudeDir(home = os.homedir()): string {
  return path.join(home, '.claude');
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Normalise before comparing so a trailing-newline difference, or the path the
 * user typed, does not read as "outdated" forever.
 */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') {
    return home;
  }
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

export function inspectBridge(shippedPath: string, home = os.homedir()): BridgeStatus {
  const dir = claudeDir(home);
  const installedPath = path.join(dir, 'context-heat-statusline.sh');
  const claudeSettingsPath = path.join(dir, 'settings.json');

  const shipped = readIfPresent(shippedPath) ?? '';
  const installed = readIfPresent(installedPath);

  const state: BridgeState =
    installed === null
      ? 'missing'
      : normalise(installed) === normalise(shipped)
        ? 'current'
        : 'outdated';

  let wired = false;
  let existingCommand: string | null = null;
  try {
    const settings = JSON.parse(readIfPresent(claudeSettingsPath) ?? '{}');
    const command: unknown = settings?.statusLine?.command;
    if (typeof command === 'string') {
      // Compare resolved paths: "~/.claude/..." and the absolute form are the
      // same wiring, and a user who typed either should not be re-prompted.
      const resolved = path.resolve(expandHome(command.trim(), home));
      wired = resolved === path.resolve(installedPath);
      existingCommand = wired ? null : command;
    }
  } catch {
    // Unreadable or malformed settings: treat as not wired and let the user
    // decide. We never repair a file we cannot parse.
  }

  return {
    state,
    installedPath,
    claudeSettingsPath,
    wired,
    existingCommand,
    shippedHash: hash(normalise(shipped)),
  };
}

export interface InstallResult {
  copiedScript: boolean;
  wiredStatusLine: boolean;
  /** The command we preserved as the inner status line, if any. */
  preservedInner: string | null;
  backupPath: string | null;
}

/**
 * Copy the script into place and, if asked, point Claude Code at it.
 *
 * An existing statusLine command is preserved as `CONTEXT_HEAT_INNER` rather
 * than replaced — the bridge pipes through to it, so the status line the user
 * already chose keeps rendering exactly as before. Silently replacing someone's
 * status line would be the worst possible first impression.
 */
export function installBridge(
  shippedPath: string,
  options: { wire: boolean; home?: string }
): InstallResult {
  const home = options.home ?? os.homedir();
  const status = inspectBridge(shippedPath, home);
  const result: InstallResult = {
    copiedScript: false,
    wiredStatusLine: false,
    preservedInner: null,
    backupPath: null,
  };

  fs.mkdirSync(claudeDir(home), { recursive: true });
  fs.copyFileSync(shippedPath, status.installedPath);
  fs.chmodSync(status.installedPath, 0o755);
  result.copiedScript = true;

  if (!options.wire || status.wired) {
    return result;
  }

  const raw = readIfPresent(status.claudeSettingsPath);
  let settings: any;
  try {
    settings = raw ? JSON.parse(raw) : {};
  } catch {
    // Refuse to rewrite a settings file we cannot parse; we would lose it.
    return result;
  }

  if (raw !== null) {
    result.backupPath = status.claudeSettingsPath + '.context-heat.bak';
    fs.writeFileSync(result.backupPath, raw);
  }

  const previous: unknown = settings?.statusLine?.command;
  if (typeof previous === 'string' && previous.trim()) {
    settings.env = settings.env ?? {};
    settings.env.CONTEXT_HEAT_INNER = previous;
    result.preservedInner = previous;
  }

  settings.statusLine = {
    ...(settings.statusLine ?? {}),
    type: 'command',
    command: status.installedPath,
  };

  fs.writeFileSync(status.claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n');
  result.wiredStatusLine = true;
  return result;
}
