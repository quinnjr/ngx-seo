import type { SeoConfig, SeoRemoval } from './types';

type Bag = Record<string, unknown>;
type KeyFn = (item: Bag) => string | undefined;

/** Marks the inherited keyed-list item with this key for removal. */
export function removeItem(key: string): SeoRemoval {
  return { $remove: key };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Lists whose items from every layer are combined, with the function that identifies an item. */
const KEYED_LISTS: Record<string, KeyFn> = {
  jsonLd: (item) => text(item['@id']),
  alternates: (item) => text(item['hreflang'])?.toLowerCase(),
  meta: (item) => text(item['key']) ?? metaIdentity(item),
  links: (item) => text(item['key']) ?? linkKey(item),
  'openGraph.images': (item) => text(item['url']),
};

/**
 * The merge key of a link without an explicit `key`: `canonical` for the
 * single canonical link, `alternate|<hreflang>` for language alternates,
 * otherwise `<rel>|<href as written>`.
 */
function linkKey(item: Bag): string {
  const rel = String(item['rel']).toLowerCase();
  if (rel === 'canonical') {
    return 'canonical';
  }
  if (rel === 'alternate' && text(item['hreflang'])) {
    return `alternate|${String(item['hreflang']).toLowerCase()}`;
  }
  return `${rel}|${String(item['href'])}`;
}

/**
 * A meta tag's identity without an explicit `key`: its name, property or
 * http-equiv, plus `|<media>` when it has a media query (theme-color variants).
 */
function metaIdentity(item: Bag): string | undefined {
  const identity = (text(item['name']) ?? text(item['property']) ?? text(item['httpEquiv']))?.toLowerCase();
  const media = text(item['media']);
  return identity === undefined ? undefined : media === undefined ? identity : `${identity}|${media}`;
}

/** A user-written key in the form `mergeKeyedList` derives it, for lists HTML compares case-insensitively. */
function normaliseKey(path: string, key: string): string {
  if (path === 'alternates') {
    return key.toLowerCase();
  }
  if (path === 'meta') {
    return key.replace(/^[^|]*/, (identity) => identity.toLowerCase());
  }
  if (path === 'links') {
    const bar = key.indexOf('|');
    if (bar === -1) {
      return key.toLowerCase() === 'canonical' ? 'canonical' : key;
    }
    const rel = key.slice(0, bar).toLowerCase();
    const rest = key.slice(bar + 1);
    return rel === 'alternate' ? `${rel}|${rest.toLowerCase()}` : `${rel}|${rest}`;
  }
  return key;
}

/** Keyed lists where higher layers come first. */
const HIGHER_FIRST = new Set(['openGraph.images']);

/** Lists whose keys are compared case-insensitively, as their HTML counterparts are. */
const CASE_INSENSITIVE = new Set(['alternates', 'meta', 'links']);

/** Plain lists where a single object or string stands for a one-item list. */
const WHOLE_LISTS = new Set(['openGraph.videos', 'openGraph.audio']);

/** Values that are replaced whole instead of merged field by field. */
const ATOMIC_OBJECTS = new Set(['image']);

/** Keys that could reach an object's prototype; never copied. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeEntries(value: Bag): [string, unknown][] {
  return Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key));
}

function isPlainObject(value: unknown): value is Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value === Object.prototype) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A class instance (a DTO, say) read as a plain object of its own fields.
 * Dates and other built-ins with meaning beyond their fields are left alone.
 */
function asPlain(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    isPlainObject(value) ||
    value instanceof Date ||
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    return value;
  }
  return { ...(value as Bag) };
}

function isRemoval(value: unknown): value is SeoRemoval {
  return isPlainObject(value) && typeof value['$remove'] === 'string';
}

/**
 * Stands in for a reference cycle. JSON.stringify rejects BigInt, so a
 * JSON-LD node containing a cycle is dropped at serialisation time.
 */
const CYCLE = BigInt(0);

