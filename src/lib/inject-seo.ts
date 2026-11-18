import { DestroyRef, assertInInjectionContext, inject } from '@angular/core';
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
  return inject(Seo).contribute(config, { priority: options.priority, destroyRef: inject(DestroyRef) });
}
