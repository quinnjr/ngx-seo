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
  SeoAlternate,
  SeoImage,
  SeoLinkTag,
  SeoMedia,
  SeoMetaTag,
  SeoSiteConfig,
  TitleTemplate,
  TwitterConfig,
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

  private overridden = new Set<string>();

  checkpoint(): { length: number; counts: Map<string, number>; overridden: Set<string>; attrs: HeadTag[] } {
    return {
      length: this.tags.length,
      counts: new Map(this.counts),
      overridden: new Set(this.overridden),
      attrs: this.tags.map((tag) => ({ ...tag })),
    };
  }

  restore(checkpoint: ReturnType<TagList['checkpoint']>): void {
    this.tags.length = 0;
    this.tags.push(...checkpoint.attrs);
    this.counts.clear();
    for (const [key, count] of checkpoint.counts) {
      this.counts.set(key, count);
    }
    this.overridden = checkpoint.overridden;
  }

  /**
   * Adds an extra tag. If a derived tag already has this identity, the extra
   * tag replaces it in place instead of producing a duplicate.
   */
  override(baseKey: string, tag: HeadTag['tag'], attrs: Record<string, string>): void {
    const existing = this.tags.find((item) => item.key === baseKey);
    if (existing !== undefined && !this.overridden.has(baseKey)) {
      this.overridden.add(baseKey);
      existing.tag = tag;
      existing.attrs = attrs;
      return;
    }
    this.add(baseKey, tag, attrs);
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

function dateText(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return str(value);
}

function numberText(value: unknown): string | undefined {
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

function resolveJsonLd(value: unknown, pageUrl: string | null, origin: string | null, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (ancestors.has(value)) {
    // Leave the cycle in place so serialisation drops this node.
    return value;
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? value.map((item) => resolveJsonLd(item, pageUrl, origin, ancestors))
      : resolveJsonLdObject(value as Bag, pageUrl, origin, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function resolveJsonLdObject(value: Bag, pageUrl: string | null, origin: string | null, seen: Set<object>): Bag {
  const out: Bag = {};
  for (const [key, inner] of Object.entries(value)) {
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


/** Meta names and properties whose content is a URL and must pass URL checks. */
const URL_META = new Set([
  'og:url',
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'og:video',
  'og:video:url',
  'og:video:secure_url',
  'og:audio',
  'og:audio:url',
  'og:audio:secure_url',
  'twitter:image',
  'twitter:image:src',
  'twitter:player',
]);

function isObject(value: unknown): value is Bag {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Text value, or undefined for anything that is not a non-empty string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Items of a list field. A single string counts as a one-item list; anything else that is not an array is empty. */
function items<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined) as T[];
  }
  return typeof value === 'string' && value !== '' ? [value as T] : [];
}

/** Objects of a list field; non-object entries are skipped. */
function objects<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isObject) as T[]) : [];
}

/**
 * Derives the full, explicit head for a merged config. Pure: no DOM, no DI.
 *
 * Every section is contained: a malformed value drops only that section's
 * tags and is reported through `env.onError`.
 */
export function resolveHead(merged: SeoConfig, site: SeoSiteConfig, env: ResolveEnv): ResolvedHead {
  const base = site.baseUrl ?? env.origin;
  const origin = originOf(base);
  const droppedUrls: string[] = [];
  const onError = env.onError ?? (() => {});
  const list = new TagList();

  /** Runs one section; on failure, rolls its tags back and reports. */
  const section = (run: () => void): void => {
    const checkpoint = list.checkpoint();
    try {
      run();
    } catch (error) {
      list.restore(checkpoint);
      onError(error);
    }
  };
  const guarded = <T>(run: () => T, fallback: T): T => {
    try {
      return run();
    } catch (error) {
      onError(error);
      return fallback;
    }
  };

  const url = (value: unknown, field: string): string | null => {
    const text = str(value);
    if (text === undefined) {
      return null;
    }
    const resolved = absoluteUrl(text, origin);
    if (resolved === null) {
      droppedUrls.push(field);
    }
    return resolved;
  };

  // Server response first, so a broken head section never loses a status.
  const http = guarded<ResolvedHead['http']>(() => {
    const headers: Record<string, string> = {};
    const source = merged.http?.headers;
    if (isObject(source)) {
      for (const [name, v] of Object.entries(source)) {
        if (typeof v === 'string') {
          headers[name] = v;
        }
      }
    }
    const out: ResolvedHead['http'] = { headers };
    if (typeof merged.http?.status === 'number') {
      out.status = merged.http.status;
    }
    return out;
  }, { headers: {} });

  const htmlAttrs = guarded<ResolvedHead['htmlAttrs']>(() => {
    const out: ResolvedHead['htmlAttrs'] = {};
    const lang = str(merged.lang);
    const dir = str(merged.dir);
    if (lang) {
      out.lang = lang;
    }
    if (dir) {
      out.dir = dir;
    }
    return out;
  }, {});

  // Canonical
  const policy = {
    trailingSlash: site.canonical?.trailingSlash ?? 'preserve',
    keepQueryParams: site.canonical?.keepQueryParams ?? [],
  } as const;
  const canonical = guarded<string | null>(() => {
    const canonicalLink = objects<SeoLinkTag>(merged.links).find((link) => link.rel === 'canonical' && str(link.href));
    const fromLink = canonicalLink ? absoluteUrl(canonicalLink.href, origin) : null;
    if (fromLink !== null) {
      // An extra canonical link overrides the derived canonical everywhere, og:url included.
      return fromLink;
    }
    if (merged.canonical === false) {
      return null;
    }
    if (typeof merged.canonical === 'string') {
      return url(merged.canonical, 'canonical');
    }
    return canonicalFor(env.path, origin, policy);
  }, null);

  // Title
  const pageTitle = str(merged.title) ?? null;
  const description = str(merged.description);
  const ctx: SeoContext = {
    url: env.path,
    canonical,
    title: pageTitle,
    description: description ?? null,
    siteName: site.siteName ?? null,
  };
  const template = merged.titleTemplate === false ? null : (merged.titleTemplate ?? site.titleTemplate ?? null);
  let title: string | null = null;
  if (pageTitle !== null) {
    title = pageTitle;
    if (template !== null) {
      title = guarded(() => {
        const result = applyTemplate(template, pageTitle, ctx);
        return typeof result === 'string' ? result : pageTitle;
      }, pageTitle);
    }
  } else if (site.defaultTitle) {
    title = site.defaultTitle;
  }
  const socialTitle = pageTitle ?? site.defaultTitle ?? null;

  let robots: string | null = null;
  section(() => {
    list.name('description', description);
    const keywords = Array.isArray(merged.keywords) ? items<string>(merged.keywords).join(', ') : str(merged.keywords);
    list.name('keywords', keywords);
    list.name('author', str(merged.author));
    const robotsValue = merged.robots;
    robots = typeof robotsValue === 'string' || isObject(robotsValue) ? robotsContent(robotsValue) : null;
    list.name('robots', robots);
  });
  section(() => {
    if (isObject(merged.bots)) {
      for (const [bot, directives] of Object.entries(merged.bots)) {
        if (typeof directives === 'string' || isObject(directives)) {
          list.name(bot, robotsContent(directives));
        }
      }
    }
  });

  // Links
  section(() => {
    if (canonical !== null) {
      list.add('link:canonical', 'link', { rel: 'canonical', href: canonical });
    }
    for (const alternate of objects<SeoAlternate>(merged.alternates)) {
      const hreflang = str(alternate.hreflang);
      if (hreflang === undefined) {
        continue;
      }
      const href = url(alternate.href, `alternates[${hreflang}]`);
      if (href !== null) {
        list.add(`link:alternate:${hreflang}`, 'link', { rel: 'alternate', hreflang, href });
      }
    }
  });

  // Open Graph
  const og: OpenGraphConfig = isObject(merged.openGraph) ? merged.openGraph : {};
  const images: SeoImage[] = [];
  section(() => {
    list.property('og:title', str(og.title) ?? socialTitle);
    list.property('og:description', str(og.description) ?? description);
    const derivedType = isObject(og.article) ? 'article' : isObject(og.profile) ? 'profile' : isObject(og.book) ? 'book' : 'website';
    list.property('og:type', str(og.type) ?? derivedType);
    list.property('og:url', og.url ? url(og.url, 'openGraph.url') : canonical);
    list.property('og:site_name', str(og.siteName) ?? site.siteName);
    list.property('og:locale', str(og.locale));
    for (const locale of items<string>(og.alternateLocales)) {
      list.property('og:locale:alternate', str(locale));
    }
  });
  section(() => {
    const shorthand: SeoImage | null =
      typeof merged.image === 'string' ? { url: merged.image } : isObject(merged.image) ? (merged.image as SeoImage) : null;
    const sources: [SeoImage, string][] = [];
    if (shorthand && str(shorthand.url)) {
      sources.push([shorthand, 'image']);
    }
    objects<SeoImage>(og.images).forEach((image, index) => {
      if (str(image.url)) {
        sources.push([image, `openGraph.images[${index}]`]);
      }
    });
    const seen = new Set<string>();
    for (const [image, field] of sources) {
      const src = url(image.url, field);
      if (src === null || seen.has(src)) {
        continue;
      }
      seen.add(src);
      images.push({ ...image, url: src });
      list.property('og:image', src);
      list.property('og:image:type', str(image.type));
      list.property('og:image:width', numberText(image.width));
      list.property('og:image:height', numberText(image.height));
      list.property('og:image:alt', str(image.alt));
    }
  });
  const media = (value: unknown, prop: 'og:video' | 'og:audio', field: string): void => {
    section(() => {
      objects<SeoMedia>(value).forEach((item, index) => {
        const src = url(item.url, `${field}[${index}]`);
        if (src === null) {
          return;
        }
        list.property(prop, src);
        list.property(`${prop}:type`, str(item.type));
        list.property(`${prop}:width`, numberText(item.width));
        list.property(`${prop}:height`, numberText(item.height));
      });
    });
  };
  media(og.videos, 'og:video', 'openGraph.videos');
  media(og.audio, 'og:audio', 'openGraph.audio');

  section(() => {
    if (!isObject(og.article)) {
      return;
    }
    const a = og.article;
    list.property('article:published_time', dateText(a.publishedTime));
    list.property('article:modified_time', dateText(a.modifiedTime));
    list.property('article:expiration_time', dateText(a.expirationTime));
    for (const author of items<string>(a.authors)) {
      list.property('article:author', str(author));
    }
    list.property('article:section', str(a.section));
    for (const tag of items<string>(a.tags)) {
      list.property('article:tag', str(tag));
    }
  });
  section(() => {
    if (!isObject(og.profile)) {
      return;
    }
    list.property('profile:first_name', str(og.profile.firstName));
    list.property('profile:last_name', str(og.profile.lastName));
    list.property('profile:username', str(og.profile.username));
    list.property('profile:gender', str(og.profile.gender));
  });
  section(() => {
    if (!isObject(og.book)) {
      return;
    }
    for (const author of items<string>(og.book.authors)) {
      list.property('book:author', str(author));
    }
    list.property('book:isbn', str(og.book.isbn));
    list.property('book:release_date', dateText(og.book.releaseDate));
    for (const tag of items<string>(og.book.tags)) {
      list.property('book:tag', str(tag));
    }
  });

  // Twitter
  section(() => {
    const tw: TwitterConfig = isObject(merged.twitter) ? merged.twitter : {};
    const twitterImage = tw.image ? url(tw.image, 'twitter.image') : (images[0]?.url ?? null);
    list.name('twitter:card', str(tw.card) ?? (twitterImage ? 'summary_large_image' : 'summary'));
    list.name('twitter:site', str(tw.site));
    list.name('twitter:creator', str(tw.creator));
    list.name('twitter:title', str(tw.title) ?? str(og.title) ?? socialTitle);
    list.name('twitter:description', str(tw.description) ?? str(og.description) ?? description);
    list.name('twitter:image', twitterImage);
    list.name('twitter:image:alt', str(tw.imageAlt) ?? (tw.image ? undefined : str(images[0]?.alt)));
  });

  // Extra meta
  section(() => {
    objects<SeoMetaTag>(merged.meta).forEach((meta, index) => {
      let content = typeof meta.content === 'string' ? meta.content : undefined;
      const identity = str(meta.name) ?? str(meta.property);
      if (content === undefined) {
        return;
      }
      if (identity !== undefined && URL_META.has(identity)) {
        const checked = url(content, `meta[${index}]`);
        if (checked === null) {
          return;
        }
        content = checked;
      }
      if (str(meta.name)) {
        list.override(`meta:name:${meta.name}`, 'meta', { name: meta.name as string, content });
      } else if (str(meta.property)) {
        list.override(`meta:property:${meta.property}`, 'meta', { property: meta.property as string, content });
      } else if (str(meta.httpEquiv)) {
        list.override(`meta:http-equiv:${meta.httpEquiv}`, 'meta', { 'http-equiv': meta.httpEquiv as string, content });
      }
    });
  });

  // Extra links
  section(() => {
    for (const link of objects<SeoLinkTag>(merged.links)) {
      const rel = str(link.rel);
      if (rel === undefined) {
        continue;
      }
      const href = url(link.href, `links[${link.key ?? rel}]`);
      if (href === null) {
        continue;
      }
      const attrs: Record<string, string> = { rel, href };
      for (const attr of ['hreflang', 'type', 'media', 'sizes', 'title'] as const) {
        const v = str(link[attr]);
        if (v) {
          attrs[attr] = v;
        }
      }
      let key = link.key ? `link:${link.key}` : `link:${rel}:${href}`;
      if (rel === 'canonical') {
        key = 'link:canonical';
      } else if (rel === 'alternate' && attrs['hreflang']) {
        key = `link:alternate:${attrs['hreflang']}`;
      }
      list.override(key, 'link', attrs);
    }
  });

  // JSON-LD
  section(() => {
    const nodes: JsonLdNode[] = [];
    for (const node of objects<Bag>(merged.jsonLd)) {
      if ('@type' in node) {
        nodes.push(node as JsonLdNode);
      } else {
        onError(new Error('ngx-seo: dropped a JSON-LD node without @type'));
      }
    }
    if (nodes.length === 0) {
      return;
    }
    const pageUrl = canonical ?? canonicalFor(env.path, origin, policy);
    const resolved = nodes.map((node) => resolveJsonLd(node, pageUrl, origin, new Set()) as JsonLdNode);
    const text = serializeJsonLd(resolved, onError);
    if (text !== null) {
      list.add('script:jsonld', 'script', { type: 'application/ld+json' }, text);
    }
  });

  return { title, htmlAttrs, tags: list.tags, http, canonical, robots, droppedUrls };
}
