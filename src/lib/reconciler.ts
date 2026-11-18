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
    return el.getAttribute('href') === a['href'];
  }
  return false;
}

/**
 * Makes a document's head match a resolved head. Owns every element it
 * creates or adopts, marking each with `data-seo`.
 */
export class HeadReconciler {
  private readonly managed = new Map<string, Element>();
  private readonly serverRendered: boolean;
  /** Original values of `<html>` attributes this reconciler has changed. */
  private readonly htmlOriginals = new Map<string, string | null>();
  /** The title the document had before ngx-seo touched it. */
  private readonly originalTitle: string;

  constructor(private readonly doc: Document) {
    this.originalTitle = doc.title;
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

  apply(head: ResolvedHead): void {
    const root = this.head;
    if (root === null) {
      return;
    }

    const title = head.title ?? this.originalTitle;
    if (this.doc.title !== title) {
      this.doc.title = title;
    }
    this.applyHtmlAttr('lang', head.htmlAttrs.lang);
    this.applyHtmlAttr('dir', head.htmlAttrs.dir);

    const wanted = new Set(head.tags.map((tag) => tag.key));

    // Drop managed elements that are no longer wanted.
    for (const [key, el] of this.managed) {
      if (!wanted.has(key)) {
        el.parentNode?.removeChild(el);
        this.managed.delete(key);
      }
    }

    // Create, adopt and update.
    let previous: Element | null = null;
    for (const tag of head.tags) {
      let el = this.managed.get(tag.key) ?? null;
      if (el !== null && tagName(el) !== tag.tag) {
        el.parentNode?.removeChild(el);
        el = null;
      }
      if (el === null) {
        el = elementsOf(root).find((candidate) => !candidate.hasAttribute(SEO_ATTR) && matches(candidate, tag)) ?? null;
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
    }

    // Remove unmarked strays in the families ngx-seo owns.
    for (const el of elementsOf(root)) {
      if (!el.hasAttribute(SEO_ATTR) && isClaimed(el)) {
        root.removeChild(el);
      }
    }
  }

  private syncAttributes(el: Element, tag: HeadTag): void {
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value);
      }
    }
    for (const name of Array.from(el.attributes, (attr) => attr.name)) {
      if (name !== SEO_ATTR && !(name in tag.attrs)) {
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
