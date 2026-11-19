import { InjectionToken } from '@angular/core';
import type { SeoSiteConfig } from './types';

/** Site-wide configuration given to `provideSeo()`. */
export const SEO_SITE_CONFIG = new InjectionToken<SeoSiteConfig>('SEO_SITE_CONFIG');
