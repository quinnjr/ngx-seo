import { EnvironmentProviders, inject, makeEnvironmentProviders, provideEnvironmentInitializer } from '@angular/core';
import { TitleStrategy } from '@angular/router';
import { SeoTitleStrategy } from './title-strategy';
import { Seo } from './seo.service';
import { SEO_SITE_CONFIG } from './tokens';
import type { SeoSiteConfig } from './types';

/** Registers ngx-seo with site-wide configuration. */
export function provideSeo(config: SeoSiteConfig = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: SEO_SITE_CONFIG, useValue: config },
    { provide: TitleStrategy, useClass: SeoTitleStrategy },
    provideEnvironmentInitializer(() => {
      inject(Seo);
    }),
  ]);
}
