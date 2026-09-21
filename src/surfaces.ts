import { Band, BAND_ORDER, BANDS } from './bands';

/**
 * VS Code has no gradient in `workbench.colorCustomizations` — every theme key
 * is one flat colour. But the chrome is physically stacked, so ramping
 * intensity down that stack reads as one: faint at the title bar, full strength
 * at the status bar, which is the direction fire actually burns.
 *
 * The ramp is expressed as alpha rather than a pre-mixed colour because an
 * 8-digit hex composites over whatever the active theme already draws. A fixed
 * blend would have to assume a dark background and would look wrong on a light
 * theme.
 */

export type Customizations = Record<string, unknown>;

export type Surface =
  | 'titleBar'
  | 'tabs'
  | 'sideBar'
  | 'activityBar'
  | 'panel'
  | 'statusBar'
  | 'windowBorder';

export interface SurfaceSpec {
  /** 0 at the top of the window, 1 at the bottom. Drives the ramp. */
  depth: number;
  /** Theme keys that take the tinted background. */
  background: string[];
  /** Theme keys that take the contrasting foreground, when it is safe to set. */
  foreground: string[];
}

export const SURFACES: Record<Surface, SurfaceSpec> = {
  titleBar: {
    depth: 0,
    background: ['titleBar.activeBackground', 'titleBar.inactiveBackground'],
    foreground: ['titleBar.activeForeground', 'titleBar.inactiveForeground'],
  },
  tabs: {
    depth: 0.25,
    background: ['editorGroupHeader.tabsBackground', 'tab.inactiveBackground'],
    foreground: [],
  },
  sideBar: {
    depth: 0.45,
    background: ['sideBar.background', 'sideBarSectionHeader.background'],
    foreground: [],
  },
  activityBar: {
    depth: 0.55,
    background: ['activityBar.background'],
    foreground: ['activityBar.foreground'],
  },
  panel: {
    depth: 0.8,
    background: ['panel.background'],
    foreground: [],
  },
  statusBar: {
    depth: 1,
    background: ['statusBar.background'],
    foreground: ['statusBar.foreground'],
  },
  // The border wraps the whole window, so it has no single depth. It takes full
  // strength: it is the outline of the fire, not part of the ramp.
  windowBorder: {
    depth: 1,
    background: ['window.activeBorder', 'window.inactiveBorder'],
    foreground: [],
  },
};

export const ALL_SURFACES = Object.keys(SURFACES) as Surface[];

/** Every key any surface can write. Order is stable for test readability. */
export const OWNED_KEYS: string[] = ALL_SURFACES.flatMap((s) => [
  ...SURFACES[s].background,
  ...SURFACES[s].foreground,
]);

/**
 * Alpha for a surface, 0..1.
 *
 * The floor is deliberately well above zero: the top of the window should read
 * as "touched by the heat", not as untouched. Without a floor the title bar
 * simply vanishes from the effect and the window looks half-painted.
 */
const MIN_ALPHA = 0.3;

export function alphaFor(surface: Surface, gradient: boolean): number {
  if (!gradient) {
    return 1;
  }
  const { depth } = SURFACES[surface];
  return MIN_ALPHA + (1 - MIN_ALPHA) * depth;
}

function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return hex;
  }
  const clamped = Math.max(0, Math.min(1, alpha));
  if (clamped >= 1) {
    return hex;
  }
  return hex + Math.round(clamped * 255).toString(16).padStart(2, '0');
}

/**
 * Whether it is safe to force a foreground colour on this surface.
 *
 * At low alpha the tint is a wash over the theme's own background, so the
 * theme's own foreground still contrasts correctly — on light and dark alike.
 * Overriding it there is how you get dark-on-dark text.
 */
function shouldSetForeground(alpha: number): boolean {
  return alpha >= 0.75;
}

/**
 * The base colours this extension paints with, alpha stripped.
 *
 * Owning a *key* is not the same as having written it — people set
 * `titleBar.activeBackground` by hand, and deleting that on deactivate would be
 * a nasty way to repay them for installing this. So we only remove an entry
 * whose colour is one of ours.
 *
 * Matching ignores the alpha suffix on purpose. An earlier build wrote
 * `#e8d5b0aa` where this one writes `#e8d5b0b3`; exact-value matching stranded
 * that key on the user's settings permanently, and every future change to the
 * ramp would strand more. The base colour is the stable part.
 */
let ourColorsCache: Set<string> | null = null;
function ourColors(): Set<string> {
  if (!ourColorsCache) {
    ourColorsCache = new Set<string>();
    for (const name of BAND_ORDER) {
      const { chrome, chromeText, border } = BANDS[name].colors;
      for (const value of [chrome, chromeText, border]) {
        if (value) {
          ourColorsCache.add(value.toLowerCase());
        }
      }
    }
  }
  return ourColorsCache;
}

export function isOurs(key: string, value: unknown): boolean {
  if (!OWNED_KEYS.includes(key)) {
    return false;
  }
  const base = /^#[0-9a-f]{6}/.exec(String(value).toLowerCase());
  return base !== null && ourColors().has(base[0]);
}

/** Everything in `existing` that this extension did not put there. */
export function preserveForeign(existing: Customizations): Customizations {
  const out: Customizations = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!isOurs(k, v)) {
      out[k] = v;
    }
  }
  return out;
}

export function paletteFor(
  band: Band,
  surfaces: Surface[],
  gradient: boolean
): Customizations {
  const { chrome, chromeText, border } = band.colors;
  if (!chrome) {
    return {};
  }
  const out: Customizations = {};

  for (const surface of ALL_SURFACES) {
    if (!surfaces.includes(surface)) {
      continue;
    }
    const spec = SURFACES[surface];
    const alpha = alphaFor(surface, gradient);
    // The border is a line, not a fill: it reads as the shape of the window, so
    // it uses the band's brighter accent rather than the chrome tint.
    const base = surface === 'windowBorder' ? (border ?? chrome) : chrome;

    for (const key of spec.background) {
      // Inactive variants sit one step back so an unfocused window is calmer.
      const inactive = key.includes('inactive');
      out[key] = withAlpha(base, alpha * (inactive ? 0.8 : 1));
    }
    if (shouldSetForeground(alpha) && chromeText) {
      for (const key of spec.foreground) {
        out[key] = key.includes('inactive') ? withAlpha(chromeText, 0.7) : chromeText;
      }
    }
  }
  return out;
}

export function normalizeSurfaces(raw: unknown): Surface[] {
  const list = Array.isArray(raw) ? raw : [];
  return ALL_SURFACES.filter((s) => list.includes(s));
}
