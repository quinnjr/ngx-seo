import { serializeJsonLd } from './json-ld';
import { robotsContent } from './robots';
import { absoluteUrl, canonicalFor, originOf } from './url';
import type {
  HeadTag,
  JsonLdNode,
  OpenGraphConfig,
  ResolvedHead,
  SeoConfig,
  SeoContext,
  SeoImage,
  SeoMedia,
  SeoSiteConfig,
  TitleTemplate,
} from './types';

export interface ResolveEnv {
  /** Current router path including query string. */
  path: string;
  /** Request or window origin, used when the site has no `baseUrl`. */
  origin: string | null;
  /** Receives JSON-LD serialisation errors. */
  onError?: (error: unknown) => void;
}

/** JSON-LD properties whose root-relative string values are made absolute. */
const JSON_LD_URL_PROPS = new Set([
  'url',
  'item',
  'image',
  'logo',
  'contentUrl',
  'thumbnailUrl',
  'mainEntityOfPage',
  'target',
]);

type Bag = Record<string, unknown>;

class TagList {
  readonly tags: HeadTag[] = [];
  private readonly counts = new Map<string, number>();

  add(baseKey: string, tag: HeadTag['tag'], attrs: Record<string, string>, text?: string): void {
    const seen = this.counts.get(baseKey) ?? 0;
    this.counts.set(baseKey, seen + 1);
    const key = seen === 0 ? baseKey : `${baseKey}#${seen}`;
    this.tags.push(text === undefined ? { key, tag, attrs } : { key, tag, attrs, text });
  }

  name(name: string, content: string | null | undefined): void {
    if (content) {
      this.add(`meta:name:${name}`, 'meta', { name, content });
    }
  }

  property(property: string, content: string | null | undefined): void {
    if (content) {
      this.add(`meta:property:${property}`, 'meta', { property, content });
    }
  }
}

function dateText(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return value ?? undefined;
}

function numberText(value: number | null | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function applyTemplate(template: TitleTemplate, title: string, ctx: SeoContext): string {
  return typeof template === 'function' ? template(title, ctx) : template.split('%s').join(title);
}

/** Origin + value for root-relative strings, without URL normalisation (keeps `{placeholders}`). */
function rootRelative(value: string, origin: string | null): string {
  if (origin === null) {
    return value;
  }
  if (value.startsWith('//')) {
    return `${new URL(origin).protocol}${value}`;
  }
  return `${origin}${value}`;
}

function resolveJsonLd(value: unknown, pageUrl: string | null, origin: string | null, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    return value.map((item) => resolveJsonLd(item, pageUrl, origin, seen));
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    // Leave the cycle in place so serialisation drops this node.
    return value;
  }
  seen.add(value);

  const out: Bag = {};
  for (const [key, inner] of Object.entries(value as Bag)) {
    if (key === '@id' && typeof inner === 'string') {
      if (inner.startsWith('#')) {
        out[key] = pageUrl === null ? inner : `${pageUrl}${inner}`;
      } else if (inner.startsWith('/')) {
        out[key] = rootRelative(inner, origin);
      } else {
        out[key] = inner;
      }
    } else if (JSON_LD_URL_PROPS.has(key) && typeof inner === 'string' && inner.startsWith('/')) {
      out[key] = rootRelative(inner, origin);
    } else if (JSON_LD_URL_PROPS.has(key) && Array.isArray(inner)) {
      out[key] = inner.map((item) =>
        typeof item === 'string' && item.startsWith('/')
          ? rootRelative(item, origin)
          : resolveJsonLd(item, pageUrl, origin, seen),
      );
    } else {
      out[key] = resolveJsonLd(inner, pageUrl, origin, seen);
    }
  }
  return out;
}

function stripHash(url: string): string {
  const at = url.indexOf('#');
  return at === -1 ? url : url.slice(0, at);
}

/**
 * Derives the full, explicit head for a merged config. Pure: no DOM, no DI.
 */
