/**
 * The temperature scale. Everything visual in the extension derives from here.
 *
 * The scale is deliberately front-loaded: full fire arrives at 70%, not 90%.
 * By the time you are at 70% of a context window you already want to be
 * thinking about wrapping up, so that is where the normal maximum sits.
 * `critical` and `meltdown` exist above it as genuine escalation — states you
 * should rarely see, which is what makes them mean something when you do.
 */

export type BandName =
  | 'cold'
  | 'warm'
  | 'toasty'
  | 'hot'
  | 'blazing'
  | 'critical'
  | 'meltdown';

export interface Band {
  name: BandName;
  /** Status bar frames. More than one frame means it flickers. */
  frames: string[];
  /** How fast those frames cycle. Lower is more frantic. */
  flickerMs: number;
  /** Suffix after the percentage, for the states that warrant a shout. */
  suffix: string;
  /** Hex colors, keyed by the surface they tint. */
  colors: {
    chrome?: string;
    chromeText?: string;
    border?: string;
  };
  /** statusBarItem.warningBackground / errorBackground are the only two allowed. */
  itemBackground?: 'warning' | 'error';
  blurb: string;
}

export const BANDS: Record<BandName, Band> = {
  cold: {
    name: 'cold',
    frames: ['$(circle-filled)'],
    flickerMs: 0,
    suffix: '',
    colors: {},
    blurb: 'plenty of room',
  },
  warm: {
    name: 'warm',
    frames: ['$(thermometer)'],
    flickerMs: 0,
    suffix: '',
    colors: { chrome: '#3d2f18', chromeText: '#e8d5b0', border: '#7a6230' },
    blurb: 'warming up',
  },
  toasty: {
    name: 'toasty',
    frames: ['🔥'],
    flickerMs: 0,
    suffix: '',
    colors: { chrome: '#6b3f14', chromeText: '#f5dcb8', border: '#c2701d' },
    blurb: 'getting toasty',
  },
  hot: {
    name: 'hot',
    frames: ['🔥🔥', '🔥 🔥'],
    flickerMs: 900,
    suffix: '',
    colors: { chrome: '#8a3d10', chromeText: '#ffe4c4', border: '#e06010' },
    itemBackground: 'warning',
    blurb: 'hot — start thinking about wrapping up',
  },
  /** The normal maximum. Full fire, every surface lit. */
  blazing: {
    name: 'blazing',
    frames: ['🔥🔥🔥', '🔥🔥 🔥', '🔥 🔥🔥'],
    flickerMs: 650,
    suffix: '',
    colors: { chrome: '#a32a08', chromeText: '#fff0e4', border: '#ff5a08' },
    itemBackground: 'error',
    blurb: 'on fire — wrap up or /compact',
  },
  /** Past the normal maximum. Worse on purpose. */
  critical: {
    name: 'critical',
    frames: ['🔥🔥🔥', '🔥🔥🔥', '💥🔥🔥', '🔥🔥💥'],
    flickerMs: 420,
    suffix: '  COMPACT',
    colors: { chrome: '#c01705', chromeText: '#fff6f0', border: '#ff3b00' },
    itemBackground: 'error',
    blurb: 'critical — compact now',
  },
  /** The end of the scale. Should be rare enough to be alarming. */
  meltdown: {
    name: 'meltdown',
    frames: ['🔥🔥🔥', '💥💥💥', '🔥💥🔥', '💥🔥💥'],
    flickerMs: 240,
    suffix: '  MELTDOWN',
    colors: { chrome: '#e00000', chromeText: '#ffffff', border: '#ff1a00' },
    itemBackground: 'error',
    blurb: 'MELTDOWN — out of room',
  },
};

/** Order matters: we walk this backwards to find the first threshold cleared. */
export const BAND_ORDER: BandName[] = [
  'cold',
  'warm',
  'toasty',
  'hot',
  'blazing',
  'critical',
  'meltdown',
];

export type HeatBandName = Exclude<BandName, 'cold'>;
export type Thresholds = Record<HeatBandName, number>;

/**
 * `blazing` at 70 is the load-bearing number: that is "on fire", the normal top
 * of the scale. Everything below it is spaced to arrive there smoothly; the two
 * above it are escalation.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  warm: 25,
  toasty: 45,
  hot: 60,
  blazing: 70,
  critical: 80,
  meltdown: 98,
};

/**
 * Thresholds come from user config, so they can arrive partial or out of order.
 *
 * The bands must stay monotonic or one becomes unreachable, but we fix that by
 * moving the values the user did *not* set. Clamping their explicit value up to
 * an adjacent default would silently ignore what they asked for: setting
 * `blazing: 55` has to actually move `blazing` to 55, pulling the default `hot`
 * and `toasty` down with it. Only a user-vs-user conflict falls back to forcing
 * order.
 */
export function normalizeThresholds(
  raw: Partial<Thresholds> | undefined,
  explicitKeys?: readonly string[]
): Thresholds {
  const names = BAND_ORDER.slice(1) as HeatBandName[];
  const explicit = new Set(explicitKeys ?? Object.keys(raw ?? {}));

  const values = names.map((name) => {
    const v = Number((raw ?? {})[name]);
    const usable = Number.isFinite(v);
    return {
      name,
      value: usable ? Math.max(0, Math.min(100, v)) : DEFAULT_THRESHOLDS[name],
      explicit: usable && explicit.has(name),
    };
  });

  // Pull defaults down to make room for a lower explicit value below them.
  for (let i = values.length - 2; i >= 0; i--) {
    if (!values[i].explicit && values[i].value > values[i + 1].value) {
      values[i].value = values[i + 1].value;
    }
  }
  // Push defaults up past a higher explicit value below them.
  for (let i = 1; i < values.length; i++) {
    if (!values[i].explicit && values[i].value < values[i - 1].value) {
      values[i].value = values[i - 1].value;
    }
  }
  // Anything still out of order is user-vs-user; force it.
  for (let i = 1; i < values.length; i++) {
    if (values[i].value < values[i - 1].value) {
      values[i].value = values[i - 1].value;
    }
  }

  const out = {} as Thresholds;
  for (const { name, value } of values) {
    out[name] = value;
  }
  return out;
}

export function bandFor(percentage: number, thresholds: Thresholds): Band {
  for (let i = BAND_ORDER.length - 1; i >= 1; i--) {
    const name = BAND_ORDER[i] as HeatBandName;
    if (percentage >= thresholds[name]) {
      return BANDS[name];
    }
  }
  return BANDS.cold;
}
