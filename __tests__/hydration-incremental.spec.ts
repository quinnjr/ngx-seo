import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Input, Component, Directive, destroyPlatform, input, provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import {
  bootstrapApplication,
  provideClientHydration,
  withIncrementalHydration,
  type BootstrapContext,
} from '@angular/platform-browser';
import { provideServerRendering, renderApplication } from '@angular/platform-server';
import { Router, RouterOutlet, provideRouter, type Routes } from '@angular/router';
import { faqPage, type FaqItem } from '../src/lib/builders';
import { injectSeo } from '../src/lib/inject-seo';
import { provideSeo } from '../src/lib/provide-seo';
import { Seo } from '../src/lib/seo.service';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class App {}

@Component({ selector: 'faq-section', template: '<p>faq</p>' })
class FaqSection {
  // JIT cannot see signal inputs without metadata; AOT builds do not need this.
  @Input({ isSignal: true, alias: 'items', required: true } as never)
  readonly items = input.required<FaqItem[]>();
  readonly seo = injectSeo(() => ({ description: 'faq-desc', jsonLd: [faqPage(this.items())] }));
}

@Component({
  selector: 'faq-page',
  imports: [FaqSection],
  template: '<p>page</p> @defer (hydrate on interaction) { <faq-section [items]="items" /> }',
})
class FaqPage {
  readonly items = [{ question: 'Q', answer: 'A' }];
}

@Component({ selector: 'other-page', template: '<p>other</p>' })
class OtherPage {}

const routes: Routes = [
  { path: 'faq', component: FaqPage, data: { seo: { title: 'FAQ', description: 'd' } } },
  { path: 'other', component: OtherPage, data: { seo: { title: 'Other' } } },
];
const site = {
  baseUrl: 'https://x.test',
  defaults: { description: 'site', jsonLd: [{ '@type': 'Organization', '@id': '/#org', name: 'O' }] },
};
const SHELL = '<!doctype html><html><head><title>Shell</title></head><body><app-root></app-root></body></html>';

