import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  Input,
  Component,
  DestroyRef,
  Directive,
  Injectable,
  type OnInit,
  destroyPlatform,
  inject,
  input,
  PLATFORM_ID,
  provideZonelessChangeDetection,
} from '@angular/core';
import { isPlatformServer } from '@angular/common';
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
      readonly seo = injectSeo({ keywords: ['k1'], jsonLd: [{ '@type': 'Thing', '@id': '#dir' }, { '@type': 'Thing', name: 'dir-node' }] });
    }
    @Component({ selector: 'deferred-x', hostDirectives: [SeoKeywords], template: '<p>x</p>' })
    class DeferredX {
      readonly seo = injectSeo({ description: 'deferred-desc', jsonLd: [{ '@type': 'Thing', name: 'comp-node' }] });
    }
    @Component({ selector: 'page-host', imports: [DeferredX], template: '<p>page</p> @defer (hydrate on timer(100ms)) { <deferred-x /> }' })
    class PageHost {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(App, [{ path: 'h', component: PageHost }], '/h', { baseUrl: 'https://x.test' } as typeof site);
    expect(document.head.querySelector('meta[name="keywords"]')?.getAttribute('content')).toBe('k1');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('deferred-desc');
    expect(document.head.querySelector('script[type="application/ld+json"]')?.textContent).toContain('#dir');
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      appRef.tick();
    }
    // After the host hydrates, each contribution claimed its own copy: nothing is doubled.
    expect(document.querySelector('deferred-x p')).not.toBeNull();
    const hydratedGraph = document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    expect(hydratedGraph.match(/dir-node/g)).toHaveLength(1);
    expect(hydratedGraph.match(/comp-node/g)).toHaveLength(1);
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('deferred-desc');
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

  it('carries a route-provided service first injected by a deferred component', async () => {
    @Injectable()
    class ProductSeo {
      readonly seo = injectSeo({ description: 'svc-desc' });
    }
    @Component({ selector: 'details-x', template: '<p>details</p>' })
    class Details {
      readonly svc = inject(ProductSeo);
    }
    @Component({ selector: 'page-g', imports: [Details], template: '<p>page</p> @defer (hydrate on interaction) { <details-x /> }' })
    class PageG {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parsed, appRef } = await hydrate(
      App,
      [{ path: 'g', component: PageG, providers: [ProductSeo], data: { seo: { title: 'G', description: 'route-desc' } } }],
      '/g',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(parsed.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('svc-desc');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('svc-desc');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('drops server copies on the first client navigation even while their host stays on the page', async () => {
    @Component({ selector: 'footer-seo', template: '<p>footer</p>' })
    class FooterSeo {
      readonly seo = injectSeo({ author: 'footer' });
    }
    @Component({ selector: 'page-n', template: '<p>n</p>' })
    class PageN {}
    @Component({
      selector: 'app-root',
      imports: [RouterOutlet, FooterSeo],
      template: '<router-outlet /> @defer (hydrate never) { <footer-seo /> }',
    })
    class AppWithFooter {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(
      AppWithFooter as typeof App,
      [
        { path: 'a', component: PageN },
        { path: 'b', component: PageN },
      ],
      '/a',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('footer');
    await appRef.injector.get(Router).navigateByUrl('/b');
    await appRef.whenStable();
    appRef.tick();
    expect(document.head.querySelector('meta[name="author"]')).toBeNull();
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('stops applying a server copy once its unhydrated host leaves the page', async () => {
    @Component({ selector: 'gone-seo', template: '<p>gone</p>' })
    class GoneSeo {
      readonly seo = injectSeo({ author: 'gone' });
    }
    @Component({ selector: 'page-d', imports: [GoneSeo], template: '<p>d</p> @defer (hydrate never) { <gone-seo /> }' })
    class PageD {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(App, [{ path: 'd', component: PageD }], '/d', { baseUrl: 'https://x.test' } as typeof site);
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('gone');
    document.querySelector('gone-seo')?.remove();
    appRef.injector.get(Seo).contribute({ keywords: ['recompute'] });
    appRef.tick();
    expect(document.head.querySelector('meta[name="author"]')).toBeNull();
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('ranks contributions after hydrated hosts as the server did', async () => {
    @Component({ selector: 'host-a', template: '<p>a</p>' })
    class HostA {
      readonly seo = injectSeo({ description: 'a' });
    }
    @Component({ selector: 'host-b', template: '<p>b</p>' })
    class HostB implements OnInit {
      readonly seo = injectSeo({ description: 'b' });
      private readonly service = inject(Seo);
      private readonly destroyRef = inject(DestroyRef);
      ngOnInit(): void {
        this.service.contribute({ description: 'c' }, { destroyRef: this.destroyRef });
      }
    }
    @Component({ selector: 'page-o', imports: [HostA, HostB], template: '<host-a /><host-b />' })
    class PageO {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parsed, appRef } = await hydrate(App, [{ path: 'o', component: PageO }], '/o', { baseUrl: 'https://x.test' } as typeof site);
    expect(parsed.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('c');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('c');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('gives each of several route services its own server copy', async () => {
    @Injectable()
    class SvcA {
      readonly seo = injectSeo({ description: 'a-desc' });
    }
    @Injectable()
    class SvcB {
      readonly seo = injectSeo({ keywords: ['b'], jsonLd: [{ '@type': 'Thing', name: 'b-node' }] });
    }
    @Component({ selector: 'details-a', template: '<p>a</p>' })
    class DetailsA {
      readonly svc = inject(SvcA);
    }
    @Component({ selector: 'eager-b', template: '<p>b</p>' })
    class EagerB {
      readonly svc = inject(SvcB);
    }
    @Component({
      selector: 'page-two',
      imports: [DetailsA, EagerB],
      template: '@defer (hydrate on interaction) { <details-a /> } @defer (hydrate on immediate) { <eager-b /> }',
    })
    class PageTwo {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parsed, appRef } = await hydrate(
      App,
      [{ path: 'g', component: PageTwo, providers: [SvcA, SvcB], data: { seo: { title: 'G', description: 'route-desc' } } }],
      '/g',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(parsed.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('a-desc');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('a-desc');
    expect(document.head.querySelector('meta[name="keywords"]')?.getAttribute('content')).toBe('b');
    // SvcB continued its own copy (matched by config), so its node is not doubled.
    expect((document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? '').match(/b-node/g)).toHaveLength(1);
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('carries a keyed route-service contribution', async () => {
    @Injectable()
    class ProductSeo {
      private readonly server = isPlatformServer(inject(PLATFORM_ID));
      // The config differs between server and browser, so only the key can match it to its copy.
      readonly seo = injectSeo(
        { description: this.server ? 'svc-desc' : 'svc-desc-browser', jsonLd: [{ '@type': 'Thing', name: 'product-node' }] },
        { key: 'product' },
      );
    }
    @Injectable()
    class OtherSeo {
      readonly seo = injectSeo({ keywords: ['other'] });
    }
    @Component({ selector: 'eager-k', template: '<p>e</p>' })
    class EagerK {
      readonly svc = inject(ProductSeo);
    }
    @Component({ selector: 'keyed-x', template: '<p>k</p>' })
    class KeyedX {
      readonly svc = inject(ProductSeo);
    }
    @Component({
      selector: 'page-k',
      imports: [KeyedX, EagerK],
      template: '@defer (hydrate on interaction) { <keyed-x /> } <eager-k />',
    })
    class PageK {
      readonly other = inject(OtherSeo);
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(
      App,
      [{ path: 'k', component: PageK, providers: [ProductSeo, OtherSeo], data: { seo: { description: 'route-desc' } } }],
      '/k',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    // The keyed service continued its own copy: the browser value wins and its node is not doubled.
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('svc-desc-browser');
    expect((document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? '').match(/product-node/g)).toHaveLength(1);
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('claims no copy when several route services differ between server and browser', async () => {
    @Injectable()
    class SvcA {
      readonly seo = injectSeo({ description: 'a-desc' });
    }
    @Injectable()
    class SvcB {
      private readonly server = isPlatformServer(inject(PLATFORM_ID));
      readonly seo = injectSeo({ keywords: [this.server ? 'b-server' : 'b-browser'] });
    }
    @Component({ selector: 'lazy-a', template: '<p>a</p>' })
    class LazyA {
      readonly svc = inject(SvcA);
    }
    @Component({ selector: 'now-b', template: '<p>b</p>' })
    class NowB {
      readonly svc = inject(SvcB);
    }
    @Component({
      selector: 'page-diff',
      imports: [LazyA, NowB],
      template: '@defer (hydrate on interaction) { <lazy-a /> } @defer (hydrate on immediate) { <now-b /> }',
    })
    class PageDiff {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(
      App,
      [{ path: 'd', component: PageDiff, providers: [SvcA, SvcB], data: { seo: { description: 'route-desc' } } }],
      '/d',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('a-desc');
    // The live service outranks any server copy it could not be matched to.
    expect(document.head.querySelector('meta[name="keywords"]')?.getAttribute('content')).toBe('b-browser');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('carries a service from a lazily loaded route', async () => {
    @Injectable()
    class LazySvc {
      readonly seo = injectSeo({ description: 'lazy-desc' });
    }
    @Component({ selector: 'lazy-x', template: '<p>l</p>' })
    class LazyX {
      readonly svc = inject(LazySvc);
    }
    @Component({ selector: 'page-l', imports: [LazyX], template: '@defer (hydrate on interaction) { <lazy-x /> }' })
    class PageL {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { appRef } = await hydrate(
      App,
      [
        { path: 'other', component: PageL },
        {
          path: 'lazy',
          loadChildren: () => Promise.resolve([{ path: '', component: PageL, providers: [LazySvc], data: { seo: { description: 'route-desc' } } }]),
        },
      ],
      '/lazy',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('lazy-desc');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });

  it('does not let a browser-only service take the single server copy of a route', async () => {
    @Injectable()
    class SvcA {
      readonly seo = injectSeo({ description: 'a-desc' });
    }
    @Injectable()
    class SvcB {
      readonly seo = injectSeo({ keywords: ['b'] });
    }
    @Component({ selector: 'lazy-a2', template: '<p>a</p>' })
    class LazyA2 {
      readonly svc = inject(SvcA);
    }
    @Component({ selector: 'client-b2', template: '<p>b</p>' })
    class ClientB2 {
      readonly svc = inject(SvcB);
    }
    @Component({
      selector: 'page-p2',
      imports: [LazyA2, ClientB2],
      template: '@defer (hydrate on interaction) { <lazy-a2 /> } @defer (on immediate) { <client-b2 /> }',
    })
    class PageP2 {}
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { parsed, appRef } = await hydrate(
      App,
      [{ path: 'p', component: PageP2, providers: [SvcA, SvcB], data: { seo: { description: 'route-desc' } } }],
      '/p',
      { baseUrl: 'https://x.test' } as typeof site,
    );
    expect(parsed.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('a-desc');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('a-desc');
    expect(document.head.querySelector('meta[name="keywords"]')?.getAttribute('content')).toBe('b');
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });
});
