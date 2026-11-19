import { describe, it, expect, vi } from 'vitest';
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
      expect(merged.http).toEqual({ status: 404, headers: { 'x-a': '1' } });
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
    (merged.jsonLd as unknown as unknown[] | undefined)?.push({ '@type': 'C' });
    expect(JSON.stringify([low, high])).toBe(snapshot);
  });

  it('returns an empty config for no layers', () => {
    expect(mergeLayers([])).toEqual({});
  });

  describe('hostile input', () => {
    it('never writes through __proto__, constructor or prototype keys', () => {
      const payload = JSON.parse(
        '{"openGraph":{"__proto__":{"polluted":"yes"}},"http":{"headers":{"__proto__":{"polluted":"yes"}}},' +
          '"twitter":{"constructor":{"prototype":{"polluted":"yes"}}},"robots":{"__proto__":{"index":false}}}',
      );
      const merged = mergeLayers([payload]);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
      expect(merged.robots).toBeUndefined();
    });
  });

  it('merges header names case-insensitively so null removes a differently cased header', () => {
    const merged = mergeLayers([
      { http: { headers: { 'X-Robots-Tag': 'noindex' } } },
      { http: { headers: { 'x-robots-tag': null } } },
    ]);
    expect(merged.http?.headers).toEqual({});
  });

  it('accepts JSON-LD nodes that are class instances', () => {
    class Node {
      '@type' = 'Thing';
      name = 'n';
    }
    expect(mergeLayers([{ jsonLd: [new Node() as never] }]).jsonLd).toEqual([{ '@type': 'Thing', name: 'n' }]);
  });

  it('never writes through a __proto__ key that only appears after header-name normalisation', () => {
    mergeLayers([JSON.parse('{"http":{"headers":{"__PROTO__":{"polluted":"yes"},"Constructor":{"x":1}}}}')]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('keeps one canonical link: the higher layer wins', () => {
    const merged = mergeLayers([
      { links: [{ rel: 'canonical', href: '/route-choice' }, { rel: 'alternate', hreflang: 'fr', href: '/fr-a' }] },
      { links: [{ rel: 'canonical', href: '/component-choice' }, { rel: 'alternate', hreflang: 'fr', href: '/fr-b' }] },
    ]);
    expect(merged.links).toEqual([
      { rel: 'canonical', href: '/component-choice' },
      { rel: 'alternate', hreflang: 'fr', href: '/fr-b' },
    ]);
  });

  it('reads class-instance layers and nested objects', () => {
    class Dto {
      title = 'From class';
      description = 'D';
    }
    class Og {
      title = 'OG';
    }
    expect(mergeLayers([new Dto() as never])).toEqual({ title: 'From class', description: 'D' });
    const merged = mergeLayers([{ openGraph: new Og() as never }, { openGraph: { description: 'x' } }]);
    expect(merged.openGraph).toEqual({ title: 'OG', description: 'x' });
  });

  it('drops a cyclic object field instead of overflowing', () => {
    const article: Record<string, unknown> = { section: 'News' };
    article['self'] = article;
    const robots: Record<string, unknown> = { index: false };
    robots['loop'] = robots;
    const merged = mergeLayers([{ title: 'T', openGraph: { article: article as never }, robots: robots as never }]);
    expect(merged.title).toBe('T');
    expect(merged.openGraph?.article?.section).toBe('News');
    expect(merged.robots).toEqual({ index: false });
  });

  it('keys links by lower-cased rel and alternates by lower-cased hreflang', () => {
    const merged = mergeLayers([
      { links: [{ rel: 'canonical', href: '/a' }, { rel: 'alternate', hreflang: 'en-US', href: '/en' }] },
      { links: [{ rel: 'Canonical', href: '/b' }, { rel: 'alternate', hreflang: 'en-us', href: '/en2' }] },
    ]);
    expect(merged.links).toHaveLength(2);
  });

  it('accepts a single string for Open Graph images', () => {
    const merged = mergeLayers([{ openGraph: { images: 'https://x.test/a.jpg' as never } }]);
    expect(merged.openGraph?.images).toEqual([{ url: 'https://x.test/a.jpg' }]);
  });

  it('removes items whose keys differ only in case from how they were written', () => {
    const merged = mergeLayers([
      {
        alternates: [{ hreflang: 'en-US', href: '/en' }],
        links: [{ rel: 'alternate', hreflang: 'pt-BR', href: '/pt' }],
        meta: [{ name: 'Theme-Color', content: 'red' }],
      },
      { alternates: [removeItem('en-US')], links: [removeItem('alternate|pt-BR')], meta: [removeItem('Theme-Color')] },
    ]);
    expect(merged.alternates).toEqual([]);
    expect(merged.links).toEqual([]);
    expect(merged.meta).toEqual([]);
  });

  it('lets a higher layer field beat lower extra meta and links with the same identity', () => {
    const merged = mergeLayers([
      {
        meta: [
          { name: 'robots', content: 'index, follow' },
          { name: 'Description', content: 'Site wide' },
          { property: 'og:image:width', content: '1' },
          { name: 'theme-color', content: '#fff' },
        ],
        links: [{ rel: 'canonical', href: '/site' }, { rel: 'alternate', hreflang: 'de', href: '/de' }, { rel: 'icon', href: '/i.png' }],
      },
      { description: 'Admin', robots: { index: false }, image: '/a.png', canonical: '/admin', alternates: [{ hreflang: 'de', href: '/de-admin' }] },
    ]);
    expect(merged.meta).toEqual([{ name: 'theme-color', content: '#fff' }]);
    expect(merged.links).toEqual([{ rel: 'icon', href: '/i.png' }]);
  });

  it('accepts a single object where a keyed list is expected and reports other shapes', () => {
    const onError = vi.fn();
    const merged = mergeLayers([{ jsonLd: { '@type': 'Article', headline: 'H' } as never, alternates: 5 as never }], onError);
    expect(merged.jsonLd).toEqual([{ '@type': 'Article', headline: 'H' }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('keeps repeated meta with the same identity within a layer, and a higher layer replaces the group', () => {
    const one = mergeLayers([{ meta: [{ property: 'video:tag', content: 'one' }, { property: 'video:tag', content: 'two' }] }]);
    expect(one.meta?.map((m) => ('content' in m ? m.content : ''))).toEqual(['one', 'two']);
    const two = mergeLayers([
      { meta: [{ property: 'video:tag', content: 'one' }, { property: 'video:tag', content: 'two' }, { name: 'x', content: 'kept' }] },
      { meta: [{ property: 'video:tag', content: 'three' }] },
    ]);
    expect(two.meta?.map((m) => ('content' in m ? m.content : ''))).toEqual(['three', 'kept']);
    const removed = mergeLayers([{ meta: [{ property: 'video:tag', content: 'one' }, { property: 'video:tag', content: 'two' }] }, { meta: [removeItem('video:tag')] }]);
    expect(removed.meta).toEqual([]);
  });

  it('treats theme-color variants with different media as different tags', () => {
    const merged = mergeLayers([
      { meta: [{ name: 'theme-color', content: '#fff', media: '(prefers-color-scheme: light)' }, { name: 'theme-color', content: '#000', media: '(prefers-color-scheme: dark)' }] },
      { meta: [{ name: 'theme-color', content: '#111', media: '(prefers-color-scheme: dark)' }] },
    ]);
    expect(merged.meta).toEqual([
      { name: 'theme-color', content: '#fff', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#111', media: '(prefers-color-scheme: dark)' },
    ]);
  });

  it('does not let an image without a URL claim lower image tags', () => {
    const merged = mergeLayers([{ meta: [{ property: 'og:image', content: '/site.png' }] }, { image: { url: '' } }]);
    expect(merged.meta).toEqual([{ property: 'og:image', content: '/site.png' }]);
  });

  it('replaces a single Open Graph video object whole rather than field by field', () => {
    const merged = mergeLayers([
      { openGraph: { videos: { url: '/a.mp4', type: 'video/mp4', width: 1280 } as never } },
      { openGraph: { videos: { url: '/b.webm' } as never } },
    ]);
    expect(merged.openGraph?.videos).toEqual([{ url: '/b.webm' }]);
  });

  it('lets a higher layer meta replace lower items with the same name whatever their key', () => {
    const one = mergeLayers([{ meta: [{ key: 'site-desc', name: 'description', content: 'site' }] }, { meta: [{ name: 'description', content: 'page' }] }]);
    expect(one.meta).toEqual([{ name: 'description', content: 'page' }]);
    const two = mergeLayers([{ meta: [{ name: 'description', content: 'site' }] }, { meta: [{ key: 'x', name: 'description', content: 'page' }] }]);
    expect(two.meta).toEqual([{ key: 'x', name: 'description', content: 'page' }]);
  });

  it('keeps link hrefs and explicit keys case-sensitive', () => {
    const across = mergeLayers([
      { links: [{ rel: 'preload', href: '/fonts/Inter.woff2', as: 'font' }] },
      { links: [{ rel: 'Preload', href: '/fonts/inter.woff2', as: 'font' }] },
    ]);
    expect(across.links).toHaveLength(2);
    const within = mergeLayers([{ links: [{ rel: 'prefetch', href: '/A.json' }, { rel: 'prefetch', href: '/a.json' }] }]);
    expect(within.links).toHaveLength(2);
    const keyed = mergeLayers([{ meta: [{ key: 'A', name: 'a', content: '1' }] }, { meta: [{ key: 'a', name: 'b', content: '2' }] }]);
    expect(keyed.meta).toHaveLength(2);
  });

  it('lets a single alternates object beat a lower alternate link', () => {
    const merged = mergeLayers([
      { links: [{ rel: 'alternate', hreflang: 'de', href: '/de-old' }] },
      { alternates: { hreflang: 'de', href: '/de-new' } as never },
    ]);
    expect(merged.links).toEqual([]);
    expect(merged.alternates).toEqual([{ hreflang: 'de', href: '/de-new' }]);
  });

  it('lets Open Graph fields release the lower extra tags their derivations feed', () => {
    const merged = mergeLayers([
      {
        meta: [
          { name: 'twitter:image', content: '/default.jpg' },
          { name: 'twitter:title', content: 'Site' },
          { name: 'twitter:description', content: 'Site desc' },
          { property: 'og:type', content: 'website' },
          { name: 'theme-color', content: '#fff' },
        ],
      },
      { openGraph: { images: [{ url: '/page.jpg' }], title: 'Page', description: 'Page desc', article: { section: 'News' } } },
    ]);
    expect(merged.meta).toEqual([{ name: 'theme-color', content: '#fff' }]);
  });

  it('lets bots release lower extra robots meta for the same crawler', () => {
    const merged = mergeLayers([{ meta: [{ name: 'googlebot', content: 'index' }] }, { bots: { googlebot: { index: false } } }]);
    expect(merged.meta).toEqual([]);
  });

  it('drops a cycle through a class instance where it starts, without overflowing', () => {
    class Article {
      publishedTime = '2024-01-01';
      owner: unknown = this;
    }
    const onError = vi.fn();
    const merged = mergeLayers([{ title: 'Page', openGraph: { article: new Article() as never } }], onError);
    expect(merged.title).toBe('Page');
    expect(merged.openGraph?.article?.publishedTime).toBe('2024-01-01');
    expect(onError).toHaveBeenCalled();
  });

  it('treats a meta item without content, or a link or alternate without href, as no opinion', () => {
    const merged = mergeLayers([
      {
        meta: [{ name: 'theme-color', content: '#fff' }],
        alternates: [{ hreflang: 'de', href: '/de' }],
        links: [{ rel: 'icon', href: '/i.png', key: 'icon' }],
      },
      {
        meta: [{ name: 'theme-color', content: '' }],
        alternates: [{ hreflang: 'de', href: '' }],
        links: [{ rel: 'icon', href: '', key: 'icon' }],
      },
    ]);
    expect(merged.meta).toEqual([{ name: 'theme-color', content: '#fff' }]);
    expect(merged.alternates).toEqual([{ hreflang: 'de', href: '/de' }]);
    expect(merged.links).toEqual([{ rel: 'icon', href: '/i.png', key: 'icon' }]);
  });

  it('keeps a wrongly typed meta content through merging so it can be reported', () => {
    const merged = mergeLayers([{ meta: [{ name: 'x', content: 5 as never }] }]);
    expect(merged.meta).toEqual([{ name: 'x', content: 5 }]);
  });

  it('does not let an empty images list or an undefined bot claim lower extra meta', () => {
    for (const images of [[], [{ url: '' }], [removeItem('/other.png')]]) {
      const merged = mergeLayers([{ meta: [{ property: 'og:image', content: '/site.png' }] }, { openGraph: { images: images as never } }]);
      expect(merged.meta, JSON.stringify(images)).toEqual([{ property: 'og:image', content: '/site.png' }]);
    }
    const bots = mergeLayers([{ meta: [{ name: 'googlebot', content: 'noarchive' }] }, { bots: { googlebot: undefined } }]);
    expect(bots.meta).toEqual([{ name: 'googlebot', content: 'noarchive' }]);
  });

  it('treats whitespace-only text as no opinion', () => {
    expect(mergeLayers([{ title: 'T', canonical: '/c' }, { title: '  ', canonical: ' ' }])).toMatchObject({ title: 'T', canonical: '/c' });
  });

  it('does not let blank fields or href-less alternates claim lower extra tags', () => {
    const cases: [string, SeoConfig, SeoConfig][] = [
      ['description', { meta: [{ name: 'description', content: 'Site desc' }] }, { description: '   ' }],
      ['image', { meta: [{ property: 'og:image', content: '/site.png' }] }, { image: '  ' }],
      ['og title', { meta: [{ property: 'og:title', content: 'Site' }] }, { openGraph: { title: ' ' } }],
      ['canonical', { links: [{ rel: 'canonical', href: '/canon' }] }, { canonical: ' ' }],
      ['alternate', { links: [{ rel: 'alternate', hreflang: 'de', href: '/de' }] }, { alternates: [{ hreflang: 'de', href: '' }] }],
    ];
    for (const [label, lower, higher] of cases) {
      const merged = mergeLayers([lower, higher]);
      expect([...(merged.meta ?? []), ...(merged.links ?? [])], label).toHaveLength(1);
    }
  });

  it('keeps the inherited image when a higher image has only a blank URL', () => {
    const merged = mergeLayers([{ image: { url: '/default.png', width: 1200 } }, { image: { url: '   ', alt: 'Post cover' } }]);
    expect(merged.image).toEqual({ url: '/default.png', width: 1200 });
  });

  it('merges bots case-insensitively', () => {
    expect(mergeLayers([{ bots: { Googlebot: { maxSnippet: 50 } } }, { bots: { googlebot: { index: false } } }]).bots).toEqual({
      googlebot: { maxSnippet: 50, index: false },
    });
    expect(mergeLayers([{ bots: { Googlebot: 'noindex' } }, { bots: { googlebot: null } }]).bots).toEqual({});
  });

  it('lets class-instance fields release lower extra tags like plain objects do', () => {
    class Og {
      title = 'Page';
    }
    class Tw {
      title = 'Page';
    }
    class Alt {
      hreflang = 'fr';
      href = '/fr-page';
    }
    class BlankImage {
      url = '  ';
    }
    const merged = mergeLayers([
      {
        meta: [
          { property: 'og:title', content: 'Site-wide' },
          { name: 'twitter:title', content: 'Site-wide' },
          { property: 'og:image', content: '/site.png' },
        ],
        links: [{ rel: 'alternate', hreflang: 'fr', href: '/fr' }],
      },
      { openGraph: new Og() as never, twitter: new Tw() as never, alternates: [new Alt() as never], image: new BlankImage() as never },
    ]);
    expect(merged.meta).toEqual([{ property: 'og:image', content: '/site.png' }]);
    expect(merged.links).toEqual([]);
  });

  it('treats an object whose fields are all undefined as no opinion', () => {
    const merged = mergeLayers([
      { robots: 'noindex, nofollow', bots: { googlebot: 'noarchive' } },
      { robots: { index: undefined }, bots: { googlebot: { maxSnippet: undefined } } },
    ]);
    expect(merged.robots).toBe('noindex, nofollow');
    expect(merged.bots).toEqual({ googlebot: 'noarchive' });
    const extras = mergeLayers([
      { meta: [{ name: 'robots', content: 'max-image-preview:large' }, { name: 'googlebot', content: 'noarchive' }] },
      { robots: { index: undefined }, bots: { googlebot: { maxSnippet: undefined } } },
    ]);
    expect(extras.meta).toHaveLength(2);
  });

  it('lets twitter.image release a lower twitter:image:alt extra', () => {
    const merged = mergeLayers([
      { meta: [{ name: 'twitter:image', content: '/site.png' }, { name: 'twitter:image:alt', content: 'Site logo' }] },
      { twitter: { image: '/page.png' } },
    ]);
    expect(merged.meta).toEqual([]);
  });

  it('skips a blank URL in an Open Graph images list without reporting it', () => {
    const onError = vi.fn();
    const merged = mergeLayers([{ openGraph: { images: [{ url: '/a.png' }] } }, { openGraph: { images: ['', '  '] as never } }], onError);
    expect(merged.openGraph?.images).toEqual([{ url: '/a.png' }]);
    expect(onError).not.toHaveBeenCalled();
  });
});

