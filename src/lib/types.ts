import type { ActivatedRouteSnapshot } from '@angular/router';

/** Marks one inherited keyed-list item for removal. Create with `removeItem(key)`. */
export interface SeoRemoval {
  $remove: string;
}

/** A schema.org node. Objects typed with `schema-dts` are structurally compatible. */
export interface JsonLdNode {
  '@type': string | readonly string[];
  '@id'?: string | undefined;
  // `any`, not `unknown`: interface-based node types (e.g. schema-dts) only satisfy an `any` index signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface SeoImage {
  url: string;
  alt?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  type?: string | null | undefined;
}

export interface SeoMedia {
  url: string;
  type?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
}

export interface RobotsDirectives {
  index?: boolean | null | undefined;
  follow?: boolean | null | undefined;
  noarchive?: boolean | null | undefined;
  nosnippet?: boolean | null | undefined;
  noimageindex?: boolean | null | undefined;
  notranslate?: boolean | null | undefined;
  maxSnippet?: number | null | undefined;
  maxImagePreview?: 'none' | 'standard' | 'large' | null | undefined;
  maxVideoPreview?: number | null | undefined;
  unavailableAfter?: Date | string | null | undefined;
}

export interface OpenGraphArticle {
  publishedTime?: Date | string | null | undefined;
  modifiedTime?: Date | string | null | undefined;
  expirationTime?: Date | string | null | undefined;
  authors?: readonly string[] | null | undefined;
  section?: string | null | undefined;
  tags?: readonly string[] | null | undefined;
}

export interface OpenGraphProfile {
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  username?: string | null | undefined;
  gender?: string | null | undefined;
}

export interface OpenGraphBook {
  authors?: readonly string[] | null | undefined;
  isbn?: string | null | undefined;
  releaseDate?: Date | string | null | undefined;
  tags?: readonly string[] | null | undefined;
}

export interface OpenGraphConfig {
  title?: string | null | undefined;
  description?: string | null | undefined;
  type?: string | null | undefined;
  url?: string | null | undefined;
  siteName?: string | null | undefined;
  locale?: string | null | undefined;
  alternateLocales?: readonly string[] | null | undefined;
  images?: readonly (SeoImage | SeoRemoval)[] | null | undefined;
  videos?: readonly SeoMedia[] | null | undefined;
  audio?: readonly SeoMedia[] | null | undefined;
  article?: OpenGraphArticle | null | undefined;
  profile?: OpenGraphProfile | null | undefined;
  book?: OpenGraphBook | null | undefined;
}

export interface TwitterConfig {
  card?: 'summary' | 'summary_large_image' | 'app' | 'player' | null | undefined;
  site?: string | null | undefined;
  creator?: string | null | undefined;
  title?: string | null | undefined;
  description?: string | null | undefined;
  image?: string | null | undefined;
  imageAlt?: string | null | undefined;
}

export interface SeoAlternate {
  hreflang: string;
  href: string;
}

interface SeoMetaBase {
  content: string;
  /** Media query, e.g. for light and dark `theme-color` variants. Part of the tag's identity. */
  media?: string | undefined;
  /** Identity for merging. Defaults to the name / property / httpEquiv value. */
  key?: string | undefined;
}

/** An extra meta tag, identified by exactly one of `name`, `property` or `httpEquiv`. */
export type SeoMetaTag =
  | (SeoMetaBase & { name: string; property?: never | undefined; httpEquiv?: never | undefined })
  | (SeoMetaBase & { property: string; name?: never | undefined; httpEquiv?: never | undefined })
  | (SeoMetaBase & { httpEquiv: string; name?: never | undefined; property?: never | undefined });

export interface SeoLinkTag {
  rel: string;
  href: string;
  hreflang?: string | undefined;
  type?: string | undefined;
  media?: string | undefined;
  sizes?: string | undefined;
  title?: string | undefined;
  /** Required by browsers for `rel="preload"`, e.g. `'font'`, `'script'`. */
  as?: string | undefined;
  /** `''` or `'anonymous'`, or `'use-credentials'`. Needed for font preloads and some preconnects. */
  crossorigin?: string | undefined;
  fetchpriority?: 'high' | 'low' | 'auto' | undefined;
  referrerpolicy?: string | undefined;
  /** For `rel="mask-icon"`. */
  color?: string | undefined;
  /** Identity for merging. Defaults to `rel|href`. */
  key?: string | undefined;
}