function cloneValue(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) {
      return CYCLE;
    }
    ancestors.add(value);
    let out: unknown;
    if (Array.isArray(value)) {
      out = value.map((item) => cloneValue(item, ancestors));
    } else {
      const copy: Bag = {};
      for (const [key, inner] of safeEntries(value)) {
        copy[key] = cloneValue(inner, ancestors);
      }
      out = copy;
    }
    ancestors.delete(value);
    return out;
  }
  return value;
}

function mergeKeyedList(
  existing: unknown[],
  incoming: unknown[],
  path: string,
  onError: (error: unknown) => void,
): unknown[] {
  const keyOf = KEYED_LISTS[path] as KeyFn;
  const higherFirst = HIGHER_FIRST.has(path);
  const result = [...existing];
  const fresh: unknown[] = [];

  /**
   * Whether an item has the given key. Explicit `key`s and link hrefs are
   * compared exactly; derived identities that HTML treats case-insensitively
   * (meta names, rel, hreflang) are compared against the key normalised the
   * same way, so `removeItem('en-US')` matches what was written as `en-US`.
   */
  const matchesKey = (item: Bag, key: string): boolean => {
    const own = keyOf(item);
    if (own === undefined) {
      return false;
    }
    if (own === key || !CASE_INSENSITIVE.has(path) || text(item['key']) !== undefined) {
      return own === key;
    }
    return own === normaliseKey(path, key);
  };
  const indexOfKey = (list: unknown[], key: string): number =>
    list.findIndex((item) => isPlainObject(item) && matchesKey(item, key));
  /** Removes every item with this key; returns where the first one was, or -1. */
  const removeAll = (list: unknown[], key: string): number => {
    let first = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      if (isPlainObject(item) && matchesKey(item, key)) {
        list.splice(i, 1);
        first = i;
      }
    }
    return first;
  };
  // Repeated meta (video:tag, article:tag, …) without an explicit key: a layer's
  // items with one identity form a group, all kept, replacing lower groups.
  const groupedMeta = path === 'meta';
  /** Meta items this layer has placed, so they are never mistaken for lower ones. */
  const thisLayer = new Set<unknown>();
  /** Removes every matching item; returns where the first one was, or -1. */
  const removeWhere = (list: unknown[], match: (item: Bag) => boolean): number => {
    let first = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      if (isPlainObject(item) && match(item)) {
        list.splice(i, 1);
        first = i;
      }
    }
    return first;
  };
  /** Where the next item of a claimed group goes in `result`; -1 means append to `fresh`. */
  const groupSlots = new Map<string, number>();

  for (const raw of incoming) {
    // A bare URL is accepted where an image object is expected.
    const item = path === 'openGraph.images' && typeof raw === 'string' && raw !== '' ? { url: raw } : raw;
    if (isRemoval(item)) {
      removeAll(result, item.$remove);
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      if (item !== null && item !== undefined) {
        onError(new Error(`ngx-seo: ignored an item of ${path}: expected an object`));
      }
      continue;
    }
    // Class instances (e.g. from a schema library) are copied as plain objects.
    const plain: Bag = isPlainObject(item) ? item : { ...(item as Bag) };
    // An item without its value ('' or missing content/href, e.g. an empty CMS field) has no opinion.
    // A value of the wrong type is kept, so derivation can report it.
    const missing = (field: string): boolean =>
      plain[field] === undefined || plain[field] === null || (typeof plain[field] === 'string' && (plain[field] as string).trim() === '');
    if ((path === 'meta' && missing('content')) || ((path === 'alternates' || path === 'links') && missing('href'))) {
      continue;
    }
    const copy = cloneValue(plain);
    const key = keyOf(plain);
    if (key === undefined) {
      fresh.push(copy);
      continue;
    }
    if (groupedMeta) {
      const explicit = text(plain['key']);
      if (explicit !== undefined) {
        // The same explicit key twice in one layer: the later item wins.
        const sameLayer = [...thisLayer].find((entry) => isPlainObject(entry) && matchesKey(entry, explicit));
        if (sameLayer !== undefined) {
          const list = result.includes(sameLayer) ? result : fresh;
          list[list.indexOf(sameLayer)] = copy;
          thisLayer.delete(sameLayer);
          thisLayer.add(copy);
          continue;
        }
      }
      const identity = metaIdentity(plain);
      const group = (identity ?? key).toLowerCase();
      if (!groupSlots.has(group)) {
        // The group replaces lower items with this identity or key, in place.
        groupSlots.set(
          group,
          removeWhere(
            result,
            (entry) =>
              !thisLayer.has(entry) &&
              ((identity !== undefined && metaIdentity(entry)?.toLowerCase() === identity.toLowerCase()) ||
                (explicit !== undefined && matchesKey(entry, explicit))),
          ),
        );
      }
      thisLayer.add(copy);
      const slot = groupSlots.get(group) as number;
      if (slot === -1) {
        fresh.push(copy);
      } else {
        result.splice(slot, 0, copy);
        groupSlots.set(group, slot + 1);
      }
      continue;
    }
    const inFresh = indexOfKey(fresh, key);
    if (inFresh !== -1) {
      fresh[inFresh] = copy;
      continue;
    }
    const at = indexOfKey(result, key);
    if (at === -1) {
      fresh.push(copy);
    } else if (higherFirst) {
      result.splice(at, 1);
      fresh.push(copy);
    } else {
      result[at] = copy;
    }
  }

  return higherFirst ? [...fresh, ...result] : [...result, ...fresh];
}

