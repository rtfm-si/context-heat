import { HeatReading } from './bridge';

export type MetricKey = 'context' | 'fiveHour' | 'weekly' | 'focus';

export const METRIC_KEYS: MetricKey[] = ['context', 'fiveHour', 'weekly', 'focus'];

/**
 * Metrics where a high number is bad.
 *
 * `focus` is the odd one out: 90% focus is excellent, and letting it drive the
 * temperature would set the window on fire for doing well.
 */
const HEAT_METRICS: MetricKey[] = ['context', 'fiveHour', 'weekly'];

/** What the temperature follows. */
export type HeatSource = 'context' | 'fiveHour' | 'weekly' | 'hottest';

export interface Metric {
  key: MetricKey;
  /** Compact label for the status bar. */
  short: string;
  /** Full label for the tooltip. */
  long: string;
  percentage: number;
  /** Unix seconds when this budget refills, where that is a thing that happens. */
  resetsAt: number | null;
}

const LABELS: Record<MetricKey, { short: string; long: string }> = {
  context: { short: 'ctx', long: 'Context window' },
  fiveHour: { short: '5h', long: '5-hour limit' },
  weekly: { short: '7d', long: 'Weekly limit' },
  focus: { short: 'focus', long: 'Working-set focus' },
};

/**
 * The metrics available from a reading, in a stable order.
 *
 * A rate limit Claude Code did not report is omitted rather than shown as 0% —
 * "0% of your weekly budget used" and "we don't know" look identical on a
 * status bar, and only one of them is true.
 */
export function metricsFor(
  reading: HeatReading | null,
  show: MetricKey[],
  focus?: number | null
): Metric[] {
  if (!reading) {
    return [];
  }
  const out: Metric[] = [];
  for (const key of METRIC_KEYS) {
    if (!show.includes(key)) {
      continue;
    }
    if (key === 'context') {
      out.push({ key, ...LABELS[key], percentage: reading.usedPercentage, resetsAt: null });
      continue;
    }
    if (key === 'focus') {
      // Omitted until there is enough transcript to say anything honest.
      if (typeof focus === 'number') {
        out.push({ key, ...LABELS[key], percentage: focus, resetsAt: null });
      }
      continue;
    }
    const limit = key === 'fiveHour' ? reading.fiveHour : reading.sevenDay;
    if (limit) {
      out.push({ key, ...LABELS[key], percentage: limit.usedPercentage, resetsAt: limit.resetsAt });
    }
  }
  return out;
}

/**
 * Which percentage drives the temperature.
 *
 * `metrics` must be every metric available, not just the ones on display: you
 * can perfectly reasonably heat from the 5-hour limit while showing context and
 * weekly, and the colour should still be right.
 *
 * A named source that Claude Code did not report falls back to context rather
 * than going cold. A window that quietly stopped reacting would read as the
 * extension being broken, which is worse than heating from the wrong number.
 */
export type ContextBasis = 'window' | 'untilCompact';

/**
 * Rescale the context number against the point auto-compact fires.
 *
 * Claude reports context as a share of the whole window, and that is what
 * `window` shows. But you are not interrupted at 100% — auto-compact fires
 * earlier, so `untilCompact` measures against that instead and reaches 100%
 * when you are actually about to be compacted.
 *
 * This is the whole reason Context Heat and ccstatusline disagree: ccstatusline
 * divides by a usable window of 80%, so 31.7% of a 1M window reads as 39.6%
 * there. Neither is wrong; they answer different questions.
 */
export function applyContextBasis(
  metrics: Metric[],
  basis: ContextBasis,
  compactAtPercent: number
): Metric[] {
  if (basis === 'window') {
    return metrics;
  }
  const ratio = Math.max(1, Math.min(100, compactAtPercent)) / 100;
  return metrics.map((m) =>
    m.key === 'context' ? { ...m, percentage: Math.min(100, m.percentage / ratio) } : m
  );
}

export function heatPercentage(
  metrics: Metric[],
  heatFrom: HeatSource,
  contextPercentage: number | null
): number | null {
  if (heatFrom === 'hottest') {
    const heatable = metrics.filter((m) => HEAT_METRICS.includes(m.key));
    if (heatable.length > 0) {
      return Math.max(...heatable.map((m) => m.percentage));
    }
    return contextPercentage;
  }
  const named = metrics.find((m) => m.key === heatFrom);
  return named ? named.percentage : contextPercentage;
}

/**
 * Status bar text.
 *
 * With only the context metric shown — the default — this renders exactly as it
 * always did (`🔥🔥 74%`), so labels only appear once there is something to tell
 * apart. The glyph sits at the front because it represents the overall
 * temperature, which under `heatFrom: hottest` may not be the context number.
 */
export function formatStatusText(
  glyph: string,
  metrics: Metric[],
  showPercentage: boolean,
  suffix: string
): string {
  if (metrics.length === 0 || !showPercentage) {
    return `${glyph}${suffix}`;
  }
  if (metrics.length === 1 && metrics[0].key === 'context') {
    return `${glyph} ${Math.round(metrics[0].percentage)}%${suffix}`;
  }
  const parts = metrics.map((m) => `${m.short} ${Math.round(m.percentage)}%`);
  return `${glyph} ${parts.join(' · ')}${suffix}`;
}

/** "1h 23m", "4m", or null when there is nothing sensible to say. */
export function formatResetIn(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null) {
    return null;
  }
  const seconds = Math.round(resetsAt - nowMs / 1000);
  if (seconds <= 0) {
    return 'due';
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(1, minutes)}m`;
}

export function normalizeShow(raw: unknown): MetricKey[] {
  const list = Array.isArray(raw) ? raw : [];
  const picked = METRIC_KEYS.filter((k) => list.includes(k));
  // Showing nothing would leave an unexplained glyph in the status bar.
  return picked.length ? picked : ['context'];
}
