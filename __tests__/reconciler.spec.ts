import { describe, it, expect, beforeEach } from 'vitest';
import { HeadReconciler, SEO_ATTR } from '../src/lib/reconciler';
import type { HeadTag, ResolvedHead } from '../src/lib/types';

function makeDoc(head = '', htmlAttrs = ''): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html ${htmlAttrs}><head><title>Initial</title>${head}</head><body></body></html>`,
    'text/html',
  );
}

function headOf(tags: HeadTag[], extra: Partial<ResolvedHead> = {}): ResolvedHead {
  return { title: null, htmlAttrs: {}, tags, http: { headers: {} }, canonical: null, robots: null, droppedUrls: [], ...extra };
}

const description = (content: string): HeadTag => ({
  key: 'meta:name:description',
  tag: 'meta',
  attrs: { name: 'description', content },
});
const canonical = (href: string): HeadTag => ({ key: 'link:canonical', tag: 'link', attrs: { rel: 'canonical', href } });
const jsonLd = (text: string): HeadTag => ({ key: 'script:jsonld', tag: 'script', attrs: { type: 'application/ld+json' }, text });

function managed(doc: Document): string[] {
  return Array.from(doc.head.querySelectorAll(`[${SEO_ATTR}]`)).map((el) => el.getAttribute(SEO_ATTR) as string);
}

describe('HeadReconciler', () => {
  let doc: Document;

  beforeEach(() => {
    doc = makeDoc();
  });

  it('creates marked meta, link and script elements', () => {
    new HeadReconciler(doc).apply(headOf([description('D'), canonical('https://x.test/'), jsonLd('{"a":1}')]));
    expect(managed(doc)).toEqual(['meta:name:description', 'link:canonical', 'script:jsonld']);
    expect(doc.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('D');
    expect(doc.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://x.test/');
    const script = doc.head.querySelector('script[type="application/ld+json"]');
    expect(script?.textContent).toBe('{"a":1}');
    expect(script?.children.length).toBe(0);
  });

  it('updates an element in place', () => {
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([description('A')]));
    const element = doc.head.querySelector('meta[name="description"]');
    reconciler.apply(headOf([description('B')]));
    expect(doc.head.querySelector('meta[name="description"]')).toBe(element);
    expect(element?.getAttribute('content')).toBe('B');
  });

  it('removes an element whose key is gone', () => {
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([description('A'), canonical('https://x.test/')]));
    reconciler.apply(headOf([canonical('https://x.test/')]));
    expect(doc.head.querySelector('meta[name="description"]')).toBeNull();
    expect(managed(doc)).toEqual(['link:canonical']);
  });

  it('adopts unmarked tags from index.html instead of duplicating them, and can later remove them', () => {
    doc = makeDoc('<meta name="description" content="old"><link rel="canonical" href="https://x.test/old">');
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([description('new'), canonical('https://x.test/new')]));
    expect(doc.head.querySelectorAll('meta[name="description"]').length).toBe(1);
    expect(doc.head.querySelectorAll('link[rel="canonical"]').length).toBe(1);
    expect(doc.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('new');
    reconciler.apply(headOf([]));
    expect(doc.head.querySelector('meta[name="description"]')).toBeNull();
    expect(doc.head.querySelector('link[rel="canonical"]')).toBeNull();
  });

  it('removes unmatched strays from claimed families', () => {
    doc = makeDoc(
      '<meta name="keywords" content="home"><meta property="og:locale" content="en_US">' +
        '<link rel="alternate" hreflang="fr" href="https://x.test/fr"><meta name="twitter:site" content="@x">',
    );
    new HeadReconciler(doc).apply(headOf([description('D')]));
    expect(doc.head.querySelector('meta[name="keywords"]')).toBeNull();
    expect(doc.head.querySelector('meta[property="og:locale"]')).toBeNull();
    expect(doc.head.querySelector('link[rel="alternate"]')).toBeNull();
    expect(doc.head.querySelector('meta[name="twitter:site"]')).toBeNull();
  });

  it('never touches unrelated elements', () => {
    doc = makeDoc(
      '<meta name="viewport" content="width=device-width"><script type="application/ld+json" id="other">{}</script>' +
        '<link rel="alternate" type="application/rss+xml" href="/feed"><link rel="stylesheet" href="/s.css">',
    );
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([description('D'), jsonLd('{}')]));
    reconciler.apply(headOf([]));
    expect(doc.head.querySelector('meta[name="viewport"]')).not.toBeNull();
    expect(doc.getElementById('other')).not.toBeNull();
    expect(doc.head.querySelector('link[type="application/rss+xml"]')).not.toBeNull();
    expect(doc.head.querySelector('link[rel="stylesheet"]')).not.toBeNull();
  });

  it('adopts an unmarked extra meta with the same identity', () => {
    doc = makeDoc('<meta name="theme-color" content="red">');
    new HeadReconciler(doc).apply(
      headOf([{ key: 'meta:name:theme-color', tag: 'meta', attrs: { name: 'theme-color', content: 'blue' } }]),
    );
    const all = doc.head.querySelectorAll('meta[name="theme-color"]');
    expect(all.length).toBe(1);
    expect(all[0].getAttribute('content')).toBe('blue');
  });

  it('adopts repeated properties one element at a time', () => {
    doc = makeDoc('<meta property="og:image" content="a"><meta property="og:image" content="b">');
    new HeadReconciler(doc).apply(
      headOf([
        { key: 'meta:property:og:image', tag: 'meta', attrs: { property: 'og:image', content: '1' } },
        { key: 'meta:property:og:image#1', tag: 'meta', attrs: { property: 'og:image', content: '2' } },
      ]),
    );
    expect(Array.from(doc.head.querySelectorAll('meta[property="og:image"]')).map((e) => e.getAttribute('content'))).toEqual([
      '1',
      '2',
    ]);
  });

  it('sets the document title and leaves the original alone for a null title', () => {
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([], { title: null }));
    expect(doc.title).toBe('Initial');
    reconciler.apply(headOf([], { title: 'T' }));
    expect(doc.title).toBe('T');
  });

  it('sets lang and dir and restores only what it changed', () => {
    doc = makeDoc('', 'lang="en"');
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([], { htmlAttrs: { lang: 'fr', dir: 'rtl' } }));
    expect(doc.documentElement.getAttribute('lang')).toBe('fr');
    expect(doc.documentElement.getAttribute('dir')).toBe('rtl');
    reconciler.apply(headOf([]));
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.documentElement.hasAttribute('dir')).toBe(false);
  });

  it('leaves an untouched html lang in place', () => {
    doc = makeDoc('', 'lang="en"');
    new HeadReconciler(doc).apply(headOf([]));
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
  });

  it('keeps managed elements in resolved order when one is inserted in the middle', () => {
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([description('D'), jsonLd('{}')]));
    reconciler.apply(headOf([description('D'), canonical('https://x.test/'), jsonLd('{}')]));
    expect(managed(doc)).toEqual(['meta:name:description', 'link:canonical', 'script:jsonld']);
  });

  it('removes attributes that are no longer wanted', () => {
    const reconciler = new HeadReconciler(doc);
    const link: HeadTag = { key: 'link:x', tag: 'link', attrs: { rel: 'next', href: 'https://x.test/2', title: 'T' } };
    reconciler.apply(headOf([link]));
    reconciler.apply(headOf([{ ...link, attrs: { rel: 'next', href: 'https://x.test/2' } }]));
    expect(doc.head.querySelector('link[rel="next"]')?.hasAttribute('title')).toBe(false);
  });

  it('reports server-rendered tags and adopts them by key', () => {
    doc = makeDoc(`<meta ${SEO_ATTR}="meta:name:description" name="description" content="ssr">`);
    const reconciler = new HeadReconciler(doc);
    expect(reconciler.hasServerRendered()).toBe(true);
    reconciler.apply(headOf([description('ssr')]));
    expect(doc.head.querySelectorAll('meta[name="description"]').length).toBe(1);
    expect(new HeadReconciler(makeDoc()).hasServerRendered()).toBe(false);
  });

  it('removes a server-rendered tag whose key is no longer wanted', () => {
    doc = makeDoc(`<meta ${SEO_ATTR}="meta:name:author" name="author" content="x">`);
    new HeadReconciler(doc).apply(headOf([]));
    expect(doc.head.querySelector('meta[name="author"]')).toBeNull();
  });
});

describe('HeadReconciler title restore', () => {
  it('restores the original document title when no title is resolved', () => {
    const doc = makeDoc();
    const reconciler = new HeadReconciler(doc);
    reconciler.apply(headOf([], { title: 'A' }));
    expect(doc.title).toBe('A');
    reconciler.apply(headOf([], { title: null }));
    expect(doc.title).toBe('Initial');
  });
});