/**
 * Merges `source` into `target`. `identity` is the object as the caller wrote
 * it: a class instance is read through a fresh plain copy, so cycles are
 * tracked by the original object, never by the copy.
 */
function mergeObject(
  target: Bag,
  source: Bag,
  path: string,
  ancestors: Set<object>,
  onError: (error: unknown) => void,
  identity: object = source,
): void {
  if (ancestors.has(identity)) {
    onError(new Error(`ngx-seo: dropped a cyclic value at ${path || 'the top level'}`));
    return;
  }
  ancestors.add(identity);
  try {
    mergeFields(target, source, path, ancestors, onError);
  } finally {
    ancestors.delete(identity);
  }
}

function mergeFields(
  target: Bag,
  source: Bag,
  path: string,
  ancestors: Set<object>,
  onError: (error: unknown) => void,
): void {
  for (const [rawKey, rawValue] of safeEntries(source)) {
    // Header names are case-insensitive, so a null can remove any casing.
    // Header and crawler names are case-insensitive, so any casing merges and a null removes it.
    const key = path === 'http.headers' || path === 'bots' ? rawKey.toLowerCase() : rawKey;
    // Checked again after normalisation: "__PROTO__" must not become "__proto__".
    if (UNSAFE_KEYS.has(key)) {
      continue;
    }
    const here = path === '' ? key : `${path}.${key}`;
    const value = asPlain(rawValue);

    // undefined, '' and whitespace-only text have no opinion.
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
      continue;
    }
    // An image without a URL (e.g. an empty CMS field) has no opinion.
    if (here === 'image' && isPlainObject(value) && !isSet(value['url'])) {
      continue;
    }
    if (value === null) {
      delete target[key];
      continue;
    }
    if (Object.hasOwn(KEYED_LISTS, here)) {
      // A single string or object where a list is expected counts as a one-item list.
      const list = typeof value === 'string' || isPlainObject(value) ? [value] : value;
      if (!Array.isArray(list)) {
        onError(new Error(`ngx-seo: ignored ${here}: expected a list`));
        continue;
      }
      const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
      target[key] = mergeKeyedList(existing, list, here, onError);
      continue;
    }
    // A single media object or URL counts as a one-item list, replaced whole.
    const listValue = WHOLE_LISTS.has(here) && (typeof value === 'string' || isPlainObject(value)) ? [value] : value;
    if (Array.isArray(listValue)) {
      target[key] = listValue.filter((item) => item !== null && item !== undefined && item !== '').map((item) => cloneValue(item));
      continue;
    }
    if (isPlainObject(value) && typeof rawValue === 'object' && rawValue !== null && ancestors.has(rawValue)) {
      onError(new Error(`ngx-seo: dropped a cyclic value at ${here}`));
      continue;
    }
    if (isPlainObject(value) && !ATOMIC_OBJECTS.has(here)) {
      const existing = Object.hasOwn(target, key) ? target[key] : undefined;
      // An object never merges into a non-object (e.g. a raw robots string): it replaces it.
      const base: Bag = isPlainObject(existing) ? existing : {};
      if (!isPlainObject(existing)) {
        target[key] = base;
      }
      mergeObject(base, value, here, ancestors, onError, rawValue as object);
      continue;
    }
    target[key] = cloneValue(value);
  }
}

