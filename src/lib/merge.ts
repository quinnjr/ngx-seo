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
  alternates: (item) => text(item['hreflang']),
  meta: (item) => text(item['key']) ?? text(item['name']) ?? text(item['property']) ?? text(item['httpEquiv']),
  links: (item) => text(item['key']) ?? `${String(item['rel'])}|${String(item['href'])}`,
  'openGraph.images': (item) => text(item['url']),
};

/** Keyed lists where higher layers come first. */
const HIGHER_FIRST = new Set(['openGraph.images']);

/** Values that are replaced whole instead of merged field by field. */
const ATOMIC_OBJECTS = new Set(['image']);

function isPlainObject(value: unknown): value is Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
      for (const [key, inner] of Object.entries(value)) {
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
  const keyOf = KEYED_LISTS[path];
  const higherFirst = HIGHER_FIRST.has(path);
  const result = [...existing];
  const fresh: unknown[] = [];

  const indexOfKey = (list: unknown[], key: string): number =>
    list.findIndex((item) => isPlainObject(item) && keyOf(item) === key);

  for (const item of incoming) {
    if (isRemoval(item)) {
      const at = indexOfKey(result, item.$remove);
      if (at !== -1) {
        result.splice(at, 1);
      }
      continue;
    }
    if (!isPlainObject(item)) {
      continue;
    }
    const copy = cloneValue(item);
    const key = keyOf(item);
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

function mergeObject(target: Bag, source: Bag, path: string): void {
  for (const [key, value] of Object.entries(source)) {
    const here = path === '' ? key : `${path}.${key}`;

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
    if (here in KEYED_LISTS) {
      if (Array.isArray(value)) {
        const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
        target[key] = mergeKeyedList(existing, value, here);
      }
      continue;
    }
    if (Array.isArray(value)) {
      target[key] = value.filter((item) => item !== null && item !== undefined && item !== '').map((item) => cloneValue(item));
      continue;
    }
    if (isPlainObject(value) && !ATOMIC_OBJECTS.has(here)) {
      const existing = target[key];
      // An object never merges into a non-object (e.g. a raw robots string): it replaces it.
      const base: Bag = isPlainObject(existing) ? existing : {};
      if (!isPlainObject(existing)) {
        target[key] = base;
      }
      mergeObject(base, value, here);
      continue;
    }
    target[key] = cloneValue(value);
  }
}

/**
 * Merges layers, lowest priority first, into one config. The result contains
 * no `null`, no empty strings and no removal markers.
 */
export function mergeLayers(layers: readonly SeoConfig[]): SeoConfig {
  const result: Bag = {};
  for (const layer of layers) {
    if (isPlainObject(layer)) {
      mergeObject(result, layer, '');
    }
  }
  return result as SeoConfig;
}
