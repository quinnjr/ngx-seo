import { serializeJsonLd } from './json-ld';
import { robotsContent } from './robots';
import { absoluteUrl, canonicalFor, originOf } from './url';
import type {
  HeadTag,
  JsonLdNode,
  OpenGraphConfig,
  ResolvedHead,
  RobotsDirectives,
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
  /** Path the app is served under (e.g. `/blog/`); document-relative URLs resolve against it. */
  basePath?: string | undefined;
  /** Receives JSON-LD serialisation errors. */
  onError?: ((error: unknown) => void) | undefined;
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
  private counts = new Map<string, number>();
  /** The identity (base key) each emitted key belongs to; keys are never parsed. */
  private groupOf = new Map<string, string>();
  private overridden = new Set<string>();
  /** Keys of tags that came from extra `meta`/`links` rather than derivation. */
  extra = new Set<string>();
  /** Base keys whose derived tags an extra tag replaced. */
  replaced = new Set<string>();

  /**
   * A key for the next tag with this identity, unique among all tags. Repeats
   * get `#n`; a base key that itself contains `#` (an href with a fragment)
   * can never collide, because taken keys are skipped.
   */
  private nextKey(baseKey: string): string {
    let n = this.counts.get(baseKey) ?? 0;
    let key = n === 0 ? baseKey : `${baseKey}#${n}`;
    while (this.groupOf.has(key)) {
      n++;
      key = `${baseKey}#${n}`;
    }
    this.counts.set(baseKey, n + 1);
    this.groupOf.set(key, baseKey);
    return key;
  }

  private inGroup(key: string, baseKey: string): boolean {
    return this.groupOf.get(key) === baseKey;
  }

  /** Appends a tag and returns its key. */
  add(baseKey: string, tag: HeadTag['tag'], attrs: Record<string, string>, text?: string): string {
    const key = this.nextKey(baseKey);
    this.tags.push(text === undefined ? { key, tag, attrs } : { key, tag, attrs, text });
    return key;
  }

  /** Sets the tag with this key, replacing it in place if it exists. */
  replace(key: string, tag: HeadTag['tag'], attrs: Record<string, string>): void {
    const existing = this.tags.find((item) => item.key === key);
    if (existing !== undefined) {
      existing.tag = tag;
      existing.attrs = attrs;
      return;
    }
    this.add(key, tag, attrs);
  }

  checkpoint(): {
    counts: Map<string, number>;
    groupOf: Map<string, string>;
    overridden: Set<string>;
    extra: Set<string>;
    replaced: Set<string>;
    attrs: HeadTag[];
  } {
    return {
      counts: new Map(this.counts),
      groupOf: new Map(this.groupOf),
      overridden: new Set(this.overridden),
      extra: new Set(this.extra),
      replaced: new Set(this.replaced),
      attrs: this.tags.map((tag) => ({ ...tag })),
    };
  }

  restore(checkpoint: ReturnType<TagList['checkpoint']>): void {
    this.tags.length = 0;
    this.tags.push(...checkpoint.attrs);
    this.counts = checkpoint.counts;
    this.groupOf = checkpoint.groupOf;
    this.overridden = checkpoint.overridden;
    this.extra = checkpoint.extra;
    this.replaced = checkpoint.replaced;
  }

  /** Removes the tag with this exact key. */
  remove(key: string): void {
    const at = this.tags.findIndex((item) => item.key === key);
    if (at !== -1) {
      this.tags.splice(at, 1);
      this.groupOf.delete(key);
    }
  }

  find(key: string): HeadTag | undefined {
    return this.tags.find((item) => item.key === key);
  }

  /**
   * Adds an extra tag. If a derived tag already has this identity, the extra
   * tag replaces it in place instead of producing a duplicate.
   */
  override(baseKey: string, tag: HeadTag['tag'], attrs: Record<string, string>): void {
    if (!this.overridden.has(baseKey)) {
      this.overridden.add(baseKey);
      // The first extra tag replaces every derived repeat with this identity, in place.
      const first = this.tags.findIndex((item) => this.inGroup(item.key, baseKey));
      if (first !== -1) {
        for (let i = this.tags.length - 1; i > first; i--) {
          if (this.inGroup(this.tags[i].key, baseKey)) {
            this.groupOf.delete(this.tags[i].key);
            this.tags.splice(i, 1);
          }
        }
        const key = this.tags[first].key;
        this.tags[first] = { key, tag, attrs };
        this.extra.add(key);
        this.replaced.add(baseKey);
        return;
      }
      this.extra.add(this.add(baseKey, tag, attrs));
      return;
    }
    // Further extra tags with this identity are all kept, right after the group.
    let last = -1;
    this.tags.forEach((item, index) => {
      if (this.inGroup(item.key, baseKey)) {
        last = index;
      }
    });
    const entry: HeadTag = { key: this.nextKey(baseKey), tag, attrs };
    this.extra.add(entry.key);
    if (last === -1) {
      this.tags.push(entry);
    } else {
      this.tags.splice(last + 1, 0, entry);
    }
  }

  name(name: string, content: string | null | undefined): void {
    if (content) {
      this.add(`meta:name:${name.toLowerCase()}`, 'meta', { name, content });
    }
  }

  property(property: string, content: string | null | undefined): void {
    if (content) {
      this.add(`meta:property:${property.toLowerCase()}`, 'meta', { property, content });
    }
  }
}

