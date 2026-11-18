import type { HeadTag, ResolvedHead } from './types';

/** Attribute marking elements owned by ngx-seo. Its value is the tag key. */
export const SEO_ATTR = 'data-seo';

const CLAIMED_META_NAMES = new Set(['description', 'keywords', 'author', 'robots']);
const CLAIMED_META_PROPERTY_PREFIXES = ['og:', 'article:', 'profile:', 'book:', 'video:', 'music:'];

function elementsOf(parent: Element): Element[] {
  const out: Element[] = [];
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === 1) {
      out.push(node as Element);
    }
  }
  return out;
}

function tagName(el: Element): string {
  return el.tagName.toLowerCase();
}

/** True when an unmarked element belongs to a family ngx-seo owns outright. */
function isClaimed(el: Element): boolean {
  const tag = tagName(el);
  if (tag === 'meta') {
    const name = el.getAttribute('name');
    if (name !== null) {
      return CLAIMED_META_NAMES.has(name.toLowerCase()) || name.toLowerCase().startsWith('twitter:');
    }
    const property = el.getAttribute('property');
    if (property !== null) {
      return CLAIMED_META_PROPERTY_PREFIXES.some((prefix) => property.toLowerCase().startsWith(prefix));
    }
    return false;
  }
  if (tag === 'link') {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();
    return rel === 'canonical' || (rel === 'alternate' && el.hasAttribute('hreflang'));
  }
  return false;
}

/** Link rels where a page normally has one of each (per sizes/media), whatever the href. */
const SINGLE_RELS = new Set(['icon', 'shortcut icon', 'apple-touch-icon', 'mask-icon', 'manifest']);

function resolvedHref(el: Element): string | null {
  const href = el.getAttribute('href');
  if (href === null) {
    return null;
  }
  const doc = el.ownerDocument;
  try {
    return new URL(href, doc?.baseURI || doc?.location?.href || undefined).href;
  } catch {
    return href;
  }
}

/** True when an unmarked element has the identity of the desired tag. */
function matches(el: Element, tag: HeadTag): boolean {
  if (tagName(el) !== tag.tag) {
    return false;
  }
  const a = tag.attrs;
  if (tag.tag === 'meta') {
    for (const attr of ['name', 'property', 'http-equiv']) {
      if (a[attr] !== undefined) {
        return el.getAttribute(attr) === a[attr];
      }
    }
    return false;
  }
  if (tag.tag === 'link') {
    const rel = el.getAttribute('rel');
    if (rel !== a['rel']) {
      return false;
    }
    if (a['rel'] === 'canonical') {
      return true;
    }
    if (a['rel'] === 'alternate' && a['hreflang'] !== undefined) {
      return el.getAttribute('hreflang') === a['hreflang'];
    }
    if (SINGLE_RELS.has((a['rel'] ?? '').toLowerCase())) {
      return el.getAttribute('sizes') === (a['sizes'] ?? null) && el.getAttribute('media') === (a['media'] ?? null);
    }
    return el.getAttribute('href') === a['href'] || resolvedHref(el) === a['href'];
  }
  return false;
}

/** On `<html>`: the shell's title and attributes, recorded by the server for the browser. */
export const SEO_ORIGINAL_ATTR = 'data-seo-original';
/** On an adopted element outside the claimed families: its attributes before adoption. */
export const SEO_RESTORE_ATTR = 'data-seo-restore';

export interface HeadReconcilerOptions {
  /** Record the shell's title and `<html>` attributes in the document (server rendering). */
  persistOriginals?: boolean;
  /** Restore the original title when no title is resolved. False when another title owner exists. */
  restoreTitle?: boolean;
}

interface Originals {
  title: string;
  lang: string | null;
  dir: string | null;
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Makes a document's head match a resolved head. Owns every element it
 * creates or adopts, marking each with `data-seo`.
 */
export class HeadReconciler {
  private readonly managed = new Map<string, Element>();
  private readonly serverRendered: boolean;
  /** Original values of `<html>` attributes this reconciler (or the server) has changed. */
  private readonly htmlOriginals = new Map<string, string | null>();
  /** The title the document shell had before ngx-seo touched it. */
  private readonly originalTitle: string;
  private readonly restoreTitle: boolean;

  constructor(
    private readonly doc: Document,
    options: HeadReconcilerOptions = {},
  ) {
    this.restoreTitle = options.restoreTitle ?? true;
    const html = doc.documentElement;
    const persisted = html ? parseJson<Originals>(html.getAttribute(SEO_ORIGINAL_ATTR)) : null;
    if (persisted !== null && html) {
      // Hydrating over server output: the shell values come from the server's record.
      this.originalTitle = typeof persisted.title === 'string' ? persisted.title : doc.title;
      for (const name of ['lang', 'dir'] as const) {
        const original = persisted[name] ?? null;
        if (html.getAttribute(name) !== original) {
          this.htmlOriginals.set(name, original);
        }
      }
    } else {
      this.originalTitle = doc.title;
      if (options.persistOriginals && html) {
        const record: Originals = { title: doc.title, lang: html.getAttribute('lang'), dir: html.getAttribute('dir') };
        html.setAttribute(SEO_ORIGINAL_ATTR, JSON.stringify(record));
      }
    }
    for (const el of this.head ? elementsOf(this.head) : []) {
      const key = el.getAttribute(SEO_ATTR);
      if (key !== null && !this.managed.has(key)) {
        this.managed.set(key, el);
      }
    }
    this.serverRendered = this.managed.size > 0;
  }