/** Meta names/properties each first-class field produces; `*` marks a prefix. */
const FIELD_META: Record<string, string[]> = {
  title: ['og:title', 'twitter:title'],
  description: ['description', 'og:description', 'twitter:description'],
  keywords: ['keywords'],
  author: ['author'],
  robots: ['robots'],
  image: ['og:image*', 'twitter:image*'],
  canonical: ['og:url'],
};
// Each field also releases the tags derived from it (Twitter falls back to Open Graph).
const OG_META: Record<string, string[]> = {
  title: ['og:title', 'twitter:title'],
  description: ['og:description', 'twitter:description'],
  type: ['og:type'],
  url: ['og:url'],
  siteName: ['og:site_name'],
  locale: ['og:locale'],
  alternateLocales: ['og:locale:alternate'],
  images: ['og:image*', 'twitter:image*'],
  videos: ['og:video*'],
  audio: ['og:audio*'],
};
/** Per-subfield claims: a subfield claims only the tag it produces. */
const OG_NESTED_META: Record<string, Record<string, string[]>> = {
  article: {
    publishedTime: ['article:published_time'],
    modifiedTime: ['article:modified_time'],
    expirationTime: ['article:expiration_time'],
    authors: ['article:author'],
    section: ['article:section'],
    tags: ['article:tag'],
  },
  profile: {
    firstName: ['profile:first_name'],
    lastName: ['profile:last_name'],
    username: ['profile:username'],
    gender: ['profile:gender'],
  },
  book: {
    authors: ['book:author'],
    isbn: ['book:isbn'],
    releaseDate: ['book:release_date'],
    tags: ['book:tag'],
  },
};
const TWITTER_META: Record<string, string[]> = {
  card: ['twitter:card'],
  site: ['twitter:site'],
  creator: ['twitter:creator'],
  title: ['twitter:title'],
  description: ['twitter:description'],
  image: ['twitter:image'],
  imageAlt: ['twitter:image:alt'],
};

/** Whether a media field holds a real item: a URL, or an object with a URL (not just removals or blanks). */
function hasMediaItem(value: unknown): boolean {
  const list = Array.isArray(value) ? value : [value];
  return list.some((item) =>
    typeof item === 'string' ? item.trim() !== '' : isPlainObject(item) && !isRemoval(item) && typeof item['url'] === 'string' && item['url'].trim() !== '',
  );
}

