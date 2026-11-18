import { describe, it, expect } from 'vitest';
import { mergeLayers, removeItem } from '../src/lib/merge';
import type { SeoConfig } from '../src/lib/types';

describe('mergeLayers', () => {
  describe('scalars', () => {
    it('takes the value from the highest layer that sets it', () => {
      expect(mergeLayers([{ title: 'a' }, { title: 'b' }]).title).toBe('b');
    });

    it('keeps a lower value when the higher layer has no opinion', () => {
      expect(mergeLayers([{ title: 'a' }, {}]).title).toBe('a');
      expect(mergeLayers([{ title: 'a' }, { title: undefined }]).title).toBe('a');
    });

    it('removes a lower value when a higher layer sets null', () => {
      const merged = mergeLayers([{ description: 'a' }, { description: null }]);
      expect('description' in merged).toBe(false);
    });

    it('treats an empty string as unset', () => {
      expect(mergeLayers([{ title: 'a' }, { title: '' }]).title).toBe('a');
      expect('title' in mergeLayers([{ title: '' }])).toBe(false);
    });

    it('keeps canonical: false as a real value', () => {
      expect(mergeLayers([{ canonical: '/a' }, { canonical: false }]).canonical).toBe(false);
    });

    it('keeps a function titleTemplate by reference', () => {
      const template = (t: string): string => t;
      expect(mergeLayers([{ titleTemplate: template }]).titleTemplate).toBe(template);
    });

    it('replaces the image shorthand whole rather than field by field', () => {
      const merged = mergeLayers([{ image: { url: '/a.png', alt: 'A' } }, { image: { url: '/b.png' } }]);
      expect(merged.image).toEqual({ url: '/b.png' });
    });
  });

  describe('objects', () => {
    it('merges field by field', () => {
      const merged = mergeLayers([
        { openGraph: { title: 'a', type: 'article' } },
        { openGraph: { title: 'b' } },
      ]);
      expect(merged.openGraph).toEqual({ title: 'b', type: 'article' });
    });

    it('removes one nested field with null', () => {
      const merged = mergeLayers([
        { twitter: { site: '@a', creator: '@b' } },
        { twitter: { creator: null } },
      ]);
      expect(merged.twitter).toEqual({ site: '@a' });
    });

    it('removes a whole object with null', () => {
      const merged = mergeLayers([{ openGraph: { title: 'a' } }, { openGraph: null }]);
      expect('openGraph' in merged).toBe(false);
    });

    it('merges nested objects at depth', () => {
      const merged = mergeLayers([
        { openGraph: { article: { section: 'News', tags: ['a'] } } },
        { openGraph: { article: { publishedTime: '2026-01-01' } } },
      ]);
      expect(merged.openGraph?.article).toEqual({ section: 'News', tags: ['a'], publishedTime: '2026-01-01' });
    });

    it('merges http headers and removes one with null', () => {
      const merged = mergeLayers([
        { http: { status: 200, headers: { 'X-A': '1', 'X-B': '2' } } },
        { http: { status: 404, headers: { 'X-B': null } } },
      ]);
      expect(merged.http).toEqual({ status: 404, headers: { 'X-A': '1' } });
    });

    it('merges robots directive objects', () => {
      const merged = mergeLayers([{ robots: { index: false } }, { robots: { follow: false } }]);
      expect(merged.robots).toEqual({ index: false, follow: false });
    });

    it('replaces a robots object with a raw string', () => {
      expect(mergeLayers([{ robots: { index: false } }, { robots: 'none' }]).robots).toBe('none');
    });

    it('replaces a raw robots string with an object', () => {
      expect(mergeLayers([{ robots: 'none' }, { robots: { follow: true } }]).robots).toEqual({ follow: true });
    });

    it('applies the robots rules per crawler', () => {
      const merged = mergeLayers([
        { bots: { googlebot: { index: false }, bingbot: 'noindex' } },
        { bots: { googlebot: { maxSnippet: 10 }, bingbot: null } },
      ]);
      expect(merged.bots).toEqual({ googlebot: { index: false, maxSnippet: 10 } });
    });

    it('keeps Date values intact', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const merged = mergeLayers([{ openGraph: { article: { publishedTime: date } } }]);
      expect(merged.openGraph?.article?.publishedTime).toBe(date);
    });
  });

  describe('keyed lists', () => {
    it('collapses JSON-LD nodes with the same @id to the higher layer, in the lower position', () => {
      const merged = mergeLayers([
        { jsonLd: [{ '@type': 'Organization', '@id': '/#org', name: 'low' }, { '@type': 'WebSite', '@id': '/#site' }] },
        { jsonLd: [{ '@type': 'Organization', '@id': '/#org', name: 'high' }] },
      ]);
      expect(merged.jsonLd).toEqual([
        { '@type': 'Organization', '@id': '/#org', name: 'high' },
        { '@type': 'WebSite', '@id': '/#site' },
      ]);
    });

    it('keeps every JSON-LD node that has no @id', () => {
      const merged = mergeLayers([
        { jsonLd: [{ '@type': 'FAQPage' }] },
        { jsonLd: [{ '@type': 'FAQPage' }, { '@type': 'BreadcrumbList' }] },
      ]);
      expect(merged.jsonLd).toHaveLength(3);
    });

    it('keys alternates by hreflang', () => {
      const merged = mergeLayers([
        { alternates: [{ hreflang: 'en', href: '/en' }, { hreflang: 'fr', href: '/fr' }] },
        { alternates: [{ hreflang: 'fr', href: '/fr-new' }] },
      ]);
      expect(merged.alternates).toEqual([
        { hreflang: 'en', href: '/en' },
        { hreflang: 'fr', href: '/fr-new' },
      ]);
    });

    it('keys meta by key, then name, property or httpEquiv', () => {
      const merged = mergeLayers([
        {
          meta: [
            { name: 'theme-color', content: 'red' },
            { property: 'fb:app_id', content: '1' },
            { httpEquiv: 'content-language', content: 'en' },
            { name: 'x', key: 'k', content: 'low' },
          ],
        },
        {
          meta: [
            { name: 'theme-color', content: 'blue' },
            { property: 'fb:app_id', content: '2' },
            { httpEquiv: 'content-language', content: 'fr' },
            { name: 'y', key: 'k', content: 'high' },
          ],
        },
      ]);
      expect(merged.meta).toEqual([
        { name: 'theme-color', content: 'blue' },
        { property: 'fb:app_id', content: '2' },
        { httpEquiv: 'content-language', content: 'fr' },
        { name: 'y', key: 'k', content: 'high' },
      ]);
    });

    it('keys links by key, then rel and href', () => {
      const merged = mergeLayers([
        { links: [{ rel: 'prev', href: '/1' }, { rel: 'author', href: '/a', key: 'who' }] },
        { links: [{ rel: 'prev', href: '/1', title: 'Previous' }, { rel: 'author', href: '/b', key: 'who' }, { rel: 'next', href: '/3' }] },
      ]);
      expect(merged.links).toEqual([
        { rel: 'prev', href: '/1', title: 'Previous' },
        { rel: 'author', href: '/b', key: 'who' },
        { rel: 'next', href: '/3' },
      ]);
    });

    it('puts higher-layer Open Graph images first', () => {
      const merged = mergeLayers([
        { openGraph: { images: [{ url: '/section.png' }, { url: '/shared.png', alt: 'low' }] } },
        { openGraph: { images: [{ url: '/page.png' }, { url: '/shared.png', alt: 'high' }] } },
      ]);
      expect(merged.openGraph?.images).toEqual([
        { url: '/page.png' },
        { url: '/shared.png', alt: 'high' },
        { url: '/section.png' },
      ]);
    });

    it('clears lower contributions with null and lets later layers add again', () => {
      const merged = mergeLayers([
        { jsonLd: [{ '@type': 'A' }] },
        { jsonLd: null },
        { jsonLd: [{ '@type': 'B' }] },
      ]);
      expect(merged.jsonLd).toEqual([{ '@type': 'B' }]);
    });

    it('drops one inherited item with removeItem and never emits the marker', () => {
      const merged = mergeLayers([
        { jsonLd: [{ '@type': 'Organization', '@id': '/#org' }, { '@type': 'WebSite', '@id': '/#site' }] },
        { jsonLd: [removeItem('/#org')], alternates: [removeItem('fr')] },
      ]);
      expect(merged.jsonLd).toEqual([{ '@type': 'WebSite', '@id': '/#site' }]);
      expect(merged.alternates).toEqual([]);
    });

    it('compares keys as written', () => {
      const merged = mergeLayers([
        { jsonLd: [{ '@type': 'Organization', '@id': '#org' }] },
        { jsonLd: [{ '@type': 'Organization', '@id': '/#org' }] },
      ]);
      expect(merged.jsonLd).toHaveLength(2);
    });
  });

  describe('plain lists', () => {
    it('copies plain lists of objects', () => {
      expect(mergeLayers([{ openGraph: { videos: [{ url: '/v.mp4', type: 'video/mp4' }] } }]).openGraph?.videos).toEqual([
        { url: '/v.mp4', type: 'video/mp4' },
      ]);
    });

    it('treats an empty image url as unset so the default image still applies', () => {
      expect(mergeLayers([{ image: '/default.png' }, { image: { url: '', alt: '' } }]).image).toBe('/default.png');
      expect(mergeLayers([{ image: '/default.png' }, { image: '' }]).image).toBe('/default.png');
    });

    it('treats an empty description as unset', () => {
      expect(mergeLayers([{ description: 'D' }, { description: '' }]).description).toBe('D');
    });

    it('replaces keywords', () => {
      expect(mergeLayers([{ keywords: ['a', 'b'] }, { keywords: ['c'] }]).keywords).toEqual(['c']);
    });

    it('replaces article tags', () => {
      const merged = mergeLayers([
        { openGraph: { article: { tags: ['a'] } } },
        { openGraph: { article: { tags: ['b'] } } },
      ]);
      expect(merged.openGraph?.article?.tags).toEqual(['b']);
    });
  });

  it('does not mutate its inputs', () => {
    const low: SeoConfig = { openGraph: { title: 'a', images: [{ url: '/a.png' }] }, jsonLd: [{ '@type': 'A', '@id': 'x' }] };
    const high: SeoConfig = { openGraph: { title: 'b', images: [{ url: '/b.png' }] }, jsonLd: [{ '@type': 'B', '@id': 'x' }] };
    const snapshot = JSON.stringify([low, high]);
    const merged = mergeLayers([low, high]);
    (merged.openGraph as { title: string }).title = 'changed';
    merged.jsonLd?.push({ '@type': 'C' });
    expect(JSON.stringify([low, high])).toBe(snapshot);
  });

  it('returns an empty config for no layers', () => {
    expect(mergeLayers([])).toEqual({});
  });
});
