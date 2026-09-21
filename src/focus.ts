import * as fs from 'fs';

/**
 * How much of the conversation is about what you are working on *now*.
 *
 * A Claude Code session has a single `cwd`, so "other work threads" cannot mean
 * other projects — within one session it means earlier sub-tasks. So this
 * measures working-set overlap over time: the share of conversation tokens that
 * touch a file you are still touching.
 *
 * Two things it is not, and the tooltip says so:
 *
 *  - It is not semantic relevance. That needs embeddings, which means a network
 *    call per sample. This is structural: which files a record mentions.
 *  - It is a share *of the conversation*, not of the context window. The system
 *    prompt, tool definitions, CLAUDE.md and skills are real context that never
 *    appears in a transcript, so focus and context% are not parts of one whole.
 */

export interface FocusRecord {
  tokens: number;
  paths: string[];
}

export interface FocusCache {
  path: string;
  /** Byte offset we have consumed up to. JSONL is append-only. */
  cursor: number;
  /** Trailing bytes that did not end in a newline yet. */
  partial: string;
  records: FocusRecord[];
  /** Carried forward so an appended batch continues the attribution. */
  lastPaths: string[];
  focus: number | null;
  computedAt: number;
}

const PATH_RE = /(?:\/[A-Za-z0-9._-]+){2,}/g;
const MAX_PATHS_PER_RECORD = 8;
/** Guard against a pathological transcript eating memory. */
const MAX_RECORDS = 50000;

const IGNORED = [
  '/dev/',
  '/proc/',
  '/node_modules/',
  '/.git/',
];

function usefulPaths(text: string): string[] {
  const found = text.match(PATH_RE);
  if (!found) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    if (IGNORED.some((frag) => raw.includes(frag))) {
      continue;
    }
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_PATHS_PER_RECORD) {
      break;
    }
  }
  return out;
}

const COUNTED_TYPES = new Set(['user', 'assistant', 'attachment']);

function recordFrom(line: string, lastPaths: string[]): FocusRecord | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!COUNTED_TYPES.has(obj?.type)) {
    return null;
  }
  const text = JSON.stringify(obj.message ?? obj);
  const paths = usefulPaths(text);
  return {
    // chars/4 is the usual rough token proxy. We only need the ratio between
    // records, so a consistent estimate matters more than an accurate one.
    tokens: Math.max(1, Math.round(text.length / 4)),
    // A record with no path of its own belongs to the turn that caused it —
    // tool results and follow-up prose inherit. Without this, two thirds of the
    // transcript is unattributable and the metric is mostly noise.
    paths: paths.length ? paths : lastPaths,
  };
}

/**
 * Read only what has been appended since last time.
 *
 * Transcripts reach tens of megabytes, so re-reading one on a timer is not an
 * option. If the file shrank or was replaced, the cursor is meaningless and we
 * start over.
 */
export function ingest(path: string, cache: FocusCache | null): FocusCache {
  let size = 0;
  try {
    size = fs.statSync(path).size;
  } catch {
    return cache ?? emptyCache(path);
  }

  let state: FocusCache =
    cache && cache.path === path && size >= cache.cursor ? cache : emptyCache(path);

  if (size === state.cursor) {
    return state;
  }

  let chunk = '';
  try {
    const fd = fs.openSync(path, 'r');
    try {
      const length = size - state.cursor;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, state.cursor);
      chunk = buf.subarray(0, read).toString('utf8');
      state.cursor += read;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return state;
  }

  const text = state.partial + chunk;
  const lines = text.split('\n');
  // The final element is whatever came after the last newline: either an empty
  // string, or a record still being written. Hold it until the rest arrives.
  state.partial = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const rec = recordFrom(line, state.lastPaths);
    if (!rec) {
      continue;
    }
    if (rec.paths.length) {
      state.lastPaths = rec.paths;
    }
    state.records.push(rec);
  }
  if (state.records.length > MAX_RECORDS) {
    state.records = state.records.slice(-MAX_RECORDS);
  }
  return state;
}

function emptyCache(path: string): FocusCache {
  return {
    path,
    cursor: 0,
    partial: '',
    records: [],
    lastPaths: [],
    focus: null,
    computedAt: 0,
  };
}

/**
 * Share of tokens touching the current working set, 0..100.
 *
 * `recentFraction` defines "now": the tail of the conversation whose files
 * count as what you are working on.
 */
export function computeFocus(records: FocusRecord[], recentFraction = 0.2): number | null {
  if (records.length < 8) {
    // Too early to say anything meaningful; a 3-record session is always 100%.
    return null;
  }
  const tailCount = Math.max(1, Math.ceil(records.length * recentFraction));
  const working = new Set<string>();
  for (const rec of records.slice(-tailCount)) {
    for (const p of rec.paths) {
      working.add(p);
    }
  }
  if (working.size === 0) {
    return null;
  }
  let relevant = 0;
  let total = 0;
  for (const rec of records) {
    total += rec.tokens;
    if (rec.paths.some((p) => working.has(p))) {
      relevant += rec.tokens;
    }
  }
  return total === 0 ? null : Math.max(0, Math.min(100, (relevant / total) * 100));
}

/** Ingest anything new and recompute. Returns the updated cache. */
export function refresh(
  path: string,
  cache: FocusCache | null,
  recentFraction: number
): FocusCache {
  const state = ingest(path, cache);
  state.focus = computeFocus(state.records, recentFraction);
  state.computedAt = Date.now();
  return state;
}
