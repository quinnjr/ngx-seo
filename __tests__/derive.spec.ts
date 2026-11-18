import { describe, it, expect, vi } from 'vitest';
import { resolveHead } from '../src/lib/derive';
import type { ResolvedHead, SeoConfig, SeoSiteConfig } from '../src/lib/types';

const site: SeoSiteConfig = { siteName: 'Site', baseUrl: 'https://x.test' };
const env = { path: '/page', origin: null };

function value(head: ResolvedHead, key: string): string | undefined {
  const tag = head.tags.find((t) => t.key === key);
  return tag?.attrs['content'] ?? tag?.attrs['href'] ?? tag?.text;
}

function keys(head: ResolvedHead): string[] {
  return head.tags.map((t) => t.key);
}

function resolve(config: SeoConfig, siteConfig: SeoSiteConfig = site, path = '/page'): ResolvedHead {
  return resolveHead(config, siteConfig, { path, origin: null });
}

describe('resolveHead', () => {
  it('derives the social and canonical tags from title and description', () => {
    const head = resolve({ title: 'T', description: 'D' });
    expect(head.title).toBe('T');
    expect(value(head, 'meta:name:description')).toBe('D');
    expect(value(head, 'link:canonical')).toBe('https://x.test/page');
    expect(head.canonical).toBe('https://x.test/page');
    expect(value(head, 'meta:property:og:title')).toBe('T');
    expect(value(head, 'meta:property:og:description')).toBe('D');
    expect(value(head, 'meta:property:og:url')).toBe('https://x.test/page');
    expect(value(head, 'meta:property:og:site_name')).toBe('Site');
    expect(value(head, 'meta:property:og:type')).toBe('website');
    expect(value(head, 'meta:name:twitter:card')).toBe('summary');
    expect(value(head, 'meta:name:twitter:title')).toBe('T');
    expect(value(head, 'meta:name:twitter:description')).toBe('D');
  });

  it('writes tags with the right attributes', () => {
    const head = resolve({ title: 'T', description: 'D' });
    expect(head.tags.find((t) => t.key === 'meta:name:description')).toEqual({
      key: 'meta:name:description',
      tag: 'meta',
      attrs: { name: 'description', content: 'D' },
    });
    expect(head.tags.find((t) => t.key === 'meta:property:og:title')?.attrs).toEqual({ property: 'og:title', content: 'T' });
    expect(head.tags.find((t) => t.key === 'link:canonical')?.attrs).toEqual({ rel: 'canonical', href: 'https://x.test/page' });
  });

  describe('title', () => {
    it('applies a %s template to the document title only', () => {
      const head = resolve({ title: 'T' }, { ...site, titleTemplate: '%s | Site' });
      expect(head.title).toBe('T | Site');
      expect(value(head, 'meta:property:og:title')).toBe('T');
      expect(value(head, 'meta:name:twitter:title')).toBe('T');
    });

    it('calls a function template with the title and context', () => {
      const template = vi.fn((t: string, ctx: { siteName: string | null; url: string }) => `${t} - ${ctx.siteName} ${ctx.url}`);
      const head = resolve({ title: 'T', description: 'D' }, { ...site, titleTemplate: template });
      expect(head.title).toBe('T - Site /page');
      expect(template.mock.calls[0][1]).toMatchObject({ canonical: 'https://x.test/page', title: 'T', description: 'D' });
    });

    it('lets a layer override or disable the site template', () => {
      expect(resolve({ title: 'T', titleTemplate: '[%s]' }, { ...site, titleTemplate: '%s | Site' }).title).toBe('[T]');
      expect(resolve({ title: 'T', titleTemplate: false }, { ...site, titleTemplate: '%s | Site' }).title).toBe('T');
    });

    it('uses defaultTitle untemplated when no layer sets a title', () => {
      const head = resolve({}, { ...site, titleTemplate: '%s | Site', defaultTitle: 'Home' });
      expect(head.title).toBe('Home');
      expect(value(head, 'meta:property:og:title')).toBe('Home');
    });

    it('emits no title when there is none', () => {
      const head = resolve({});
      expect(head.title).toBeNull();
      expect(value(head, 'meta:property:og:title')).toBeUndefined();
    });
  });

  it('falls back from Twitter to Open Graph to the base field', () => {
    const head = resolve({ title: 'T', description: 'D', openGraph: { title: 'OG', description: 'OGD' } });
    expect(value(head, 'meta:name:twitter:title')).toBe('OG');
    expect(value(head, 'meta:name:twitter:description')).toBe('OGD');
    const explicit = resolve({ title: 'T', openGraph: { title: 'OG' }, twitter: { title: 'TW' } });
    expect(value(explicit, 'meta:name:twitter:title')).toBe('TW');
  });

  describe('images', () => {
    it('feeds the image shorthand to Open Graph and Twitter', () => {
      const head = resolve({ image: '/img.png' });
      expect(value(head, 'meta:property:og:image')).toBe('https://x.test/img.png');
      expect(value(head, 'meta:name:twitter:image')).toBe('https://x.test/img.png');
      expect(value(head, 'meta:name:twitter:card')).toBe('summary_large_image');
    });

    it('emits image details', () => {
      const head = resolve({ image: { url: '/img.png', alt: 'Alt', width: 1200, height: 630, type: 'image/png' } });
      expect(value(head, 'meta:property:og:image:alt')).toBe('Alt');
      expect(value(head, 'meta:property:og:image:width')).toBe('1200');
      expect(value(head, 'meta:property:og:image:height')).toBe('630');
      expect(value(head, 'meta:property:og:image:type')).toBe('image/png');
      expect(value(head, 'meta:name:twitter:image:alt')).toBe('Alt');
    });

    it('puts the shorthand before Open Graph images and skips duplicates', () => {
      const head = resolve({
        image: '/a.png',
        openGraph: { images: [{ url: '/b.png' }, { url: '/a.png' }] },
      });
      const images = head.tags.filter((t) => t.attrs['property'] === 'og:image').map((t) => t.attrs['content']);
      expect(images).toEqual(['https://x.test/a.png', 'https://x.test/b.png']);
      expect(keys(head)).toContain('meta:property:og:image#1');
    });

    it('lets an explicit Twitter card win', () => {
      expect(value(resolve({ image: '/a.png', twitter: { card: 'summary' } }), 'meta:name:twitter:card')).toBe('summary');
    });

    it('drops an unsafe image URL without throwing', () => {
      const head = resolve({ image: 'javascript:alert(1)' });
      expect(value(head, 'meta:property:og:image')).toBeUndefined();
      expect(value(head, 'meta:name:twitter:image')).toBeUndefined();
      expect(head.droppedUrls).toContain('image');
    });
  });

  describe('canonical', () => {
    it('emits no canonical and no og:url when canonical is false', () => {
      const head = resolve({ canonical: false });
      expect(value(head, 'link:canonical')).toBeUndefined();
      expect(value(head, 'meta:property:og:url')).toBeUndefined();
      expect(head.canonical).toBeNull();
    });

    it('makes an explicit canonical absolute', () => {
      expect(resolve({ canonical: '/other' }).canonical).toBe('https://x.test/other');
    });

    it('applies the canonical policy to the derived canonical', () => {
      const head = resolve({}, { ...site, canonical: { trailingSlash: 'always', keepQueryParams: ['page'] } }, '/blog?page=2&utm=x');
      expect(head.canonical).toBe('https://x.test/blog/?page=2');
    });

    it('uses the request origin when there is no baseUrl', () => {
      const head = resolveHead({ image: '/a.png' }, { siteName: 'S' }, { path: '/p', origin: 'https://req.test' });
      expect(head.canonical).toBe('https://req.test/p');
      expect(value(head, 'meta:property:og:image')).toBe('https://req.test/a.png');
    });

    it('derives nothing relative when there is no base at all', () => {
      const head = resolveHead({ image: '/a.png' }, {}, { path: '/p', origin: null });
      expect(head.canonical).toBeNull();
      expect(value(head, 'meta:property:og:image')).toBeUndefined();
    });

    it('records an explicit canonical that cannot be made absolute', () => {
      expect(resolve({ canonical: 'javascript:x' }).droppedUrls).toContain('canonical');
    });
  });

  it('renders robots and per-crawler directives', () => {
    const head = resolve({ robots: { index: false }, bots: { googlebot: { maxSnippet: 50 }, bingbot: 'noarchive' } });
    expect(value(head, 'meta:name:robots')).toBe('noindex');
    expect(head.robots).toBe('noindex');
    expect(value(head, 'meta:name:googlebot')).toBe('max-snippet:50');
    expect(value(head, 'meta:name:bingbot')).toBe('noarchive');
  });

  it('renders keywords and author', () => {
    expect(value(resolve({ keywords: ['a', 'b'] }), 'meta:name:keywords')).toBe('a, b');
    expect(value(resolve({ keywords: 'a,b' }), 'meta:name:keywords')).toBe('a,b');
    expect(value(resolve({ author: 'Ann' }), 'meta:name:author')).toBe('Ann');
  });

  it('renders hreflang alternates with absolute URLs', () => {
    const head = resolve({ alternates: [{ hreflang: 'fr', href: '/fr/page' }] });
    expect(head.tags.find((t) => t.key === 'link:alternate:fr')?.attrs).toEqual({
      rel: 'alternate',
      hreflang: 'fr',
      href: 'https://x.test/fr/page',
    });
  });

  it('renders locale, article, profile and media properties', () => {
    const head = resolve({
      openGraph: {
        type: 'article',
        locale: 'en_US',
        alternateLocales: ['fr_FR', 'de_DE'],
        article: { publishedTime: new Date('2026-01-01T00:00:00Z'), authors: ['/team/ann'], section: 'News', tags: ['a', 'b'] },
        videos: [{ url: '/v.mp4', type: 'video/mp4' }],
      },
    });
    expect(value(head, 'meta:property:og:type')).toBe('article');
    expect(value(head, 'meta:property:og:locale')).toBe('en_US');
    expect(value(head, 'meta:property:og:locale:alternate#1')).toBe('de_DE');
    expect(value(head, 'meta:property:article:published_time')).toBe('2026-01-01T00:00:00.000Z');
    expect(value(head, 'meta:property:article:author')).toBe('/team/ann');
    expect(value(head, 'meta:property:article:section')).toBe('News');
    expect(value(head, 'meta:property:article:tag#1')).toBe('b');
    expect(value(head, 'meta:property:og:video')).toBe('https://x.test/v.mp4');
    expect(value(head, 'meta:property:og:video:type')).toBe('video/mp4');
  });

  it('renders extra meta and link tags', () => {
    const head = resolve({
      meta: [
        { name: 'theme-color', content: '#fff' },
        { httpEquiv: 'content-language', content: 'en' },
        { property: 'fb:app_id', content: '1' },
      ],
      links: [
        { rel: 'preconnect', href: 'https://cdn.test' },
        { rel: 'author', href: '/humans.txt', key: 'humans' },
      ],
    });
    expect(head.tags.find((t) => t.key === 'meta:name:theme-color')?.attrs).toEqual({ name: 'theme-color', content: '#fff' });
    expect(head.tags.find((t) => t.key === 'meta:http-equiv:content-language')?.attrs).toEqual({
      'http-equiv': 'content-language',
      content: 'en',
    });
    expect(value(head, 'meta:property:fb:app_id')).toBe('1');
    expect(value(head, 'link:preconnect:https://cdn.test/')).toBe('https://cdn.test/');
    expect(head.tags.find((t) => t.key === 'link:humans')?.attrs).toEqual({ rel: 'author', href: 'https://x.test/humans.txt' });
  });

  it('lets an extra meta or link override the derived tag with the same identity', () => {
    const head = resolve({
      description: 'D',
      alternates: [{ hreflang: 'fr', href: '/fr' }],
      meta: [
        { name: 'description', content: 'Override' },
        { property: 'og:type', content: 'article' },
      ],
      links: [
        { rel: 'canonical', href: '/elsewhere' },
        { rel: 'alternate', hreflang: 'fr', href: '/fr-2' },
      ],
    });
    const count = (k: string): number => keys(head).filter((key) => key === k || key.startsWith(`${k}#`)).length;
    expect(count('meta:name:description')).toBe(1);
    expect(value(head, 'meta:name:description')).toBe('Override');
    expect(count('meta:property:og:type')).toBe(1);
    expect(value(head, 'meta:property:og:type')).toBe('article');
    expect(count('link:canonical')).toBe(1);
    expect(value(head, 'link:canonical')).toBe('https://x.test/elsewhere');
    expect(value(head, 'meta:property:og:url')).toBe('https://x.test/elsewhere');
    expect(head.canonical).toBe('https://x.test/elsewhere');
    expect(count('link:alternate:fr')).toBe(1);
    expect(value(head, 'link:alternate:fr')).toBe('https://x.test/fr-2');
  });

  it('treats an empty description as no description', () => {
    expect(value(resolve({ title: 'T', description: '' }), 'meta:name:description')).toBeUndefined();
  });

  it('orders tags by family', () => {
    const head = resolve({
      title: 'T',
      description: 'D',
      keywords: ['k'],
      author: 'A',
      robots: { index: true },
      bots: { googlebot: 'noarchive' },
      alternates: [{ hreflang: 'fr', href: '/fr' }],
      meta: [{ name: 'theme-color', content: '#fff' }],
      links: [{ rel: 'next', href: '/2' }],
      jsonLd: [{ '@type': 'Thing' }],
    });
    const order = keys(head);
    const at = (k: string): number => order.indexOf(k);
    expect(at('meta:name:description')).toBeLessThan(at('meta:name:keywords'));
    expect(at('meta:name:keywords')).toBeLessThan(at('meta:name:author'));
    expect(at('meta:name:author')).toBeLessThan(at('meta:name:robots'));
    expect(at('meta:name:robots')).toBeLessThan(at('meta:name:googlebot'));
    expect(at('meta:name:googlebot')).toBeLessThan(at('link:canonical'));
    expect(at('link:canonical')).toBeLessThan(at('link:alternate:fr'));
    expect(at('link:alternate:fr')).toBeLessThan(at('meta:property:og:title'));
    expect(at('meta:property:og:title')).toBeLessThan(at('meta:name:twitter:card'));
    expect(at('meta:name:twitter:card')).toBeLessThan(at('meta:name:theme-color'));
    expect(at('meta:name:theme-color')).toBeLessThan(at('link:next:https://x.test/2'));
    expect(order[order.length - 1]).toBe('script:jsonld');
  });

  describe('JSON-LD', () => {
    function graph(head: ResolvedHead): Record<string, unknown>[] {
      const script = head.tags.find((t) => t.key === 'script:jsonld');
      expect(script?.attrs).toEqual({ type: 'application/ld+json' });
      return JSON.parse(script?.text as string)['@graph'];
    }

    it('resolves # ids against the page and / ids against the site root', () => {
      const nodes = graph(resolve({ jsonLd: [{ '@type': 'WebPage', '@id': '#page' }, { '@type': 'Organization', '@id': '/#org' }] }));
      expect(nodes[0]['@id']).toBe('https://x.test/page#page');
      expect(nodes[1]['@id']).toBe('https://x.test/#org');
    });

    it('makes nested URL properties and references absolute', () => {
      const [node] = graph(
        resolve({
          jsonLd: [
            {
              '@type': 'BreadcrumbList',
              publisher: { '@id': '/#org' },
              logo: '/logo.png',
              image: ['/a.png', 'https://cdn.test/b.png'],
              potentialAction: { '@type': 'SearchAction', target: '/search?q={search_term_string}' },
              itemListElement: [{ '@type': 'ListItem', position: 1, item: '/blog', name: '/not-a-url-property' }],
            },
          ],
        }),
      );
      expect(node['publisher']).toEqual({ '@id': 'https://x.test/#org' });
      expect(node['logo']).toBe('https://x.test/logo.png');
      expect(node['image']).toEqual(['https://x.test/a.png', 'https://cdn.test/b.png']);
      expect((node['potentialAction'] as Record<string, unknown>)['target']).toBe('https://x.test/search?q={search_term_string}');
      expect((node['itemListElement'] as Record<string, unknown>[])[0]).toEqual({
        '@type': 'ListItem',
        position: 1,
        item: 'https://x.test/blog',
        name: '/not-a-url-property',
      });
    });

    it('resolves # ids against the current URL when canonical is false', () => {
      const [node] = graph(resolve({ canonical: false, jsonLd: [{ '@type': 'WebPage', '@id': '#page' }] }, site, '/p?x=1#frag'));
      expect(node['@id']).toBe('https://x.test/p#page');
    });

    it('emits no script without nodes', () => {
      expect(keys(resolve({ jsonLd: [] }))).not.toContain('script:jsonld');
    });

    it('reports a node that cannot be serialised', () => {
      const cyclic: Record<string, unknown> = { '@type': 'Thing' };
      cyclic['self'] = cyclic;
      const onError = vi.fn();
      const head = resolveHead({ jsonLd: [cyclic as never, { '@type': 'Ok' }] }, site, { path: '/', origin: null, onError });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(graph(head)).toEqual([{ '@type': 'Ok' }]);
    });
  });

  it('passes lang and dir to the html element', () => {
    expect(resolve({ lang: 'fr', dir: 'ltr' }).htmlAttrs).toEqual({ lang: 'fr', dir: 'ltr' });
  });

  it('passes the server response through untouched', () => {
    expect(resolve({ http: { status: 404, headers: { 'X-Robots-Tag': 'noindex' } } }).http).toEqual({
      status: 404,
      headers: { 'X-Robots-Tag': 'noindex' },
    });
    expect(resolve({}).http).toEqual({ headers: {} });
  });

  it('emits only the always-derived tags for an empty config with no base', () => {
    expect(keys(resolveHead({}, {}, env))).toEqual(['meta:property:og:type', 'meta:name:twitter:card']);
  });

  describe('malformed input from untyped sources', () => {
    const loose = (config: Record<string, unknown>): ResolvedHead => resolve(config as SeoConfig);

    it('drops an invalid unavailableAfter date without losing the rest of the head', () => {
      const head = loose({ title: 'T', robots: { index: false, unavailableAfter: new Date('x') } });
      expect(head.title).toBe('T');
      expect(value(head, 'meta:name:robots')).toBe('noindex');
    });

    it('ignores list fields that are not lists', () => {
      const head = loose({ title: 'T', openGraph: { videos: { url: '/v.mp4' }, audio: 'x' }, alternates: 'fr', meta: {}, links: 1, jsonLd: {} });
      expect(head.title).toBe('T');
      expect(keys(head).some((k) => k.includes('og:video'))).toBe(false);
    });

    it('treats a single string as a one-item list', () => {
      const head = loose({ openGraph: { alternateLocales: 'en_GB', article: { tags: 'news', authors: 'Ann' } } });
      expect(head.tags.filter((t) => t.attrs['property'] === 'og:locale:alternate').map((t) => t.attrs['content'])).toEqual(['en_GB']);
      expect(head.tags.filter((t) => t.attrs['property'] === 'article:tag').map((t) => t.attrs['content'])).toEqual(['news']);
      expect(head.tags.filter((t) => t.attrs['property'] === 'article:author').map((t) => t.attrs['content'])).toEqual(['Ann']);
    });

    it('ignores bots that are not a map of crawlers', () => {
      const head = loose({ bots: 'noindex' });
      expect(head.tags.some((t) => /^\d+$/.test(t.attrs['name'] ?? ''))).toBe(false);
    });

    it('contains a throwing field to its own section and keeps the status', () => {
      const onError = vi.fn();
      const article = {};
      Object.defineProperty(article, 'section', { enumerable: true, get: () => { throw new Error('boom'); } });
      const head = resolveHead(
        { title: 'T', description: 'D', openGraph: { article }, http: { status: 404 } } as SeoConfig,
        site,
        { path: '/p', origin: null, onError },
      );
      expect(head.title).toBe('T');
      expect(value(head, 'meta:name:description')).toBe('D');
      expect(value(head, 'meta:name:twitter:title')).toBe('T');
      expect(head.http.status).toBe(404);
      expect(onError).toHaveBeenCalled();
    });

    it('reports a JSON-LD node without @type', () => {
      const onError = vi.fn();
      resolveHead({ jsonLd: [{ name: 'x' } as never] }, site, { path: '/', origin: null, onError });
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  it('checks URLs in extra meta that override URL-valued tags', () => {
    const head = resolve({
      meta: [
        { property: 'og:url', content: 'javascript:alert(1)' },
        { property: 'og:image', content: '/x.png' },
        { name: 'twitter:image', content: 'data:x' },
      ],
    });
    expect(value(head, 'meta:property:og:url')).toBe('https://x.test/page');
    expect(value(head, 'meta:property:og:image')).toBe('https://x.test/x.png');
    expect(value(head, 'meta:name:twitter:image')).toBeUndefined();
    expect(head.droppedUrls.length).toBeGreaterThan(0);
  });

  it('derives og:type from article, profile or book data', () => {
    expect(value(resolve({ openGraph: { article: { section: 'News' } } }), 'meta:property:og:type')).toBe('article');
    expect(value(resolve({ openGraph: { profile: { username: 'ann' } } }), 'meta:property:og:type')).toBe('profile');
    expect(value(resolve({ openGraph: { book: { isbn: '1' } } }), 'meta:property:og:type')).toBe('book');
    expect(value(resolve({ openGraph: { type: 'website', article: { section: 'x' } } }), 'meta:property:og:type')).toBe('website');
  });

  it('falls back to the canonical and og:image when explicit og:url or twitter:image is unusable', () => {
    const head = resolve({ image: '/a.png', openGraph: { url: 'javascript:x' }, twitter: { image: 'javascript:y' } });
    expect(value(head, 'meta:property:og:url')).toBe('https://x.test/page');
    expect(value(head, 'meta:name:twitter:image')).toBe('https://x.test/a.png');
  });

  it('serialises URL and other toJSON objects inside JSON-LD', () => {
    const head = resolve({ jsonLd: [{ '@type': 'Thing', url: new URL('https://a.test/x') as never, sameAs: [new URL('https://b.test/') as never] }] });
    const node = JSON.parse(head.tags.find((t) => t.key === 'script:jsonld')?.text as string)['@graph'][0];
    expect(node.url).toBe('https://a.test/x');
    expect(node.sameAs).toEqual(['https://b.test/']);
  });

  it('checks the URL inside a refresh meta tag', () => {
    expect(value(resolve({ meta: [{ httpEquiv: 'refresh', content: '0;url=javascript:alert(1)' }] }), 'meta:http-equiv:refresh')).toBeUndefined();
    expect(value(resolve({ meta: [{ httpEquiv: 'refresh', content: '5; URL=/next' }] }), 'meta:http-equiv:refresh')).toBe(
      '5; url=https://x.test/next',
    );
    expect(value(resolve({ meta: [{ httpEquiv: 'refresh', content: '30' }] }), 'meta:http-equiv:refresh')).toBe('30');
  });

  it('emits exactly one canonical link, the last one declared', () => {
    const head = resolve({ links: [{ rel: 'canonical', href: '/one' }, { rel: 'canonical', href: '/two' }] });
    expect(keys(head).filter((k) => k.startsWith('link:canonical'))).toEqual(['link:canonical']);
    expect(head.canonical).toBe('https://x.test/two');
    expect(value(head, 'meta:property:og:url')).toBe('https://x.test/two');
  });
});
