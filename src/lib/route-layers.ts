import { Injector, runInInjectionContext } from '@angular/core';
import { ActivatedRouteSnapshot } from '@angular/router';
import type { SeoConfig } from './types';

/**
 * Collects SEO layers from the primary route chain, root to leaf. A value
 * Angular has inherited into a child snapshot is used once. Function values
 * are called with the snapshot in an injection context; one that throws is
 * reported and skipped.
 */
export function collectRouteLayers(
  root: ActivatedRouteSnapshot,
  key: string,
  injector: Injector,
  onError: (error: unknown) => void,
): SeoConfig[] {
  const layers: SeoConfig[] = [];
  const seen = new Set<unknown>();
  let snapshot: ActivatedRouteSnapshot | null = root;
  while (snapshot !== null) {
    const value: unknown = snapshot.data?.[key];
    if (value !== undefined && value !== null && !seen.has(value)) {
      seen.add(value);
      const current: ActivatedRouteSnapshot = snapshot;
      try {
        const config =
          typeof value === 'function'
            ? runInInjectionContext(injector, () => (value as (route: ActivatedRouteSnapshot) => SeoConfig)(current))
            : (value as SeoConfig);
        if (config && typeof config === 'object') {
          layers.push(config);
        }
      } catch (error) {
        onError(error);
      }
    }
    snapshot = snapshot.firstChild;
  }
  return layers;
}