export function resolveHead(merged: SeoConfig, site: SeoSiteConfig, env: ResolveEnv): ResolvedHead {
  const base = site.baseUrl ?? env.origin;
  const origin = originOf(base);
  const droppedUrls: string[] = [];
  const onError = env.onError ?? (() => {});

  const url = (value: string | null | undefined, field: string): string | null => {
    if (!value) {
      return null;
    }
    const resolved = absoluteUrl(value, origin);
    if (resolved === null) {
      droppedUrls.push(field);
    }
    return resolved;
  };

  // Canonical
  let canonical: string | null = null;
  if (merged.canonical === false) {
    canonical = null;
  } else if (typeof merged.canonical === 'string') {
    canonical = url(merged.canonical, 'canonical');
  } else {
    canonical = canonicalFor(env.path, origin, {
      trailingSlash: site.canonical?.trailingSlash ?? 'preserve',
      keepQueryParams: site.canonical?.keepQueryParams ?? [],
    });
  }

  // Title
  const pageTitle = merged.title ?? null;
  const ctx: SeoContext = {
    url: env.path,
    canonical,
    title: pageTitle,
    description: merged.description ?? null,
    siteName: site.siteName ?? null,
  };
  const template = merged.titleTemplate === false ? null : (merged.titleTemplate ?? site.titleTemplate ?? null);
  let title: string | null = null;
  if (pageTitle !== null) {
    title = template === null ? pageTitle : applyTemplate(template, pageTitle, ctx);
  } else if (site.defaultTitle) {
    title = site.defaultTitle;
  }
  const socialTitle = pageTitle ?? site.defaultTitle ?? null;

  const list = new TagList();

  // Basic meta
  list.name('description', merged.description);
  const keywords = Array.isArray(merged.keywords) ? merged.keywords.join(', ') : merged.keywords;
  list.name('keywords', keywords);
  list.name('author', merged.author);
  const robots = merged.robots ? robotsContent(merged.robots) : null;
  list.name('robots', robots);
  for (const [bot, directives] of Object.entries(merged.bots ?? {})) {
    if (directives) {
      list.name(bot, robotsContent(directives));
    }
  }

  // Links
  if (canonical !== null) {
    list.add('link:canonical', 'link', { rel: 'canonical', href: canonical });
  }
  for (const alternate of merged.alternates ?? []) {
    if (!('hreflang' in alternate)) {
      continue;
    }
    const href = url(alternate.href, `alternates[${alternate.hreflang}]`);
    if (href !== null) {
      list.add(`link:alternate:${alternate.hreflang}`, 'link', { rel: 'alternate', hreflang: alternate.hreflang, href });
    }
  }

  // Open Graph
  const og: OpenGraphConfig = merged.openGraph ?? {};
  list.property('og:title', og.title ?? socialTitle);
  list.property('og:description', og.description ?? merged.description);
  list.property('og:type', og.type ?? 'website');
  const ogUrl = og.url ? url(og.url, 'openGraph.url') : canonical;
  list.property('og:url', ogUrl);
  list.property('og:site_name', og.siteName ?? site.siteName);
  list.property('og:locale', og.locale);
  for (const locale of og.alternateLocales ?? []) {
    list.property('og:locale:alternate', locale);
  }

  const images: SeoImage[] = [];
  const shorthand: SeoImage | null =
    typeof merged.image === 'string' ? { url: merged.image } : (merged.image ?? null);
  const imageSources: [SeoImage, string][] = [];
  if (shorthand?.url) {
    imageSources.push([shorthand, 'image']);
  }
  (og.images ?? []).forEach((image, index) => {
    if ('url' in image && image.url) {
      imageSources.push([image, `openGraph.images[${index}]`]);
    }
  });
  const seenImages = new Set<string>();
  for (const [image, field] of imageSources) {
    const src = url(image.url, field);
    if (src === null || seenImages.has(src)) {
      continue;
    }
    seenImages.add(src);
    images.push({ ...image, url: src });
    list.property('og:image', src);
    list.property('og:image:type', image.type);
    list.property('og:image:width', numberText(image.width));
    list.property('og:image:height', numberText(image.height));
    list.property('og:image:alt', image.alt);
  }

  const media = (items: SeoMedia[] | null | undefined, prop: 'og:video' | 'og:audio', field: string): void => {
    (items ?? []).forEach((item, index) => {
      const src = url(item.url, `${field}[${index}]`);
      if (src === null) {
        return;
      }
      list.property(prop, src);
      list.property(`${prop}:type`, item.type);
      list.property(`${prop}:width`, numberText(item.width));
      list.property(`${prop}:height`, numberText(item.height));
    });
  };
  media(og.videos, 'og:video', 'openGraph.videos');
  media(og.audio, 'og:audio', 'openGraph.audio');

  if (og.article) {
    const a = og.article;
    list.property('article:published_time', dateText(a.publishedTime));
    list.property('article:modified_time', dateText(a.modifiedTime));
    list.property('article:expiration_time', dateText(a.expirationTime));
    for (const author of a.authors ?? []) {
      list.property('article:author', author);
    }
    list.property('article:section', a.section);
    for (const tag of a.tags ?? []) {
      list.property('article:tag', tag);
    }
  }
  if (og.profile) {
    list.property('profile:first_name', og.profile.firstName);
    list.property('profile:last_name', og.profile.lastName);
    list.property('profile:username', og.profile.username);
    list.property('profile:gender', og.profile.gender);
  }
  if (og.book) {
    for (const author of og.book.authors ?? []) {
      list.property('book:author', author);
    }
    list.property('book:isbn', og.book.isbn);
    list.property('book:release_date', dateText(og.book.releaseDate));
    for (const tag of og.book.tags ?? []) {
      list.property('book:tag', tag);
    }
  }

  // Twitter
  const tw = merged.twitter ?? {};
  const twitterImage = tw.image ? url(tw.image, 'twitter.image') : (images[0]?.url ?? null);
  list.name('twitter:card', tw.card ?? (twitterImage ? 'summary_large_image' : 'summary'));
  list.name('twitter:site', tw.site);
  list.name('twitter:creator', tw.creator);
  list.name('twitter:title', tw.title ?? og.title ?? socialTitle);
  list.name('twitter:description', tw.description ?? og.description ?? merged.description);
  list.name('twitter:image', twitterImage);
  list.name('twitter:image:alt', tw.imageAlt ?? (tw.image ? undefined : images[0]?.alt));

  // Extra meta
  for (const meta of merged.meta ?? []) {
    if (!('content' in meta)) {
      continue;
    }
    if (meta.name) {
      list.add(`meta:name:${meta.name}`, 'meta', { name: meta.name, content: meta.content });
    } else if (meta.property) {
      list.add(`meta:property:${meta.property}`, 'meta', { property: meta.property, content: meta.content });
    } else if (meta.httpEquiv) {
      list.add(`meta:http-equiv:${meta.httpEquiv}`, 'meta', { 'http-equiv': meta.httpEquiv, content: meta.content });
    }
  }

  // Extra links
  for (const link of merged.links ?? []) {
    if (!('rel' in link)) {
      continue;
    }
    const href = url(link.href, `links[${link.key ?? link.rel}]`);
    if (href === null) {
      continue;
    }
    const attrs: Record<string, string> = { rel: link.rel, href };
    for (const attr of ['hreflang', 'type', 'media', 'sizes', 'title'] as const) {
      const v = link[attr];
      if (v) {
        attrs[attr] = v;
      }
    }
    list.add(link.key ? `link:${link.key}` : `link:${link.rel}:${href}`, 'link', attrs);
  }

  // JSON-LD
  const nodes = (merged.jsonLd ?? []).filter((node): node is JsonLdNode => '@type' in node);
  if (nodes.length > 0) {
    const current = canonical ?? absoluteUrl(env.path, origin);
    const pageUrl = current === null ? null : stripHash(current);
    const seen = new WeakSet<object>();
    const resolved = nodes.map((node) => resolveJsonLd(node, pageUrl, origin, seen) as JsonLdNode);
    const text = serializeJsonLd(resolved, onError);
    if (text !== null) {
      list.add('script:jsonld', 'script', { type: 'application/ld+json' }, text);
    }
  }

  // Server response
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(merged.http?.headers ?? {})) {
    if (typeof v === 'string') {
      headers[name] = v;
    }
  }
  const http: ResolvedHead['http'] = { headers };
  if (typeof merged.http?.status === 'number') {
    http.status = merged.http.status;
  }

  const htmlAttrs: ResolvedHead['htmlAttrs'] = {};
  if (merged.lang) {
    htmlAttrs.lang = merged.lang;
  }
  if (merged.dir) {
    htmlAttrs.dir = merged.dir;
  }

  return { title, htmlAttrs, tags: list.tags, http, canonical, robots, droppedUrls };
}
