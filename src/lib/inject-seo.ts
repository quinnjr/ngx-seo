import {
  ApplicationRef,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  assertInInjectionContext,
  inject,
} from '@angular/core';
import { ActivatedRoute, Route, Router } from '@angular/router';
import { Seo } from './seo.service';
import type { SeoConfig, SeoHandle } from './types';

export interface InjectSeoOptions {
  /** Higher wins. Ties resolve by creation order. Default 0. */
  priority?: number;
}

type InternalRoute = Route & { _injector?: unknown; _loadedInjector?: unknown; _loadedRoutes?: Route[] };

/**
 * The route config whose injector is `injector`: a route's `providers`, or a
 * lazily loaded route's injector. Null for any other injector.
 */
function routeConfigFor(router: Router | null, injector: EnvironmentInjector, root: EnvironmentInjector): Route | null {
  if (router === null || injector === root) {
    return null;
  }
  const search = (routes: readonly Route[] | undefined): Route | null => {
    for (const route of (routes ?? []) as InternalRoute[]) {
      if (route._injector === injector || route._loadedInjector === injector) {
        return route;
      }
      const found = search(route.children) ?? search(route._loadedRoutes);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return search(router.config);
}

/**
 * Contributes SEO data for the life of the surrounding component or service.
 * Pass a function to re-evaluate whenever the signals it reads change.
 *
 * The contribution applies only while its route is attached: a component's own
 * route, or the route that provides the service.
 */
export function injectSeo(config: SeoConfig | (() => SeoConfig), options: InjectSeoOptions = {}): SeoHandle {
  assertInInjectionContext(injectSeo);
  const seo = inject(Seo);
  // Components belong to their own route. Services resolve ActivatedRoute to
  // the root route, so a service from a route's providers is bound to that
  // route's config instead (its injector is never destroyed).
  const host = inject(ElementRef, { optional: true });
  const inComponent = host !== null;
  const route = inComponent
    ? inject(ActivatedRoute, { optional: true })
    : (routeConfigFor(
        inject(Router, { optional: true }),
        inject(EnvironmentInjector),
        inject(ApplicationRef).injector,
      ) ?? inject(ActivatedRoute, { optional: true }));
  return seo.contribute(config, {
    priority: options.priority,
    destroyRef: inject(DestroyRef),
    route,
    // Duck-typed: `instanceof` fails across realms (iframes, test DOMs).
    host: typeof (host?.nativeElement as Element | undefined)?.getAttribute === 'function' ? (host?.nativeElement as Element) : null,
  });
}
