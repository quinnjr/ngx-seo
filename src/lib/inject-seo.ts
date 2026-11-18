import { DestroyRef, ElementRef, EnvironmentInjector, assertInInjectionContext, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Seo } from './seo.service';
import type { SeoConfig, SeoHandle } from './types';

export interface InjectSeoOptions {
  /** Higher wins. Ties resolve by creation order. Default 0. */
  priority?: number;
}

/**
 * Contributes SEO data for the life of the surrounding component or service.
 * Pass a function to re-evaluate whenever the signals it reads change.
 */
export function injectSeo(config: SeoConfig | (() => SeoConfig), options: InjectSeoOptions = {}): SeoHandle {
  assertInInjectionContext(injectSeo);
  const seo = inject(Seo);
  // Components belong to their own route. Services resolve ActivatedRoute to
  // the root route, so a service from a route's providers is bound to that
  // route instead (its injector is never destroyed).
  const inComponent = inject(ElementRef, { optional: true }) !== null;
  const route = inComponent
    ? inject(ActivatedRoute, { optional: true })
    : (seo.routeForInjector(inject(EnvironmentInjector)) ?? inject(ActivatedRoute, { optional: true }));
  return seo.contribute(config, {
    priority: options.priority,
    destroyRef: inject(DestroyRef),
    route,
  });
}
