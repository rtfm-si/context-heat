import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Which Claude Code sessions are actually still running.
 *
 * File age cannot answer this. A bridge file is only rewritten when the status
 * line renders, which only happens when Claude is doing something — so a
 * session you left open over lunch looks identical to one you finished last
 * week. Treating idle as finished let the window go cold while the session was
 * still sitting there holding a full context window.
 *
 * Claude Code keeps a registry at ~/.claude/sessions/<pid>.json, which pairs a
 * session id with the process id serving it. Asking the OS whether that process
 * exists is the real answer, and it costs nothing.
 */

export interface LiveSessions {
  /** False when the registry could not be read, so callers can fall back. */
  available: boolean;
  ids: Set<string>;
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 performs the permission and existence checks without signalling.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to someone else. That still
    // counts as running; only ESRCH means genuinely gone.
    return err?.code === 'EPERM';
  }
}

export function readLiveSessions(home = os.homedir()): LiveSessions {
  const dir = path.join(home, '.claude', 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { available: false, ids: new Set() };
  }

  const ids = new Set<string>();
  let parsedAny = false;

  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const sessionId = entry?.sessionId;
      const pid = Number(entry?.pid);
      if (typeof sessionId !== 'string' || !sessionId) {
        continue;
      }
      parsedAny = true;
      if (isRunning(pid)) {
        ids.add(sessionId);
      }
    } catch {
      // A torn or foreign file in the registry is not our problem.
    }
  }

  // An empty or unparseable registry is indistinguishable from one this build
  // of Claude Code does not write. Report it unavailable so callers keep their
  // old behaviour rather than concluding every session is dead.
  return { available: parsedAny, ids };
}