describe('incremental hydration', () => {
  beforeAll(() => {
    getTestBed().resetTestEnvironment();
    destroyPlatform();
  });

  it('keeps server tags from a not-yet-hydrated @defer block until the first client navigation', async () => {
    const html = await renderApplication(
      (context: BootstrapContext) =>
        bootstrapApplication(
          App,
          {
            providers: [
              provideZonelessChangeDetection(),
              provideServerRendering(),
              provideClientHydration(withIncrementalHydration()),
              provideRouter(routes),
              provideSeo(site),
            ],
          },
          context,
        ),
      { document: SHELL, url: '/faq' },
    );
    destroyPlatform();
    expect(html).toContain('FAQPage');

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const attr of Array.from(parsed.documentElement.attributes)) {
      document.documentElement.setAttribute(attr.name, attr.value);
    }
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState(null, '', '/faq');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appRef = await bootstrapApplication(App, {
      providers: [
        provideZonelessChangeDetection(),
        provideClientHydration(withIncrementalHydration()),
        provideRouter(routes),
        provideSeo(site),
      ],
    });
    await appRef.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 50));
    appRef.tick();
    const graph = document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    expect(graph).toContain('FAQPage');
    expect(graph).toContain('Organization');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('faq-desc');

    await appRef.injector.get(Router).navigateByUrl('/other');
    await appRef.whenStable();
    appRef.tick();
    expect(document.title).toBe('Other');
    expect(document.head.querySelector('script[type="application/ld+json"]')?.textContent).not.toContain('FAQPage');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('site');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  async function hydrate(app: typeof App, appRoutes: Routes, url: string, config = site) {
    const html = await renderApplication(
      (context: BootstrapContext) =>
        bootstrapApplication(
          app,
          {
            providers: [
              provideZonelessChangeDetection(),
              provideServerRendering(),
              provideClientHydration(withIncrementalHydration()),
              provideRouter(appRoutes),
              provideSeo(config),
            ],
          },
          context,
        ),
      { document: SHELL, url },
    );
    destroyPlatform();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const attr of Array.from(parsed.documentElement.attributes)) {
      document.documentElement.setAttribute(attr.name, attr.value);
    }
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState(null, '', url);
    const appRef = await bootstrapApplication(app, {
      providers: [
        provideZonelessChangeDetection(),
        provideClientHydration(withIncrementalHydration()),
        provideRouter(appRoutes),
        provideSeo(config),
      ],
    });
    await appRef.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 50));
    appRef.tick();
    return { parsed, appRef };
  }

  it('keeps the server order and ignores named outlets before deferred blocks hydrate', async () => {
    @Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet /><router-outlet name="side" />' })
    class TwoOutlets {}
    @Component({ selector: 'child-seo', template: '<p>child</p>' })
    class Child {
      readonly seo = injectSeo({ description: 'child-desc' });
    }
    @Component({ selector: 'side-seo', template: '<p>side</p>' })
    class SideInner {
      readonly seo = injectSeo({ title: 'SIDE-LEAK' });
    }
    @Component({ selector: 'side-page', imports: [SideInner], template: '@defer (hydrate on interaction) { <side-seo /> }' })
    class SidePage {}
    @Component({ selector: 'page-x', imports: [Child], template: '<p>page</p> @defer (hydrate on interaction) { <child-seo /> }' })
    class PageX {
      readonly seo = injectSeo({ description: 'page-desc' });
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parsed, appRef } = await hydrate(
      TwoOutlets,
      [
        { path: 'p', component: PageX, data: { seo: { title: 'P' } } },
        { path: 's', component: SidePage, outlet: 'side' },
      ],
      '/p(side:s)',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(parsed.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('child-desc');
    expect(parsed.title).toBe('P');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('child-desc');
    expect(document.title).toBe('P');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('hands over from the server copy to the hydrated component without duplicates', async () => {
    @Component({
      selector: 'faq-page',
      imports: [FaqSection],
      template: '<p>page</p> @defer (hydrate on timer(100ms)) { <faq-section [items]="items" /> }',
    })
    class TimedFaqPage {
      readonly items = [{ question: 'Q', answer: 'A' }];
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(App, [{ path: 'faq', component: TimedFaqPage, data: { seo: { title: 'FAQ' } } }], '/faq');
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      appRef.tick();
    }
    const graph = document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    expect(graph.match(/FAQPage/g)).toHaveLength(1);
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('faq-desc');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('keeps every contribution on one host, such as a host directive', async () => {
    @Directive({ selector: '[seoKeywords]' })
    class SeoKeywords {
      readonly seo = injectSeo({ keywords: ['k1'], jsonLd: [{ '@type': 'Thing', '@id': '#dir' }] });
    }
    @Component({ selector: 'deferred-x', hostDirectives: [SeoKeywords], template: '<p>x</p>' })
    class DeferredX {
      readonly seo = injectSeo({ description: 'deferred-desc' });
    }
    @Component({ selector: 'page-host', imports: [DeferredX], template: '<p>page</p> @defer (hydrate on interaction) { <deferred-x /> }' })
    class PageHost {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(App, [{ path: 'h', component: PageHost }], '/h', { baseUrl: 'https://x.test' } as typeof site);
    expect(document.head.querySelector('meta[name="keywords"]')?.getAttribute('content')).toBe('k1');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('deferred-desc');
    expect(document.head.querySelector('script[type="application/ld+json"]')?.textContent).toContain('#dir');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('ranks a contribution made after hydration above every server contribution', async () => {
    @Component({ selector: 'deferred-y', template: '<p>y</p>' })
    class DeferredY {
      readonly seo = injectSeo({ description: 'deferred-desc' });
    }
    @Component({ selector: 'page-y', imports: [DeferredY], template: '<p>page</p> @defer (hydrate on timer(100ms)) { <deferred-y /> }' })
    class PageY {
      readonly seo = injectSeo({ title: 'Y' });
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(App, [{ path: 'y', component: PageY }], '/y', { baseUrl: 'https://x.test' } as typeof site);
    appRef.injector.get(Seo).contribute({ description: 'user-chosen' });
    appRef.tick();
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('user-chosen');
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      appRef.tick();
    }
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('user-chosen');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });
});

