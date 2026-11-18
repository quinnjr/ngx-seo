import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ApplicationRef, Component, destroyPlatform, provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { bootstrapApplication, provideClientHydration, type BootstrapContext } from '@angular/platform-browser';
import { provideServerRendering, renderApplication } from '@angular/platform-server';
import { Router, RouterOutlet, provideRouter, type Routes } from '@angular/router';
import { injectSeo } from '../src/lib/inject-seo';
import { provideSeo } from '../src/lib/provide-seo';
import { SEO_ATTR } from '../src/lib/reconciler';
import type { SeoConfig, SeoSiteConfig } from '../src/lib/types';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class App {}

@Component({ selector: 'seo-post', template: '<p>post</p>' })
class Post {
  readonly seo = injectSeo({ author: 'Ann', jsonLd: [{ '@type': 'BlogPosting', headline: 'H' }] });
}

@Component({ selector: 'seo-plain', template: '<p>plain</p>' })
class Plain {}

const routes: Routes = [
  { path: 'plain', component: Plain },
  {
    path: 'post',
    component: Post,
    resolve: {
      seo: () => new Promise<SeoConfig>((resolve) => setTimeout(() => resolve({ title: 'Post', description: 'About', lang: 'de' }), 5)),
    },
  },
];

const site: SeoSiteConfig = { siteName: 'S', baseUrl: 'https://x.test', titleTemplate: '%s | S' };
const SHELL = '<!doctype html><html><head><title>Shell</title></head><body><app-root></app-root></body></html>';

describe('hydration over real server output', () => {
  beforeAll(() => {
    getTestBed().resetTestEnvironment();
    destroyPlatform();
  });

  it('adopts the server tags without duplicating or recreating them', async () => {
    const html = await renderApplication(
      (context: BootstrapContext) =>
        bootstrapApplication(
          App,
          {
            providers: [
              provideZonelessChangeDetection(),
              provideServerRendering(),
              provideClientHydration(),
              provideRouter(routes),
              provideSeo(site),
            ],
          },
          context,
        ),
      { document: SHELL, url: '/post' },
    );
    destroyPlatform();

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const attr of Array.from(document.documentElement.attributes)) {
      document.documentElement.removeAttribute(attr.name);
    }
    for (const attr of Array.from(parsed.documentElement.attributes)) {
      document.documentElement.setAttribute(attr.name, attr.value);
    }
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState(null, '', '/post');
    const serverDescription = document.head.querySelector('meta[name="description"]');
    expect(serverDescription?.getAttribute(SEO_ATTR)).toBe('meta:name:description');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appRef = await bootstrapApplication(App, {
      providers: [provideZonelessChangeDetection(), provideClientHydration(), provideRouter(routes), provideSeo(site)],
    });
    await appRef.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 20));
    appRef.tick();

    expect(document.title).toBe('Post | S');
    expect(document.head.querySelector('meta[name="description"]')).toBe(serverDescription);
    for (const selector of [
      'meta[name="description"]',
      'meta[name="author"]',
      'link[rel="canonical"]',
      'meta[property="og:title"]',
      'script[type="application/ld+json"]',
    ]) {
      expect(document.head.querySelectorAll(selector), selector).toHaveLength(1);
    }
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('NG05'))).toEqual([]);
    expect(document.documentElement.getAttribute('lang')).toBe('de');

    await appRef.injector.get(Router).navigateByUrl('/plain');
    await appRef.whenStable();
    appRef.tick();
    expect(document.title).toBe('Shell');
    expect(document.documentElement.hasAttribute('lang')).toBe(false);
    expect(document.head.querySelector('meta[name="author"]')).toBeNull();
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });
});