  private get head(): HTMLHeadElement | null {
    return this.doc.head ?? null;
  }

  /** Whether the document already held ngx-seo tags when this reconciler was created. */
  hasServerRendered(): boolean {
    return this.serverRendered;
  }

  /**
   * Applies the head. A DOM failure affects only the tag it occurred on; the
   * first failure is rethrown after every other tag has been applied.
   */
  apply(head: ResolvedHead): void {
    const root = this.head;
    if (root === null) {
      return;
    }
    let firstError: unknown = undefined;
    let failed = false;
    const attempt = (run: () => void): void => {
      try {
        run();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    };

    attempt(() => {
      const title = head.title ?? (this.restoreTitle ? this.originalTitle : null);
      if (title !== null && this.doc.title !== title) {
        this.doc.title = title;
      }
    });
    attempt(() => this.applyHtmlAttr('lang', head.htmlAttrs.lang));
    attempt(() => this.applyHtmlAttr('dir', head.htmlAttrs.dir));

    const wanted = new Set(head.tags.map((tag) => tag.key));

    // Release managed elements that are no longer wanted.
    for (const [key, el] of [...this.managed]) {
      if (!wanted.has(key)) {
        this.managed.delete(key);
        attempt(() => this.release(el));
      }
    }

    // Create, adopt and update.
    let previous: Element | null = null;
    for (const tag of head.tags) {
      attempt(() => {
        let el = this.managed.get(tag.key) ?? null;
        if (el !== null && tagName(el) !== tag.tag) {
          this.managed.delete(tag.key);
          this.release(el);
          el = null;
        }
        if (el === null) {
          el = elementsOf(root).find((candidate) => !candidate.hasAttribute(SEO_ATTR) && matches(candidate, tag)) ?? null;
          if (el !== null && !isClaimed(el)) {
            el.setAttribute(SEO_RESTORE_ATTR, JSON.stringify(this.snapshot(el)));
          }
        }
        if (el === null) {
          el = this.doc.createElement(tag.tag);
        }
        el.setAttribute(SEO_ATTR, tag.key);
        this.managed.set(tag.key, el);
        this.syncAttributes(el, tag);

        if (previous === null) {
          if (el.parentNode !== root) {
            root.appendChild(el);
          }
        } else if (previous.nextElementSibling !== el) {
          root.insertBefore(el, previous.nextSibling);
        }
        previous = el;
      });
    }

    // Remove unmarked strays in the families ngx-seo owns.
    for (const el of elementsOf(root)) {
      if (!el.hasAttribute(SEO_ATTR) && isClaimed(el)) {
        attempt(() => root.removeChild(el));
      }
    }

    if (failed) {
      throw firstError;
    }
  }

  /** Removes an element ngx-seo created, or hands an adopted one back in its original state. */
  private release(el: Element): void {
    const original = parseJson<{ attrs: Record<string, string>; text: string | null }>(el.getAttribute(SEO_RESTORE_ATTR));
    if (original === null) {
      el.parentNode?.removeChild(el);
      return;
    }
    for (const name of Array.from(el.attributes, (attr) => attr.name)) {
      el.removeAttribute(name);
    }
    for (const [name, value] of Object.entries(original.attrs)) {
      el.setAttribute(name, value);
    }
    if (original.text !== null && el.textContent !== original.text) {
      el.textContent = original.text;
    }
  }

  private snapshot(el: Element): { attrs: Record<string, string>; text: string | null } {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      attrs[attr.name] = attr.value;
    }
    return { attrs, text: tagName(el) === 'script' || tagName(el) === 'style' ? el.textContent : null };
  }

  private syncAttributes(el: Element, tag: HeadTag): void {
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value);
      }
    }
    for (const name of Array.from(el.attributes, (attr) => attr.name)) {
      if (name !== SEO_ATTR && name !== SEO_RESTORE_ATTR && !(name in tag.attrs)) {
        el.removeAttribute(name);
      }
    }
    if (tag.text !== undefined && el.textContent !== tag.text) {
      el.textContent = tag.text;
    }
  }

  private applyHtmlAttr(name: 'lang' | 'dir', value: string | undefined): void {
    const html = this.doc.documentElement;
    if (!html) {
      return;
    }
    if (value !== undefined) {
      if (!this.htmlOriginals.has(name)) {
        this.htmlOriginals.set(name, html.getAttribute(name));
      }
      if (html.getAttribute(name) !== value) {
        html.setAttribute(name, value);
      }
      return;
    }
    if (this.htmlOriginals.has(name)) {
      const original = this.htmlOriginals.get(name) ?? null;
      this.htmlOriginals.delete(name);
      if (original === null) {
        html.removeAttribute(name);
      } else {
        html.setAttribute(name, original);
      }
    }
  }
}
