import { Injector, runInInjectionContext } from '@angular/core';
import { ActivatedRouteSnapshot, PRIMARY_OUTLET } from '@angular/router';
import type { SeoConfig } from './types';

/** True when the route declares the value itself, rather than Angular inheriting it from the parent. */
function declaresOwn(snapshot: ActivatedRouteSnapshot, key: string): boolean {
  const config = snapshot.routeConfig;
  if (config === null) {
    return false;
  }
  return (config.data !== undefined && key in config.data) || (config.resolve !== undefined && key in config.resolve);
}

function isAsync(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { then?: unknown; subscribe?: unknown };
  return typeof candidate.then === 'function' || typeof candidate.subscribe === 'function';
}

/**
 * Collects SEO layers from the primary route chain, root to leaf; routes in
 * named outlets never contribute. A route's own `title` sits just beneath
 * that route's SEO value. A value Angular inherited into a child is used
 * once; a value a route declares itself is always used, even if an ancestor
 * used the same object. Function values are called with the snapshot in an
 * injection context; one that throws or returns a promise is reported and
 * skipped.
 */
export function collectRouteLayers(
  root: ActivatedRouteSnapshot,
  key: string,
  injector: Injector,
  onError: (error: unknown) => void,
  includeTitles = true,
): SeoConfig[] {
  const layers: SeoConfig[] = [];
  let parentValue: unknown = undefined;
  let snapshot: ActivatedRouteSnapshot | null = root;
  while (snapshot !== null) {
    // Only a title the route declares itself; inherited titles are already counted.
    if (includeTitles && snapshot.routeConfig?.title !== undefined && typeof snapshot.title === 'string') {
      layers.push({ title: snapshot.title });
    }
    const value: unknown = snapshot.data?.[key];
    const inherited = value === parentValue && !declaresOwn(snapshot, key);
    if (value !== undefined && value !== null && !inherited) {
      const current: ActivatedRouteSnapshot = snapshot;
      try {
        const config =
          typeof value === 'function'
            ? runInInjectionContext(injector, () => (value as (route: ActivatedRouteSnapshot) => SeoConfig)(current))
            : (value as SeoConfig);
        if (isAsync(config)) {
          onError(
            new Error(
              'ngx-seo: a route seo function returned a promise or observable, which is ignored. ' +
                'Use a resolver (resolve: { seo: … }) for asynchronous SEO data.',
            ),
          );
        } else if (config && typeof config === 'object') {
          layers.push(config);
        }
      } catch (error) {
        onError(error);
      }
    }
    parentValue = value;
    snapshot = snapshot.children.find((child) => child.outlet === PRIMARY_OUTLET) ?? null;
  }
  return layers;
}