function dateText(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return str(value);
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
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Dates, URLs and anything else that serialises itself are passed through.
  if (!Array.isArray(value) && typeof (value as { toJSON?: unknown | undefined }).toJSON === 'function') {
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
  'twitter:player:stream',
  'twitter:url',
  'og:see_also',
]);

/**
 * Checks the URL in a `refresh` meta value (`"5; url=/next"`). Returns the
 * value with an absolute URL, the delay alone when there is no URL, or null
 * when the URL is unusable.
 */
function refreshContent(content: string, check: (target: string) => string | null): string | null {
  const match = /^\s*(\d+)\s*(?:[;,]\s*(?:url\s*=\s*)?(.*))?$/i.exec(content);
  if (match === null) {
    return null;
  }
  const delay = match[1];
  const target = (match[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (target === '') {
    return delay;
  }
  const checked = check(target);
  return checked === null ? null : `${delay}; url=${checked}`;
}

/** Meta names ngx-seo derives itself; a crawler in `bots` may not use them. */
const OWNED_META_NAMES = new Set(['description', 'keywords', 'author', 'robots', 'viewport']);

/** Script-capable or inline URL schemes, never emitted in any meta content. */
const UNSAFE_SCHEME = /^\s*(javascript|vbscript|data):/i;

/**
 * Meta names that hold a URL beyond the known URL_META list: app links
 * (`al:*:url`, `twitter:app:url:*`), anything named `*url*` or `*image`, and
 * `msapplication-*` tiles. Text meta (descriptions, titles, alt text) is
 * never scheme-checked, so "JavaScript: The Definitive Guide" stays.
 */
function holdsUrl(identity: string | undefined): boolean {
  return identity !== undefined && (URL_META.has(identity) || /url|image$|^msapplication-/i.test(identity));
}

/** Media list items: a list of objects or bare URLs, or a single object or URL. */
function mediaItems<T>(value: unknown): T[] {
  const list = typeof value === 'string' || isObject(value) ? [value] : Array.isArray(value) ? value : [];
  return list
    .map((item) => (typeof item === 'string' && item !== '' ? { url: item } : item))
    .filter(isObject) as T[];
}

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
  // An unusable baseUrl (reported by the Seo service) falls back to the request or page origin.
  const origin = originOf(site.baseUrl ?? null) ?? originOf(env.origin);
  const droppedUrls: string[] = [];
  const onError = env.onError ?? (() => {});
  // Root-relative URLs resolve against the origin, document-relative ones against the serving path.
  const basePath = env.basePath && env.basePath !== '/' ? `/${env.basePath.replace(/^\/+|\/+$/g, '')}/` : '/';
  const documentBase = origin === null ? null : `${origin}${basePath}`;
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

  /** A text field; a non-empty value of another type is reported and ignored. */
  const textField = (value: unknown, field: string): string | undefined => {
    if (value !== null && value !== undefined && value !== '' && typeof value !== 'string') {
      onError(new Error(`ngx-seo: ignored ${field}: expected text`));
    }
    return str(value);
  };

  /** A list of text items; non-text items are reported and skipped. */
  const textItems = (value: unknown, field: string): string[] =>
    items<unknown>(value).flatMap((item) => {
      const text = textField(item, field);
      return text === undefined ? [] : [text];
    });

  /** A size: a finite number or a string of digits; anything else is reported and ignored. */
  const numberField = (value: unknown, field: string): string | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return value.trim();
    }
    if (value !== null && value !== undefined && value !== '') {
      onError(new Error(`ngx-seo: ignored ${field}: expected a number`));
    }
    return undefined;
  };

  const url = (value: unknown, field: string): string | null => {
    const text = textField(value, field);
    if (text === undefined) {
      return null;
    }
    const resolved = absoluteUrl(text, documentBase);
    if (resolved === null) {
      droppedUrls.push(field);
    }
    return resolved;
  };

  // Server response first, so a broken head section never loses a status.
  const http = guarded<ResolvedHead['http']>(() => {
    const headers: Record<string, string> = {};
    const httpValue: unknown = merged.http;
    if (httpValue !== undefined && httpValue !== null && !isObject(httpValue)) {
      onError(new Error('ngx-seo: ignored http: expected { status, headers }'));
    }
    const source = isObject(httpValue) ? (httpValue as { headers?: unknown }).headers : undefined;
    if (source !== undefined && source !== null && !isObject(source)) {
      onError(new Error('ngx-seo: ignored http.headers: expected an object of header names'));
    }
    if (isObject(source)) {
      for (const [name, v] of Object.entries(source)) {
        if (typeof v === 'string') {
          headers[name] = v;
        } else if (v !== null && v !== undefined) {
          onError(new Error(`ngx-seo: ignored response header ${JSON.stringify(name)}: its value is not a string`));
        }
      }
    }
    const out: ResolvedHead['http'] = { headers };
    const status: unknown = isObject(httpValue) ? (httpValue as { status?: unknown }).status : undefined;
    if (typeof status === 'number') {
      out.status = status;
    } else if (status !== null && status !== undefined) {
      onError(new Error(`ngx-seo: ignored response status ${JSON.stringify(status)}: it is not a number`));
    }
    return out;
  }, { headers: {} });

  const htmlAttrs = guarded<ResolvedHead['htmlAttrs']>(() => {
    const out: ResolvedHead['htmlAttrs'] = {};
    const lang = textField(merged.lang, 'lang');
    const dir = textField(merged.dir, 'dir');
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
    // The last canonical link declared wins, matching the tag that is emitted.
    const canonicalLink = objects<SeoLinkTag>(merged.links)
      .filter((link) => str(link.rel)?.toLowerCase() === 'canonical' && str(link.href))
      .pop();
    const fromLink = canonicalLink ? absoluteUrl(canonicalLink.href, documentBase) : null;
    if (fromLink !== null) {
      // An extra canonical link overrides the derived canonical everywhere, og:url included.
      return fromLink;
    }
    if (merged.canonical !== undefined && merged.canonical !== null && merged.canonical !== false && typeof merged.canonical !== 'string') {
      onError(new Error('ngx-seo: ignored canonical: expected a URL or false'));
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
  const pageTitle = textField(merged.title, 'title') ?? null;
  const description = textField(merged.description, 'description');
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
    const keywordsValue: unknown = merged.keywords;
    if (keywordsValue !== undefined && keywordsValue !== null && !Array.isArray(keywordsValue) && typeof keywordsValue !== 'string') {
      onError(new Error('ngx-seo: ignored keywords: expected a list or text'));
    }
    const keywords = Array.isArray(merged.keywords)
      ? textItems(merged.keywords, 'keywords').join(', ')
      : str(merged.keywords);
    list.name('keywords', keywords);
    list.name('author', textField(merged.author, 'author'));
    const robotsValue: unknown = merged.robots;
    if (robotsValue !== undefined && robotsValue !== null && typeof robotsValue !== 'string' && !isObject(robotsValue)) {
      onError(new Error('ngx-seo: ignored robots: expected directives or text'));
    }
    robots = typeof robotsValue === 'string' || isObject(robotsValue) ? robotsContent(robotsValue as RobotsDirectives | string) : null;
    list.name('robots', robots);
  });
  section(() => {
    if (isObject(merged.bots)) {
      for (const [bot, directives] of Object.entries(merged.bots)) {
        const lower = bot.toLowerCase();
        if (OWNED_META_NAMES.has(lower) || lower.startsWith('twitter:') || lower.startsWith('og:')) {
          onError(new Error(`ngx-seo: ignored bots.${bot}: that name belongs to another tag`));
          continue;
        }
        if (typeof directives !== 'string' && !isObject(directives)) {
          if (directives !== null && directives !== undefined) {
            onError(new Error(`ngx-seo: ignored bots.${bot}: expected directives or text`));
          }
        } else {
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
      const hreflang = textField(alternate.hreflang, 'alternates[].hreflang');
      if (hreflang === undefined) {
        if (alternate.hreflang === undefined || alternate.hreflang === null) {
          onError(new Error('ngx-seo: ignored an alternate without hreflang'));
        }
        continue;
      }
      const href = url(alternate.href, `alternates[${hreflang}]`);
      if (href !== null) {
        list.add(`link:alternate:${hreflang.toLowerCase()}`, 'link', { rel: 'alternate', hreflang, href });
      }
    }
  });

  // Open Graph
  /** An object field; a value of another kind is reported and ignored. */
  const objectField = (value: unknown, field: string): void => {
    if (value !== undefined && value !== null && !isObject(value)) {
      onError(new Error(`ngx-seo: ignored ${field}: expected an object`));
    }
  };
  objectField(merged.openGraph, 'openGraph');
  objectField(merged.twitter, 'twitter');
  objectField(merged.bots, 'bots');
  const og: OpenGraphConfig = isObject(merged.openGraph) ? merged.openGraph : {};
  const tw: TwitterConfig = isObject(merged.twitter) ? merged.twitter : {};
  // Read once, so a wrongly typed value is reported once.
  const ogText = {
    title: textField(og.title, 'openGraph.title'),
    description: textField(og.description, 'openGraph.description'),
    type: textField(og.type, 'openGraph.type'),
    siteName: textField(og.siteName, 'openGraph.siteName'),
    locale: textField(og.locale, 'openGraph.locale'),
  };
  const twText = {
    card: textField(tw.card, 'twitter.card'),
    site: textField(tw.site, 'twitter.site'),
    creator: textField(tw.creator, 'twitter.creator'),
    title: textField(tw.title, 'twitter.title'),
    description: textField(tw.description, 'twitter.description'),
    imageAlt: textField(tw.imageAlt, 'twitter.imageAlt'),
  };
  const images: SeoImage[] = [];
  section(() => {
    list.property('og:title', ogText.title ?? socialTitle);
    list.property('og:description', ogText.description ?? description);
    const derivedType = isObject(og.article) ? 'article' : isObject(og.profile) ? 'profile' : isObject(og.book) ? 'book' : 'website';
    list.property('og:type', ogText.type ?? derivedType);
    list.property('og:url', (og.url !== undefined && og.url !== null ? url(og.url, 'openGraph.url') : null) ?? canonical);
    list.property('og:site_name', ogText.siteName ?? site.siteName);
    list.property('og:locale', ogText.locale);
    for (const locale of textItems(og.alternateLocales, 'openGraph.alternateLocales')) {
      list.property('og:locale:alternate', locale);
    }
  });
  section(() => {
    const shorthand: SeoImage | null =
      typeof merged.image === 'string' ? { url: merged.image } : isObject(merged.image) ? (merged.image as SeoImage) : null;
    if (shorthand === null && merged.image !== undefined && merged.image !== null) {
      onError(new Error('ngx-seo: ignored image: expected a URL or an image object'));
    }
    const sources: [SeoImage, string][] = [];
    if (shorthand && str(shorthand.url)) {
      sources.push([shorthand, 'image']);
    }
    mediaItems<SeoImage>(og.images).forEach((image, index) => {
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
      list.property('og:image:type', textField(image.type, `${field}.type`));
      list.property('og:image:width', numberField(image.width, `${field}.width`));
      list.property('og:image:height', numberField(image.height, `${field}.height`));
      list.property('og:image:alt', textField(image.alt, `${field}.alt`));
    }
  });
  const media = (value: unknown, prop: 'og:video' | 'og:audio', field: string): void => {
    section(() => {
      if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'object') {
        onError(new Error(`ngx-seo: ignored ${field}: expected a list`));
        return;
      }
      mediaItems<SeoMedia>(value).forEach((item, index) => {
        const src = url(item.url, `${field}[${index}]`);
        if (src === null) {
          return;
        }
        list.property(prop, src);
        list.property(`${prop}:type`, textField(item.type, `${field}[${index}].type`));
        list.property(`${prop}:width`, numberField(item.width, `${field}[${index}].width`));
        list.property(`${prop}:height`, numberField(item.height, `${field}[${index}].height`));
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
    for (const author of textItems(a.authors, 'openGraph.article.authors')) {
      list.property('article:author', author);
    }
    list.property('article:section', textField(a.section, 'openGraph.article.section'));
    for (const tag of textItems(a.tags, 'openGraph.article.tags')) {
      list.property('article:tag', tag);
    }
  });
  section(() => {
    if (!isObject(og.profile)) {
      return;
    }
    list.property('profile:first_name', textField(og.profile.firstName, 'openGraph.profile.firstName'));
    list.property('profile:last_name', textField(og.profile.lastName, 'openGraph.profile.lastName'));
    list.property('profile:username', textField(og.profile.username, 'openGraph.profile.username'));
    list.property('profile:gender', textField(og.profile.gender, 'openGraph.profile.gender'));
  });
  section(() => {
    if (!isObject(og.book)) {
      return;
    }
    for (const author of textItems(og.book.authors, 'openGraph.book.authors')) {
      list.property('book:author', author);
    }
    list.property('book:isbn', textField(og.book.isbn, 'openGraph.book.isbn'));
    list.property('book:release_date', dateText(og.book.releaseDate));
    for (const tag of textItems(og.book.tags, 'openGraph.book.tags')) {
      list.property('book:tag', tag);
    }
  });

  // Twitter
  const explicitTwitterImage = tw.image !== undefined && tw.image !== null ? url(tw.image, 'twitter.image') : null;
  section(() => {
    const twitterImage = explicitTwitterImage ?? images[0]?.url ?? null;
    list.name('twitter:card', twText.card ?? (twitterImage ? 'summary_large_image' : 'summary'));
    list.name('twitter:site', twText.site);
    list.name('twitter:creator', twText.creator);
    list.name('twitter:title', twText.title ?? ogText.title ?? socialTitle);
    list.name('twitter:description', twText.description ?? ogText.description ?? description);
    list.name('twitter:image', twitterImage);
    list.name('twitter:image:alt', twText.imageAlt ?? (explicitTwitterImage ? undefined : str(images[0]?.alt)));
  });

  // Extra meta
  section(() => {
    objects<SeoMetaTag>(merged.meta).forEach((meta, index) => {
      let content = textField(meta.content, `meta[${index}].content`);
      const name = textField(meta.name, `meta[${index}].name`);
      const property = textField(meta.property, `meta[${index}].property`);
      const httpEquiv = textField(meta.httpEquiv, `meta[${index}].httpEquiv`);
      const media = textField(meta.media, `meta[${index}].media`);
      const identity = (name ?? property)?.toLowerCase();
      if (content === undefined) {
        return;
      }
      // Never emit a script or data URL, whatever the tag.
      // A script or data URL is never emitted where a URL is expected.
      if ((holdsUrl(identity) || httpEquiv?.toLowerCase() === 'refresh') && UNSAFE_SCHEME.test(content)) {
        droppedUrls.push(`meta[${index}]`);
        return;
      }
      if (httpEquiv?.toLowerCase() === 'refresh') {
        const checked = refreshContent(content, (target) => url(target, `meta[${index}]`));
        if (checked === null) {
          return;
        }
        content = checked;
      }
      if (identity !== undefined && URL_META.has(identity)) {
        const checked = url(content, `meta[${index}]`);
        if (checked === null) {
          return;
        }
        content = checked;
      }
      const suffix = media === undefined ? '' : `|${media}`;
      const withMedia = (attrs: Record<string, string>): Record<string, string> =>
        media === undefined ? attrs : { ...attrs, media };
      if (name) {
        list.override(`meta:name:${name.toLowerCase()}${suffix}`, 'meta', withMedia({ name, content }));
      } else if (property) {
        list.override(`meta:property:${property.toLowerCase()}${suffix}`, 'meta', withMedia({ property, content }));
      } else if (httpEquiv) {
        list.override(`meta:http-equiv:${httpEquiv.toLowerCase()}${suffix}`, 'meta', withMedia({ 'http-equiv': httpEquiv, content }));
      }
    });
  });

  // An extra og:image/og:video/og:audio replaces the whole derived media item,
  // and Twitter follows the Open Graph image it now describes.
  section(() => {
    for (const media of ['og:image', 'og:video', 'og:audio']) {
      const base = `meta:property:${media}`;
      if (!list.replaced.has(base)) {
        continue;
      }
      for (const tag of [...list.tags]) {
        if (tag.key.startsWith(`${base}:`) && !list.extra.has(tag.key)) {
          list.remove(tag.key);
        }
      }
    }
    const ogImage = list.tags.find((tag) => tag.attrs['property'] === 'og:image')?.attrs['content'];
    const derived = (key: string): boolean => !list.extra.has(key);
    if (explicitTwitterImage === null && derived('meta:name:twitter:image')) {
      const current = list.find('meta:name:twitter:image');
      if (ogImage !== undefined && current === undefined) {
        list.add('meta:name:twitter:image', 'meta', { name: 'twitter:image', content: ogImage });
      } else if (ogImage !== undefined && current !== undefined) {
        current.attrs = { ...current.attrs, content: ogImage };
      }
    }
    const imageReplaced = list.replaced.has('meta:property:og:image') || list.replaced.has('meta:name:twitter:image');
    if (imageReplaced && twText.imageAlt === undefined && derived('meta:name:twitter:image:alt')) {
      list.remove('meta:name:twitter:image:alt');
    }
    const card = list.find('meta:name:twitter:card');
    if (card !== undefined && twText.card === undefined && derived('meta:name:twitter:card')) {
      const hasImage = list.find('meta:name:twitter:image') !== undefined;
      card.attrs = { ...card.attrs, content: hasImage ? 'summary_large_image' : 'summary' };
    }
  });

  // Extra links
  section(() => {
    for (const link of objects<SeoLinkTag>(merged.links)) {
      const rel = textField(link.rel, 'links[].rel')?.toLowerCase();
      if (rel === undefined) {
        continue;
      }
      const href = url(link.href, `links[${link.key ?? rel}]`);
      if (href === null) {
        continue;
      }
      const attrs: Record<string, string> = { rel, href };
      for (const attr of ['hreflang', 'type', 'media', 'sizes', 'title', 'as', 'fetchpriority', 'referrerpolicy', 'color'] as const) {
        const v = textField(link[attr], `links[].${attr}`);
        if (v) {
          attrs[attr] = v;
        }
      }
      // crossorigin="" is meaningful (anonymous), so an empty string is kept.
      if (typeof link.crossorigin === 'string') {
        attrs['crossorigin'] = link.crossorigin;
      }
      // User keys live in their own namespace so they can never replace a derived tag.
      let key = link.key ? `link:key:${link.key}` : `link:${rel}:${href}`;
      if (rel === 'canonical') {
        key = 'link:canonical';
      } else if (rel === 'alternate' && attrs['hreflang']) {
        key = `link:alternate:${attrs['hreflang'].toLowerCase()}`;
      }
      if (rel === 'canonical' || key.startsWith('link:alternate:')) {
        list.replace(key, 'link', attrs);
      } else {
        list.override(key, 'link', attrs);
      }
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

  // Report the robots value actually emitted, an extra robots meta included.
  const emittedRobots = list.find('meta:name:robots')?.attrs['content'] ?? null;
  return { title, htmlAttrs, tags: list.tags, http, canonical, robots: emittedRobots, droppedUrls };
}
