import type { ActivatedRouteSnapshot } from '@angular/router';

/** Marks one inherited keyed-list item for removal. Create with `removeItem(key)`. */
export interface SeoRemoval {
  $remove: string;
}

/** A schema.org node. Objects typed with `schema-dts` are structurally compatible. */
export interface JsonLdNode {
  '@type': string | string[];
  '@id'?: string;
  [key: string]: unknown;
}

export interface SeoImage {
  url: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  type?: string | null;
}

export interface SeoMedia {
  url: string;
  type?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface RobotsDirectives {
  index?: boolean | null;
  follow?: boolean | null;
  noarchive?: boolean | null;
  nosnippet?: boolean | null;
  noimageindex?: boolean | null;
  notranslate?: boolean | null;
  maxSnippet?: number | null;
  maxImagePreview?: 'none' | 'standard' | 'large' | null;
  maxVideoPreview?: number | null;
  unavailableAfter?: Date | string | null;
}

export interface OpenGraphArticle {
  publishedTime?: Date | string | null;
  modifiedTime?: Date | string | null;
  expirationTime?: Date | string | null;
  authors?: string[] | null;
  section?: string | null;
  tags?: string[] | null;
}

export interface OpenGraphProfile {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  gender?: string | null;
}

export interface OpenGraphBook {
  authors?: string[] | null;
  isbn?: string | null;
  releaseDate?: Date | string | null;
  tags?: string[] | null;
}

export interface OpenGraphConfig {
  title?: string | null;
  description?: string | null;
  type?: string | null;
  url?: string | null;
  siteName?: string | null;
  locale?: string | null;
  alternateLocales?: string[] | null;
  images?: (SeoImage | SeoRemoval)[] | null;
  videos?: SeoMedia[] | null;
  audio?: SeoMedia[] | null;
  article?: OpenGraphArticle | null;
  profile?: OpenGraphProfile | null;
  book?: OpenGraphBook | null;
}

export interface TwitterConfig {
  card?: 'summary' | 'summary_large_image' | 'app' | 'player' | null;
  site?: string | null;
  creator?: string | null;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  imageAlt?: string | null;
}

export interface SeoAlternate {
  hreflang: string;
  href: string;
}

interface SeoMetaBase {
  content: string;
  /** Identity for merging. Defaults to the name / property / httpEquiv value. */
  key?: string;
}

/** An extra meta tag, identified by exactly one of `name`, `property` or `httpEquiv`. */
export type SeoMetaTag =
  | (SeoMetaBase & { name: string; property?: never; httpEquiv?: never })
  | (SeoMetaBase & { property: string; name?: never; httpEquiv?: never })
  | (SeoMetaBase & { httpEquiv: string; name?: never; property?: never });

export interface SeoLinkTag {
  rel: string;
  href: string;
  hreflang?: string;
  type?: string;
  media?: string;
  sizes?: string;
  title?: string;
  /** Identity for merging. Defaults to `rel|href`. */
  key?: string;
}

export interface SeoHttp {
  status?: number | null;
  headers?: Record<string, string | null> | null;
}

/** Information handed to title-template and defaults functions. */
export interface SeoContext {
  /** Current path including query string, e.g. `/blog/post?page=2`. */
  url: string;
  canonical: string | null;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

export type TitleTemplate = string | ((title: string, ctx: SeoContext) => string);

/**
 * One layer of SEO data. Every field is optional: `undefined` means "no
 * opinion", `null` means "remove what a lower layer set".
 */
export interface SeoConfig {
  title?: string | null;
  titleTemplate?: TitleTemplate | false | null;
  description?: string | null;
  keywords?: string[] | string | null;
  author?: string | null;
  lang?: string | null;
  dir?: 'ltr' | 'rtl' | 'auto' | null;
  /** Absolute or relative URL. `false` emits no canonical. */
  canonical?: string | false | null;
  robots?: RobotsDirectives | string | null;
  /** Per-crawler robots meta, keyed by crawler name (e.g. `googlebot`). */
  bots?: Record<string, RobotsDirectives | string | null> | null;
  alternates?: (SeoAlternate | SeoRemoval)[] | null;
  /** Shorthand feeding Open Graph and Twitter. */
  image?: string | SeoImage | null;
  openGraph?: OpenGraphConfig | null;
  twitter?: TwitterConfig | null;
  jsonLd?: (JsonLdNode | SeoRemoval)[] | null;
  meta?: (SeoMetaTag | SeoRemoval)[] | null;
  links?: (SeoLinkTag | SeoRemoval)[] | null;
  /** Server response control. Ignored in the browser. */
  http?: SeoHttp | null;
}

export type SeoDefaults = SeoConfig | ((ctx: SeoContext) => SeoConfig);

export interface SeoCanonicalPolicy {
  trailingSlash?: 'preserve' | 'always' | 'never';
  /** Query parameters kept in the derived canonical. Default: none. */
  keepQueryParams?: readonly string[];
}

export interface SeoSiteConfig {
  siteName?: string;
  /** Origin used to make URLs absolute, e.g. `https://example.com`. */
  baseUrl?: string;
  titleTemplate?: TitleTemplate;
  /** Title used when no layer sets one. Not passed through the template. */
  defaultTitle?: string;
  canonical?: SeoCanonicalPolicy;
  /** The lowest-priority layer. */
  defaults?: SeoDefaults;
  /** Route data key to read. Default `'seo'`. */
  routeDataKey?: string;
  /** Dev-mode warnings. Default `'warn'`. Always off in production. */
  diagnostics?: 'warn' | 'off';
}

/** A route data value: a config, or a function called in an injection context. */
export type RouteSeo<TRoute = ActivatedRouteSnapshot> = SeoConfig | ((route: TRoute) => SeoConfig);

export interface HeadTag {
  key: string;
  tag: 'meta' | 'link' | 'script';
  attrs: Record<string, string>;
  text?: string;
}

/** The fully derived head for the current page. */
export interface ResolvedHead {
  title: string | null;
  htmlAttrs: { lang?: string; dir?: string };
  tags: HeadTag[];
  http: { status?: number; headers: Record<string, string> };
  canonical: string | null;
  robots: string | null;
  /** Fields whose URL value was dropped because it could not be made absolute. */
  droppedUrls: string[];
}

export interface SeoHandle {
  /** Replace this contribution's config. */
  set(config: SeoConfig): void;
  /** Merge fields into this contribution's config. */
  patch(partial: SeoConfig): void;
  /** Empty this contribution without removing it. */
  clear(): void;
  /** Remove this contribution for good. Later calls on the handle do nothing. */
  destroy(): void;
}
