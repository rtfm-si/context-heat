import * as vscode from 'vscode';
import { Band } from './bands';
import { paletteFor, preserveForeign, Surface } from './surfaces';

export type { Surface } from './surfaces';

export type ColorScope = 'workspace' | 'global' | 'off';

const SECTION = 'workbench';
const KEY = 'colorCustomizations';

type Customizations = Record<string, unknown>;

function sameShallow(a: Customizations | undefined, b: Customizations | undefined): boolean {
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) {
    return false;
  }
  return ka.every((k) => (a as Customizations)[k] === (b as Customizations)[k]);
}

function targetFor(scope: ColorScope): vscode.ConfigurationTarget {
  return scope === 'global'
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;
}

/**
 * Read the value stored *at this scope only*. `get()` returns the merged
 * effective value, so using it would silently copy the user's global
 * customizations down into their workspace file on the first write.
 */
function currentAtScope(scope: ColorScope): Customizations {
  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<Customizations>(KEY);
  const raw =
    scope === 'global' ? inspected?.globalValue : inspected?.workspaceValue;
  return raw && typeof raw === 'object' ? { ...raw } : {};
}

export class ColorPainter {
  private lastWritten: string | null = null;
  /** Scopes we have actually written to, so cleanup touches nothing else. */
  private painted = new Set<ColorScope>();

  /** Returns true if it actually wrote to settings. */
  async apply(
    band: Band,
    scope: ColorScope,
    surfaces: Surface[],
    gradient: boolean
  ): Promise<boolean> {
    if (scope === 'off') {
      return this.clear(scope);
    }
    if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
      // Nowhere to write a workspace setting; stay out of the user's config.
      return false;
    }

    const signature = `${scope}|${band.name}|${gradient}|${surfaces.slice().sort().join(',')}`;
    if (this.lastWritten === signature) {
      return false;
    }

    const existing = currentAtScope(scope);
    const next = { ...preserveForeign(existing), ...paletteFor(band, surfaces, gradient) };

    if (sameShallow(existing, next)) {
      this.lastWritten = signature;
      return false;
    }

    const value = Object.keys(next).length ? next : undefined;
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(KEY, value, targetFor(scope));
    this.painted.add(scope);
    this.lastWritten = signature;
    return true;
  }

  /**
   * Remove only the entries we wrote, leaving anything the user set by hand
   * intact. Defaults to the scopes this painter actually touched: on shutdown
   * we must not go rummaging through a scope we never painted.
   */
  async clear(scope?: ColorScope): Promise<boolean> {
    this.lastWritten = null;
    const scopes: ColorScope[] =
      scope === undefined
        ? [...this.painted]
        : scope === 'off'
          ? ['workspace', 'global']
          : [scope];

    let wrote = false;
    for (const s of scopes) {
      if (s === 'off') {
        continue;
      }
      if (s === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
        continue;
      }
      const existing = currentAtScope(s);
      const preserved = preserveForeign(existing);
      if (sameShallow(existing, preserved)) {
        this.painted.delete(s);
        continue;
      }
      await vscode.workspace
        .getConfiguration(SECTION)
        .update(KEY, Object.keys(preserved).length ? preserved : undefined, targetFor(s));
      this.painted.delete(s);
      wrote = true;
    }
    return wrote;
  }
}
