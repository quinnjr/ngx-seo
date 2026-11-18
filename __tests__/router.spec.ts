import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, ErrorHandler, InjectionToken, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Routes, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideSeo } from '../src/lib/provide-seo';
import type { SeoConfig, SeoSiteConfig } from '../src/lib/types';

@Component({ selector: 'seo-page', template: '' })
class Page {}

const SECTION = new InjectionToken<string>('SECTION');

function meta(name: string): string | null {
  return document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
}

function canonical(): string | null {
  return document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
}

function jsonLdNodes(): unknown[] {
  const text = document.head.querySelector('script[type="application/ld+json"]')?.textContent;
  return text ? JSON.parse(text)['@graph'] : [];
}

async function setup(routes: Routes, site: SeoSiteConfig = { baseUrl: 'https://x.test', titleTemplate: '%s | S' }) {
  const errors = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter(routes),
      provideSeo(site),
      { provide: SECTION, useValue: 'Injected' },
      { provide: ErrorHandler, useValue: { handleError: errors } },
    ],
  });
  const harness = await RouterTestingHarness.create();
  const go = async (url: string): Promise<void> => {
    await harness.navigateByUrl(url);
    TestBed.tick();
  };
  return { go, errors };
}

describe('route SEO layers', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
  });

  it('applies the leaf route config', async () => {
    const { go } = await setup([{ path: 'a', component: Page, data: { seo: { title: 'A', description: 'About A' } } }]);
    await go('/a');
    expect(document.title).toBe('A | S');
    expect(meta('description')).toBe('About A');
  });

  it('layers parent beneath child', async () => {
    const { go } = await setup([
      {
        path: 'docs',
        data: { seo: { author: 'Section', description: 'Section description' } },
        children: [{ path: 'page', component: Page, data: { seo: { description: 'Page description' } } }],
      },
    ]);
    await go('/docs/page');
    expect(meta('author')).toBe('Section');
    expect(meta('description')).toBe('Page description');
  });

  it('counts an inherited config once', async () => {
    const { go } = await setup([
      {
        path: 'docs',
        data: { seo: { jsonLd: [{ '@type': 'Thing' }] } },
        children: [{ path: '', component: Page }],
      },
    ]);
    await go('/docs');
    expect(jsonLdNodes()).toHaveLength(1);
  });

  it('calls a function config with the snapshot in an injection context', async () => {
    const { go } = await setup([
      {
        path: 'items/:id',
        component: Page,
        data: {
          seo: (route: ActivatedRouteSnapshot): SeoConfig => ({ title: `Item ${route.paramMap.get('id')}`, author: inject(SECTION) }),
        },
      },
    ]);
    await go('/items/7');
    expect(document.title).toBe('Item 7 | S');
    expect(meta('author')).toBe('Injected');
  });

  it('applies resolver data', async () => {
    const { go } = await setup([
      { path: 'r', component: Page, resolve: { seo: () => Promise.resolve({ title: 'Resolved' } satisfies SeoConfig) } },
    ]);
    await go('/r');
    expect(document.title).toBe('Resolved | S');
  });

  it('leaves no tag from the previous route', async () => {
    const { go } = await setup([
      { path: 'hidden', component: Page, data: { seo: { robots: { index: false }, keywords: ['x'] } } },
      { path: 'plain', component: Page },
    ]);
    await go('/hidden');
    expect(meta('robots')).toBe('noindex');
    await go('/plain');
    expect(meta('robots')).toBeNull();
    expect(meta('keywords')).toBeNull();
  });

  it('feeds the route title through the template, and seo.title wins over it', async () => {
    const { go } = await setup([
      { path: 't', component: Page, title: 'T' },
      { path: 'both', component: Page, title: 'Route', data: { seo: { title: 'Seo' } } },
    ]);
    await go('/t');
    expect(document.title).toBe('T | S');
    await go('/both');
    expect(document.title).toBe('Seo | S');
  });

  it("puts each route's title just beneath that route's seo", async () => {
    const { go } = await setup([
      {
        path: 'section',
        data: { seo: { title: 'Section', author: 'S' } },
        children: [{ path: 'child', component: Page, title: 'Child' }],
      },
    ]);
    await go('/section/child');
    expect(document.title).toBe('Child | S');
    expect(meta('author')).toBe('S');
  });

  it('follows the navigated URL for the canonical and drops the query string', async () => {
    const { go } = await setup([{ path: 'list', component: Page }]);
    await go('/list?utm_source=x');
    expect(canonical()).toBe('https://x.test/list');
  });

  it('reads a custom route data key', async () => {
    const { go } = await setup([{ path: 'k', component: Page, data: { meta: { author: 'Custom' } } }], {
      baseUrl: 'https://x.test',
      routeDataKey: 'meta',
    });
    await go('/k');
    expect(meta('author')).toBe('Custom');
  });

  it('skips a throwing function config, reports it, and completes navigation', async () => {
    const { go, errors } = await setup([
      {
        path: 'p',
        data: { seo: { author: 'Parent' } },
        children: [
          {
            path: 'c',
            component: Page,
            data: {
              seo: (): SeoConfig => {
                throw new Error('bad route seo');
              },
            },
          },
        ],
      },
    ]);
    await go('/p/c');
    expect(meta('author')).toBe('Parent');
    expect(canonical()).toBe('https://x.test/p/c');
    expect(errors).toHaveBeenCalled();
  });
});

describe('route errors', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
  });

  it('does not carry the previous page tags over when the next page fails to resolve', async () => {
    const { go } = await setup(
      [
        { path: 'a', component: Page, data: { seo: { title: 'A', description: 'About A', robots: { index: false } } } },
        { path: 'b', component: Page, data: { seo: { title: 'B' } } },
      ],
      {
        baseUrl: 'https://x.test',
        titleTemplate: (title: string) => {
          if (title === 'B') {
            throw new Error('bad template');
          }
          return title;
        },
      },
    );
    await go('/a');
    expect(meta('robots')).toBe('noindex');
    await go('/b');
    expect(meta('robots')).toBeNull();
    expect(meta('description')).toBeNull();
    expect(canonical()).toBe('https://x.test/b');
  });
});
