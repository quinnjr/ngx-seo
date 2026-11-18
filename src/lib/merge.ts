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
  meta: (item) =>
    text(item['key']) ?? (text(item['name']) ?? text(item['property']) ?? text(item['httpEquiv']))?.toLowerCase(),
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

/** Keyed lists where higher layers come first. */
const HIGHER_FIRST = new Set(['openGraph.images']);

/** Lists whose keys are compared case-insensitively, as their HTML counterparts are. */
const CASE_INSENSITIVE = new Set(['alternates', 'meta', 'links']);

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

function mergeKeyedList(existing: unknown[], incoming: unknown[], path: string): unknown[] {
  const keyOf = KEYED_LISTS[path] as KeyFn;
  const higherFirst = HIGHER_FIRST.has(path);
  const result = [...existing];
  const fresh: unknown[] = [];

  const same = CASE_INSENSITIVE.has(path)
    ? (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase()
    : (a: string | undefined, b: string): boolean => a === b;
  const indexOfKey = (list: unknown[], key: string): number =>
    list.findIndex((item) => isPlainObject(item) && same(keyOf(item), key));

  for (const raw of incoming) {
    // A bare URL is accepted where an image object is expected.
    const item = path === 'openGraph.images' && typeof raw === 'string' && raw !== '' ? { url: raw } : raw;
    if (isRemoval(item)) {
      const at = indexOfKey(result, item.$remove);
      if (at !== -1) {
        result.splice(at, 1);
      }
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    // Class instances (e.g. from a schema library) are copied as plain objects.
    const plain: Bag = isPlainObject(item) ? item : { ...(item as Bag) };
    const copy = cloneValue(plain);
    const key = keyOf(plain);
    if (key === undefined) {
      fresh.push(copy);
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

function mergeObject(
  target: Bag,
  source: Bag,
  path: string,
  ancestors: Set<object>,
  onError: (error: unknown) => void,
): void {
  if (ancestors.has(source)) {
    onError(new Error(`ngx-seo: dropped a cyclic value at ${path || 'the top level'}`));
    return;
  }
  ancestors.add(source);
  try {
    mergeFields(target, source, path, ancestors, onError);
  } finally {
    ancestors.delete(source);
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
    const key = path === 'http.headers' ? rawKey.toLowerCase() : rawKey;
    // Checked again after normalisation: "__PROTO__" must not become "__proto__".
    if (UNSAFE_KEYS.has(key)) {
      continue;
    }
    const here = path === '' ? key : `${path}.${key}`;
    const value = asPlain(rawValue);

    if (value === undefined || value === '') {
      continue;
    }
    // An image without a URL (e.g. an empty CMS field) has no opinion.
    if (here === 'image' && isPlainObject(value) && !text(value['url'])) {
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
      target[key] = mergeKeyedList(existing, list, here);
      continue;
    }
    if (Array.isArray(value)) {
      target[key] = value.filter((item) => item !== null && item !== undefined && item !== '').map((item) => cloneValue(item));
      continue;
    }
    if (isPlainObject(value) && ancestors.has(value)) {
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
      mergeObject(base, value, here, ancestors, onError);
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
const OG_META: Record<string, string[]> = {
  title: ['og:title'],
  description: ['og:description'],
  type: ['og:type'],
  url: ['og:url'],
  siteName: ['og:site_name'],
  locale: ['og:locale'],
  alternateLocales: ['og:locale:alternate'],
  images: ['og:image*'],
  videos: ['og:video*'],
  audio: ['og:audio*'],
  article: ['article:*'],
  profile: ['profile:*'],
  book: ['book:*'],
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

function isSet(value: unknown): boolean {
  return value !== undefined && value !== '';
}

/**
 * When a layer sets a first-class field, extra `meta` and `links` from lower
 * layers that produce the same tag give way to it, so the higher layer wins
 * whichever way each layer expressed the tag.
 */
function releaseClaimedExtras(result: Bag, layer: Bag): void {
  const claims: string[] = [];
  for (const [field, metas] of Object.entries(FIELD_META)) {
    if (isSet(layer[field])) {
      claims.push(...metas);
    }
  }
  for (const [group, table] of [['openGraph', OG_META], ['twitter', TWITTER_META]] as const) {
    const value = layer[group];
    if (isPlainObject(value)) {
      for (const [field, metas] of Object.entries(table)) {
        if (isSet(value[field])) {
          claims.push(...metas);
        }
      }
    }
  }
  if (isPlainObject(layer['bots'])) {
    claims.push(...Object.keys(layer['bots']).map((bot) => bot.toLowerCase()));
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
    const hreflangs = new Set(
      (Array.isArray(layer['alternates']) ? layer['alternates'] : [])
        .filter(isPlainObject)
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
      mergeObject(result, plain, '', new Set(), onError);
    }
  }
  return result as SeoConfig;
}
