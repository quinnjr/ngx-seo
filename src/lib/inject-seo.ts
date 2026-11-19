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
  priority?: number | undefined;
  /**
   * A stable identity for a contribution from a route's service, the same on
   * server and browser. Only needed for incremental hydration when one route
   * has several service contributions whose configs differ between the two.
   */
  key?: string | undefined;
}

type InternalRoute = Route & { _injector?: unknown | undefined; _loadedInjector?: unknown | undefined; _loadedRoutes?: Route[] | undefined };

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
  const host = inject(ElementRef, { optional: true });
  const inComponent = host !== null;
  const environment = inject(EnvironmentInjector);
  const rootInjector = inject(ApplicationRef).injector;
  const isRootService = !inComponent && environment === rootInjector;
  // Components belong to their own route, root services to none (the root
  // route). A service in another injector belongs to a route: its config if
  // the router already records it, otherwise the Seo service resolves it from
  // the injector when the contribution is evaluated (the route's injector may
  // still be under construction, or the service may come from a module that
  // a standalone page imports).
  const routeConfig =
    inComponent || isRootService ? null : routeConfigFor(inject(Router, { optional: true }), environment, rootInjector);
  const route = inComponent || isRootService ? inject(ActivatedRoute, { optional: true }) : routeConfig;
  return seo.contribute(config, {
    priority: options.priority,
    key: options.key,
    destroyRef: inject(DestroyRef),
    route,
    injector: inComponent || isRootService || routeConfig !== null ? null : environment,
    // Duck-typed: `instanceof` fails across realms (iframes, test DOMs).
    host: typeof (host?.nativeElement as Element | undefined)?.getAttribute === 'function' ? (host?.nativeElement as Element) : null,
  });
}
