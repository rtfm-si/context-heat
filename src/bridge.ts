import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSessions } from './sessions';

export interface RateLimit {
  usedPercentage: number;
  /** Unix seconds, or null if Claude Code did not report one. */
  resetsAt: number | null;
}

export interface HeatReading {
  sessionId: string;
  cwd: string | null;
  currentDir: string | null;
  transcriptPath: string | null;
  usedPercentage: number;
  contextWindowSize: number | null;
  model: string | null;
  sessionName: string | null;
  exceeds200k: boolean;
  fiveHour: RateLimit | null;
  sevenDay: RateLimit | null;
  /** File mtime. The bridge no longer stamps a time; the filesystem has one. */
  ts: number;
  /** Whether a process is still serving this session. */
  live: boolean;
}

export function defaultBridgeDirectory(): string {
  return path.join(os.homedir(), '.claude', 'context-heat');
}

export function resolveBridgeDirectory(configured: string): string {
  const trimmed = (configured ?? '').trim();
  if (!trimmed) {
    return defaultBridgeDirectory();
  }
  if (trimmed.startsWith('~')) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return trimmed;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function pct(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

function limit(raw: any): RateLimit | null {
  const used = pct(raw?.used_percentage ?? raw?.usedPercentage);
  if (used === null) {
    return null;
  }
  return { usedPercentage: used, resetsAt: num(raw?.resets_at ?? raw?.resetsAt) };
}

/**
 * Derive the context percentage, preferring what Claude Code reports.
 *
 * Note it arrives integer-rounded, so there is no more resolution to be had by
 * computing it ourselves — the token maths is only a fallback for payloads that
 * omit the percentages entirely.
 */
function contextPercentage(cw: any): number | null {
  const used = pct(cw?.used_percentage);
  if (used !== null) {
    return used;
  }
  const remaining = pct(cw?.remaining_percentage);
  if (remaining !== null) {
    return 100 - remaining;
  }
  const size = num(cw?.context_window_size);
  if (!size) {
    return null;
  }
  const u = cw?.current_usage;
  const tokens =
    typeof u === 'number'
      ? u
      : u && typeof u === 'object'
        ? (num(u.input_tokens) ?? 0) +
          (num(u.output_tokens) ?? 0) +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0)
        : null;
  return tokens === null ? null : Math.max(0, Math.min(100, (tokens / size) * 100));
}

/**
 * Parse a bridge file.
 *
 * The bridge writes Claude Code's payload verbatim — doing the extraction in
 * the shell cost ~350ms of node startup on every status line render. That makes
 * this the single place the payload shape is understood, which is also why the
 * legacy branch exists: files written by the older bridge are still on disk
 * after an upgrade, and a window that silently went cold would look broken.
 */
export function parseReading(obj: any, fallbackId: string, ts: number): HeatReading | null {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  // Legacy pre-extracted shape.
  if (obj.usedPercentage !== undefined && obj.context_window === undefined) {
    const used = pct(obj.usedPercentage);
    if (used === null) {
      return null;
    }
    return {
      sessionId: String(obj.sessionId ?? fallbackId),
      cwd: obj.cwd ?? null,
      currentDir: obj.currentDir ?? null,
      transcriptPath: null,
      usedPercentage: used,
      contextWindowSize: num(obj.contextWindowSize),
      model: obj.model ?? null,
      sessionName: obj.sessionName ?? null,
      exceeds200k: !!obj.exceeds200k,
      fiveHour: limit(obj.rateLimits?.fiveHour ?? null),
      sevenDay: limit(obj.rateLimits?.sevenDay ?? null),
      ts,
      live: false,
    };
  }

  const used = contextPercentage(obj.context_window);
  if (used === null) {
    return null;
  }
  const ws = obj.workspace ?? {};
  return {
    sessionId: String(obj.session_id ?? fallbackId),
    cwd: ws.project_dir ?? ws.current_dir ?? obj.cwd ?? null,
    currentDir: ws.current_dir ?? obj.cwd ?? null,
    transcriptPath: obj.transcript_path ?? null,
    usedPercentage: used,
    contextWindowSize: num(obj.context_window?.context_window_size),
    model: obj.model?.display_name ?? obj.model?.id ?? null,
    sessionName: obj.session_name ?? null,
    exceeds200k: !!obj.exceeds_200k_tokens,
    fiveHour: limit(obj.rate_limits?.five_hour),
    sevenDay: limit(obj.rate_limits?.seven_day),
    ts,
    live: false,
  };
}

function readOne(file: string): HeatReading | null {
  try {
    const stat = fs.statSync(file);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parseReading(parsed, path.basename(file, '.json'), stat.mtimeMs);
  } catch {
    // A torn or hand-mangled file should not take the extension down.
    return null;
  }
}

/**
 * When the registry is unavailable we cannot tell idle from finished, so the
 * cutoff has to be generous enough not to hide a session someone is coming
 * back to. Sessions genuinely run for weeks.
 */
const BLIND_FALLBACK_SECONDS = 24 * 60 * 60;

export function readAll(
  dir: string,
  staleAfterSeconds: number,
  liveSessions?: LiveSessions
): HeatReading[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const live = liveSessions ?? { available: false, ids: new Set<string>() };
  const endedCutoff = Date.now() - Math.max(0, staleAfterSeconds) * 1000;
  const blindCutoff = Date.now() - Math.max(staleAfterSeconds, BLIND_FALLBACK_SECONDS) * 1000;

  const out: HeatReading[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'raw.json' || name.startsWith('.')) {
      continue;
    }
    const reading = readOne(path.join(dir, name));
    if (!reading) {
      continue;
    }

    if (live.available) {
      reading.live = live.ids.has(reading.sessionId);
      // A running session is never stale, however long it has been idle: it is
      // still holding that context and you are coming back to it. Only a
      // session whose process has gone gets aged out.
      if (reading.live || reading.ts >= endedCutoff) {
        out.push(reading);
      }
    } else if (reading.ts >= blindCutoff) {
      out.push(reading);
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * Delete bridge files nothing will read again.
 *
 * One file is written per session and none were ever removed, so the directory
 * grew without bound. Runs once at activation, off the status line's hot path.
 */
export function pruneOldFiles(dir: string, olderThanDays: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - Math.max(1, olderThanDays) * 86400000;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {
      // Racing with the bridge, or not ours to delete. Leave it.
    }
  }
  return removed;
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function contains(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Pick the session that belongs to this window.
 *
 * Newest-overall is the wrong default: with several Claude sessions running,
 * every window would show whichever one last rendered its status line. So a
 * window with folders open only ever matches a session rooted in one of them.
 * A window with no folder open has nothing to match against, and there we do
 * fall back to newest.
 */
export function selectForWorkspace(
  readings: HeatReading[],
  workspaceFolders: string[]
): HeatReading | null {
  if (readings.length === 0) {
    return null;
  }
  if (workspaceFolders.length === 0) {
    return readings[0];
  }
  const scored = readings
    .map((r) => {
      const dirs = [r.cwd, r.currentDir].filter((d): d is string => !!d);
      let best = -1;
      for (const folder of workspaceFolders) {
        for (const dir of dirs) {
          if (samePath(folder, dir)) {
            best = Math.max(best, 2);
          } else if (contains(folder, dir) || contains(dir, folder)) {
            best = Math.max(best, 1);
          }
        }
      }
      return { reading: r, score: best };
    })
    .filter((s) => s.score >= 0);

  if (scored.length === 0) {
    return null;
  }
  // Location first, then liveness, then recency: a running session beats a
  // finished one in the same folder even if the finished one rendered later.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.reading.live) - Number(a.reading.live) ||
      b.reading.ts - a.reading.ts
  );
  return scored[0].reading;
}
