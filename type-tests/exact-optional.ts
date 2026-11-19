// Compiled with exactOptionalPropertyTypes (tsconfig.exact.json): an explicit
// `undefined` must be accepted wherever a field is optional ("no opinion").
import { injectSeo, provideSeo, type SeoConfig, type SeoSiteConfig } from '../src/public-api';

declare const post: { image?: string; alt?: string; excerpt?: string; tags?: string[] };
declare const env: { baseUrl?: string };

export const config: SeoConfig = {
  title: undefined,
  description: post.excerpt,
  image: post.image ? { url: post.image, alt: post.alt } : undefined,
  openGraph: { title: undefined, article: { tags: post.tags, section: undefined } },
  twitter: { creator: undefined },
  robots: { index: undefined },
  http: { status: undefined },
};

export const site: SeoSiteConfig = { baseUrl: env.baseUrl, siteName: undefined, defaults: config };

export function setup(): void {
  provideSeo({ baseUrl: env.baseUrl });
  injectSeo(() => ({ description: post.excerpt }), { priority: undefined, key: undefined });
}