/** The same rule as merging: undefined, '' and whitespace-only text have no opinion. */
function isSet(value: unknown): boolean {
  return value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

/**
 * When a layer sets a first-class field, extra `meta` and `links` from lower
 * layers that produce the same tag give way to it, so the higher layer wins
 * whichever way each layer expressed the tag.
 */
/**
 * The layer as merging reads it: class instances seen as plain objects, a few
 * levels deep (enough for every field the claims inspect), cycle-safe.
 */
function plainView(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => plainView(item, depth + 1, seen));
    }
    const plain = asPlain(value);
    if (!isPlainObject(plain)) {
      return plain;
    }
    const out: Bag = {};
    for (const [key, inner] of safeEntries(plain)) {
      out[key] = plainView(inner, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function releaseClaimedExtras(result: Bag, rawLayer: Bag): void {
  const layer = plainView(rawLayer) as Bag;
  const claims: string[] = [];
  for (const [field, metas] of Object.entries(FIELD_META)) {
    const value = layer[field];
    // An image without a URL has no opinion, so it claims nothing.
    const imageWithoutUrl = field === 'image' && isPlainObject(value) && !isSet(value['url']);
    if (isSet(value) && !imageWithoutUrl) {
      claims.push(...metas);
    }
  }
  for (const [group, table] of [['openGraph', OG_META], ['twitter', TWITTER_META]] as const) {
    const value = layer[group];
    if (isPlainObject(value)) {
      for (const [field, metas] of Object.entries(table)) {
        const media = group === 'openGraph' && (field === 'images' || field === 'videos' || field === 'audio');
        if (isSet(value[field]) && (!media || hasMediaItem(value[field]))) {
          claims.push(...metas);
        }
      }
    }
  }
  const openGraph = layer['openGraph'];
  if (isPlainObject(openGraph) && ['article', 'profile', 'book'].some((object) => isPlainObject(openGraph[object]))) {
    // og:type is derived from article, profile or book data.
    claims.push('og:type');
  }
  if (isPlainObject(openGraph)) {
    for (const [object, table] of Object.entries(OG_NESTED_META)) {
      const nested = openGraph[object];
      if (isPlainObject(nested)) {
        for (const [field, metas] of Object.entries(table)) {
          if (isSet(nested[field])) {
            claims.push(...metas);
          }
        }
      }
    }
  }
  if (isPlainObject(layer['bots'])) {
    // Only crawlers given a real value claim; an undefined entry has no opinion.
    for (const [bot, directives] of Object.entries(layer['bots'])) {
      if (isSet(directives) && directives !== null) {
        claims.push(bot.toLowerCase());
      }
    }
  }
  const claimed = (identity: string): boolean =>
    claims.some((claim) => (claim.endsWith('*') ? identity.startsWith(claim.slice(0, -1)) : identity === claim));

  if (claims.length > 0 && Array.isArray(result['meta'])) {
    result['meta'] = result['meta'].filter((item) => {
      if (!isPlainObject(item)) {
        return true;
      }
      const identity = (text(item['name']) ?? text(item['property']))?.toLowerCase();
      return identity === undefined || !claimed(identity);
    });
  }

  if (Array.isArray(result['links'])) {
    const ownsCanonical = isSet(layer['canonical']);
    const alternates = layer['alternates'];
    const hreflangs = new Set(
      (isPlainObject(alternates) ? [alternates] : Array.isArray(alternates) ? alternates : [])
        .filter(isPlainObject)
        // An alternate without an href has no opinion (it is skipped when merging), so it claims nothing.
        .filter((item) => isSet(item['href']) && item['href'] !== null)
        .map((item) => text(item['hreflang'])?.toLowerCase())
        .filter((value): value is string => value !== undefined),
    );
    if (ownsCanonical || hreflangs.size > 0) {
      result['links'] = result['links'].filter((item) => {
        if (!isPlainObject(item)) {
          return true;
        }
        const rel = text(item['rel'])?.toLowerCase();
        if (rel === 'canonical') {
          return !ownsCanonical;
        }
        const hreflang = text(item['hreflang'])?.toLowerCase();
        return !(rel === 'alternate' && hreflang !== undefined && hreflangs.has(hreflang));
      });
    }
  }
}

/**
 * Merges layers, lowest priority first, into one config. The result contains
 * no `null`, no empty strings and no removal markers.
 */
export function mergeLayers(layers: readonly SeoConfig[], onError: (error: unknown) => void = () => {}): SeoConfig {
  const result: Bag = {};
  for (const layer of layers) {
    const plain = asPlain(layer);
    if (isPlainObject(plain)) {
      releaseClaimedExtras(result, plain);
      mergeObject(result, plain, '', new Set(), onError, layer as object);
    }
  }
  return result as SeoConfig;
}