export interface SeoHttp {
  status?: number | null | undefined;
  headers?: Record<string, string | null> | null | undefined;
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
  title?: string | null | undefined;
  titleTemplate?: TitleTemplate | false | null | undefined;
  description?: string | null | undefined;
  keywords?: readonly string[] | string | null | undefined;
  author?: string | null | undefined;
  lang?: string | null | undefined;
  dir?: 'ltr' | 'rtl' | 'auto' | null | undefined;
  /** Absolute or relative URL. `false` emits no canonical. */
  canonical?: string | false | null | undefined;
  robots?: RobotsDirectives | string | null | undefined;
  /** Per-crawler robots meta, keyed by crawler name (e.g. `googlebot`). */
  bots?: Record<string, RobotsDirectives | string | null> | null | undefined;
  alternates?: readonly (SeoAlternate | SeoRemoval)[] | null | undefined;
  /** Shorthand feeding Open Graph and Twitter. */
  image?: string | SeoImage | null | undefined;
  openGraph?: OpenGraphConfig | null | undefined;
  twitter?: TwitterConfig | null | undefined;
  jsonLd?: readonly (JsonLdNode | SeoRemoval)[] | null | undefined;
  meta?: readonly (SeoMetaTag | SeoRemoval)[] | null | undefined;
  links?: readonly (SeoLinkTag | SeoRemoval)[] | null | undefined;
  /** Server response control. Ignored in the browser. */
  http?: SeoHttp | null | undefined;
}

export type SeoDefaults = SeoConfig | ((ctx: SeoContext) => SeoConfig);

export interface SeoCanonicalPolicy {
  trailingSlash?: 'preserve' | 'always' | 'never' | undefined;
  /** Query parameters kept in the derived canonical. Default: none. */
  keepQueryParams?: readonly string[] | undefined;
}

export interface SeoSiteConfig {
  siteName?: string | undefined;
  /** Origin used to make URLs absolute, e.g. `https://example.com`. */
  baseUrl?: string | undefined;
  titleTemplate?: TitleTemplate | undefined;
  /** Title used when no layer sets one. Not passed through the template. */
  defaultTitle?: string | undefined;
  canonical?: SeoCanonicalPolicy | undefined;
  /** The lowest-priority layer. */
  defaults?: SeoDefaults | undefined;
  /** Route data key to read. Default `'seo'`. */
  routeDataKey?: string | undefined;
  /** Dev-mode warnings. Default `'warn'`. Always off in production. */
  diagnostics?: 'warn' | 'off' | undefined;
}

/** A route data value: a config, or a function called in an injection context. */
export type RouteSeo<TRoute = ActivatedRouteSnapshot> = SeoConfig | ((route: TRoute) => SeoConfig);

export interface HeadTag {
  key: string;
  tag: 'meta' | 'link' | 'script';
  attrs: Record<string, string>;
  text?: string | undefined;
}

/** The fully derived head for the current page. */
export interface ResolvedHead {
  title: string | null;
  htmlAttrs: { lang?: string | undefined; dir?: string | undefined };
  tags: readonly HeadTag[];
  http: { status?: number | undefined; headers: Record<string, string> };
  canonical: string | null;
  robots: string | null;
  /** Fields whose URL value was dropped because it could not be made absolute. */
  droppedUrls: readonly string[];
}

export interface SeoHandle {
  /** Replace this contribution's config; pass a function to make it reactive. */
  set(config: SeoConfig | (() => SeoConfig)): void;
  /** Merge fields into this contribution's config. */
  patch(partial: SeoConfig): void;
  /** Empty this contribution without removing it. */
  clear(): void;
  /** Remove this contribution for good. Later calls on the handle do nothing. */
  destroy(): void;
}
