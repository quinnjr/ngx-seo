// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Component, REQUEST, RESPONSE_INIT, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication, type BootstrapContext } from '@angular/platform-browser';
import { provideServerRendering, renderApplication } from '@angular/platform-server';
import { RouterOutlet, provideRouter, type Routes } from '@angular/router';
import { article, faqPage } from '../src/lib/builders';
import { injectSeo } from '../src/lib/inject-seo';
import { provideSeo } from '../src/lib/provide-seo';
import type { SeoConfig, SeoSiteConfig } from '../src/lib/types';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class App {}

@Component({ selector: 'seo-leaf', template: '<p>leaf</p>' })
class Leaf {
  readonly seo = injectSeo({ jsonLd: [faqPage([{ question: 'Q', answer: 'A' }])] });
}

@Component({ selector: 'seo-broken', template: '<p>broken</p>' })
class Broken {
  readonly seo = injectSeo(() => {
    throw new Error('bad contribution');
  });
}

@Component({ selector: 'seo-missing', template: '<p>missing</p>' })
class Missing {}

const delayed = (config: SeoConfig) => () => new Promise<SeoConfig>((resolve) => setTimeout(() => resolve(config), 10));

const routes: Routes = [
  {
    path: 'leaf',
    component: Leaf,
    resolve: {
      seo: delayed({ title: 'Leaf', description: 'Leaf description', jsonLd: [article({ headline: 'H' })] }),
    },
  },
  { path: 'broken', component: Broken, data: { seo: { title: 'Broken' } } },
  {
    path: 'missing',
    component: Missing,
    data: { seo: { title: 'Not found', robots: { index: false }, http: { status: 404, headers: { 'X-Robots-Tag': 'noindex' } } } },
  },
];

const DOC = '<!doctype html><html><head><title>Shell</title><meta name="keywords" content="shell"></head><body><app-root></app-root></body></html>';

async function render(url: string, site: SeoSiteConfig, responseInit: ResponseInit = {}): Promise<string> {
  const bootstrap = (context: BootstrapContext) =>
    bootstrapApplication(
      App,
      {
        providers: [provideZonelessChangeDetection(), provideServerRendering(), provideRouter(routes), provideSeo(site)],
      },
      context,
    );
  return renderApplication(bootstrap, {
    document: DOC,
    url,
    platformProviders: [
      { provide: REQUEST, useValue: new Request(`https://req.test${url}`) },
      { provide: RESPONSE_INIT, useValue: responseInit },
    ],
  });
}

const site: SeoSiteConfig = { siteName: 'S', baseUrl: 'https://x.test', titleTemplate: '%s | S' };

describe('server rendering', () => {
  it('serialises the complete head, including async resolver data and component contributions', async () => {
    const html = await render('/leaf', site);
    expect(html).toContain('<title>Leaf | S</title>');
    expect(html).toMatch(/<meta[^>]*name="description"[^>]*content="Leaf description"/);
    expect(html).toMatch(/<link[^>]*rel="canonical"[^>]*href="https:\/\/x.test\/leaf"/);
    expect(html).toMatch(/<meta[^>]*property="og:title"[^>]*content="Leaf"/);
    expect(html).toMatch(/<meta[^>]*name="twitter:card"[^>]*content="summary"/);
    expect(html).not.toContain('content="shell"');
    const scripts = html.match(/<script[^>]*application\/ld\+json[^>]*>([^<]*)<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('"FAQPage"');
    expect(scripts[0]).toContain('"Article"');
  });

  it('writes status and headers to the response', async () => {
    const responseInit: ResponseInit = {};
    await render('/missing', site, responseInit);
    expect(responseInit.status).toBe(404);
    expect(new Headers(responseInit.headers).get('X-Robots-Tag')).toBe('noindex');
  });

  it('adds to existing response headers', async () => {
    const responseInit: ResponseInit = { headers: new Headers({ 'Content-Type': 'text/html' }) };
    await render('/missing', site, responseInit);
    const headers = responseInit.headers as Headers;
    expect(headers.get('X-Robots-Tag')).toBe('noindex');
    expect(headers.get('Content-Type')).toBe('text/html');
  });

  it('still renders when a contribution throws', async () => {
    const html = await render('/broken', site);
    expect(html).toContain('<title>Broken | S</title>');
    expect(html).toContain('<p>broken</p>');
  });

  it('uses the request origin when there is no baseUrl', async () => {
    const html = await render('/leaf', { titleTemplate: '%s | S' });
    expect(html).toMatch(/<link[^>]*rel="canonical"[^>]*href="https:\/\/req.test\/leaf"/);
  });
});
