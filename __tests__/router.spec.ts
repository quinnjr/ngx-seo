import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Input, Component, ErrorHandler, InjectionToken, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { APP_BASE_HREF, NgComponentOutlet } from '@angular/common';
import {
  ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
  DetachedRouteHandle,
  RouteReuseStrategy,
  RouterStateSnapshot,
  Routes,
  TitleStrategy,
  Router,
  RouterModule,
  RouterOutlet,
  provideRouter,
} from '@angular/router';
import { injectSeo } from '../src/lib/inject-seo';
import { HeadReconciler } from '../src/lib/reconciler';
import { ApplicationRef, Injectable, NgModule, input, provideEnvironmentInitializer, signal } from '@angular/core';
import { faqPage } from '../src/lib/builders';
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

@Injectable()
class CustomTitle extends TitleStrategy {
  override updateTitle(snapshot: RouterStateSnapshot): void {
    document.title = `Custom ${this.buildTitle(snapshot)}`;
  }
}

async function setup(
  routes: Routes,
  site: SeoSiteConfig = { baseUrl: 'https://x.test', titleTemplate: '%s | S' },
  extra: unknown[] = [],
) {
  const errors = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter(routes),
      provideSeo(site),
      ...(extra as never[]),
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

  it('leaves titles to an app TitleStrategy provided after provideSeo', async () => {
    const { go } = await setup([{ path: 't', component: Page, title: 'T', data: { seo: { description: 'D' } } }], undefined, [
      { provide: TitleStrategy, useClass: CustomTitle },
    ]);
    await go('/t');
    expect(document.title).toBe('Custom T');
    expect(meta('description')).toBe('D');
  });

  it('includes the app base href in the canonical', async () => {
    const { go } = await setup([{ path: 'list', component: Page }], { baseUrl: 'https://x.test' }, [
      { provide: APP_BASE_HREF, useValue: '/blog/' },
    ]);
    await go('/list');
    expect(canonical()).toBe('https://x.test/blog/list');
  });

  it('includes the baseUrl path in the canonical', async () => {
    const { go } = await setup([{ path: 'list', component: Page }], { baseUrl: 'https://x.test/docs/' });
    await go('/list');
    expect(canonical()).toBe('https://x.test/docs/list');
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
    const broken: Record<string, unknown> = {};
    Object.defineProperty(broken, 'title', { enumerable: true, get: () => { throw new Error('unreadable layer'); } });
    const { go, errors } = await setup([
      { path: 'a', component: Page, data: { seo: { title: 'A', description: 'About A', robots: { index: false } } } },
      { path: 'b', component: Page, data: { seo: broken } },
    ]);
    await go('/a');
    expect(meta('robots')).toBe('noindex');
    await go('/b');
    expect(meta('robots')).toBeNull();
    expect(meta('description')).toBeNull();
    expect(canonical()).toBe('https://x.test/b');
    expect(errors).toHaveBeenCalled();
  });
});

describe('route lifecycle', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
  });

  @Component({ selector: 'seo-kept', template: '' })
  class Kept {
    readonly seo = injectSeo({ title: 'A title', description: 'A desc', robots: { index: false } });
  }

  class KeepA extends BaseRouteReuseStrategy {
    private stored: DetachedRouteHandle | null = null;
    override shouldDetach(route: ActivatedRouteSnapshot): boolean {
      return route.routeConfig?.path === 'a';
    }
    override store(_route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
      this.stored = handle;
    }
    override shouldAttach(route: ActivatedRouteSnapshot): boolean {
      return route.routeConfig?.path === 'a' && this.stored !== null;
    }
    override retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
      return route.routeConfig?.path === 'a' ? this.stored : null;
    }
  }

  it('drops contributions from a detached route and restores them when it is reattached', async () => {
    const { go } = await setup(
      [
        { path: 'a', component: Kept },
        { path: 'b', component: Page, data: { seo: { title: 'B title' } } },
      ],
      undefined,
      [{ provide: RouteReuseStrategy, useClass: KeepA }],
    );
    await go('/a');
    expect(document.title).toBe('A title | S');
    await go('/b');
    expect(document.title).toBe('B title | S');
    expect(meta('robots')).toBeNull();
    expect(meta('description')).toBeNull();
    await go('/a');
    expect(document.title).toBe('A title | S');
    expect(meta('robots')).toBe('noindex');
  });

  it('moves straight from one page to the next without an intermediate head', async () => {
    const { go } = await setup([
      { path: 'a', component: Kept },
      { path: 'b', component: Page, data: { seo: { title: 'B title', description: 'B desc' } } },
    ]);
    await go('/a');
    const applied: (string | null)[] = [];
    const spy = vi.spyOn(HeadReconciler.prototype, 'apply').mockImplementation(function (this: HeadReconciler, head) {
      applied.push(head.title);
    });
    await go('/b');
    spy.mockRestore();
    expect(applied).toEqual(['B title | S']);
  });

  @Component({ selector: 'seo-shell', imports: [RouterOutlet], template: '<router-outlet /><router-outlet name="side" />' })
  class Shell {}

  it('never reads routes in a named outlet', async () => {
    const { go } = await setup([
      {
        path: 'page',
        component: Shell,
        data: { seo: { title: 'Page' } },
        children: [{ path: 'popup', outlet: 'side', component: Page, data: { seo: { title: 'POPUP', robots: { index: false } } } }],
      },
    ]);
    await go('/page/(side:popup)');
    expect(document.title).toBe('Page | S');
    expect(meta('robots')).toBeNull();
  });

  it('applies a shared config the route declares itself, even when an ancestor used it too', async () => {
    const NOINDEX: SeoConfig = { robots: { index: false } };
    const { go } = await setup([
      {
        path: 'a',
        data: { seo: NOINDEX },
        children: [
          {
            path: 'b',
            data: { seo: { robots: { index: true } } },
            children: [{ path: 'c', component: Page, data: { seo: NOINDEX } }],
          },
        ],
      },
    ]);
    await go('/a/b/c');
    expect(meta('robots')).toBe('noindex');
  });

  it('reports a route seo function that returns a promise', async () => {
    const { go, errors } = await setup([{ path: 'p', component: Page, data: { seo: async () => ({ title: 'Async' }) } }]);
    await go('/p');
    expect(errors).toHaveBeenCalled();
    expect(String((errors.mock.calls[0][0] as Error).message)).toContain('resolver');
  });

  it('leaves the title to an app TitleStrategy even with a defaultTitle', async () => {
    const { go } = await setup([{ path: 't', component: Page, title: 'T' }], { baseUrl: 'https://x.test', defaultTitle: 'Site' }, [
      { provide: TitleStrategy, useClass: CustomTitle },
    ]);
    await go('/t');
    expect(document.title).toBe('Custom T');
  });

  it("drops a route-provided service's contribution when the route is left", async () => {
    @Injectable()
    class DraftSeo {
      readonly seo = injectSeo({ title: 'Draft', robots: { index: false } });
    }
    @Component({ selector: 'seo-draft', template: '' })
    class DraftPage {
      readonly drafts = inject(DraftSeo);
    }
    const { go } = await setup([
      { path: 'drafts', providers: [DraftSeo], component: DraftPage },
      { path: 'home', component: Page, data: { seo: { title: 'Home' } } },
    ]);
    await go('/drafts');
    expect(document.title).toBe('Draft | S');
    await go('/home');
    expect(document.title).toBe('Home | S');
    expect(meta('robots')).toBeNull();
    await go('/drafts');
    expect(document.title).toBe('Draft | S');
  });

  it('drops contributions from services of a lazily loaded route when it is left', async () => {
    @Injectable()
    class LazySeo {
      readonly seo = injectSeo({ title: 'Lazy', robots: { index: false } });
    }
    @Component({ selector: 'seo-lazy', template: '' })
    class LazyPage {
      readonly lazy = inject(LazySeo);
    }
    @NgModule({ imports: [RouterModule.forChild([{ path: '', component: LazyPage }])], providers: [LazySeo] })
    class LazyModule {}
    const { go } = await setup([
      { path: 'standalone', loadChildren: () => Promise.resolve([{ path: '', providers: [LazySeo], component: LazyPage }]) },
      { path: 'module', loadChildren: () => Promise.resolve(LazyModule) },
      { path: 'home', component: Page, data: { seo: { title: 'Home' } } },
    ]);
    for (const url of ['/standalone', '/module']) {
      await go(url);
      expect(meta('robots'), url).toBe('noindex');
      await go('/home');
      expect(meta('robots'), url).toBeNull();
      expect(document.title, url).toBe('Home | S');
    }
  });

  it('keeps a root service contribution when routes are never reused', async () => {
    @Injectable({ providedIn: 'root' })
    class SiteSeo {
      readonly seo = injectSeo({ author: 'site-wide' });
    }
    class NeverReuse extends BaseRouteReuseStrategy {
      override shouldReuseRoute(): boolean {
        return false;
      }
    }
    const { go } = await setup(
      [
        { path: 'a', component: Page },
        { path: 'b', component: Page },
      ],
      undefined,
      [{ provide: RouteReuseStrategy, useClass: NeverReuse }],
    );
    await go('/a');
    TestBed.inject(SiteSeo);
    TestBed.tick();
    expect(meta('author')).toBe('site-wide');
    await go('/b');
    expect(meta('author')).toBe('site-wide');
  });

  it('does not warn about a missing title while an app TitleStrategy owns titles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { go } = await setup([{ path: 't', component: Page, title: 'T', data: { seo: { description: 'D' } } }], undefined, [
      { provide: TitleStrategy, useClass: CustomTitle },
    ]);
    await go('/t');
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('title'))).toEqual([]);
    warn.mockRestore();
  });

  it('ignores injectSeo from a component in a named outlet', async () => {
    @Component({ selector: 'seo-popup', template: '' })
    class Popup {
      readonly seo = injectSeo({ title: 'POPUP', robots: { index: false } });
    }
    @Component({ selector: 'seo-shell2', imports: [RouterOutlet], template: '<router-outlet /><router-outlet name="side" />' })
    class Shell2 {}
    const { go } = await setup([
      { path: 'page', component: Shell2, data: { seo: { title: 'Page' } }, children: [{ path: 'popup', outlet: 'side', component: Popup }] },
    ]);
    await go('/page/(side:popup)');
    expect(document.title).toBe('Page | S');
    expect(meta('robots')).toBeNull();
  });

  it('waits for a contribution whose required input is not bound yet, without reporting it', async () => {
    @Component({ selector: 'seo-faq', template: '' })
    class Faq {
      // JIT cannot see signal inputs without metadata; AOT builds do not need this.
      @Input({ isSignal: true, alias: 'items', required: true } as never)
      readonly items = input.required<{ question: string; answer: string }[]>();
      readonly seo = injectSeo(() => ({ jsonLd: [faqPage(this.items())] }));
    }
    @Component({ selector: 'seo-faq-page', imports: [Faq], template: '<seo-faq [items]="items" />' })
    class FaqPageCmp {
      readonly items = [{ question: 'Q', answer: 'A' }];
    }
    const applied: boolean[] = [];
    const original = HeadReconciler.prototype.apply;
    const spy = vi.spyOn(HeadReconciler.prototype, 'apply').mockImplementation(function (this: HeadReconciler, head) {
      applied.push(head.tags.some((t) => (t.text ?? '').includes('FAQPage')));
      return original.call(this, head);
    });
    const { go, errors } = await setup([{ path: 'faq', component: FaqPageCmp }]);
    applied.length = 0;
    await go('/faq');
    await TestBed.inject(ApplicationRef).whenStable();
    TestBed.tick();
    spy.mockRestore();
    expect(errors).not.toHaveBeenCalled();
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every(Boolean)).toBe(true);
  });

  it('keeps named-outlet segments out of the canonical', async () => {
    @Component({ selector: 'seo-shell3', imports: [RouterOutlet], template: '<router-outlet /><router-outlet name="side" />' })
    class Shell3 {}
    const { go } = await setup([
      { path: 'page', component: Shell3, children: [{ path: 'popup', outlet: 'side', component: Page }] },
    ]);
    await go('/page/(side:popup)');
    expect(canonical()).toBe('https://x.test/page');
  });

  describe('route services created outside a component', () => {
    @Injectable()
    class DraftSeo {
      readonly seo = injectSeo({ robots: { index: false } });
    }

    async function leaves(routes: Routes, url: string): Promise<void> {
      const { go } = await setup([...routes, { path: 'home', component: Page }]);
      await go(url);
      expect(meta('robots'), url).toBe('noindex');
      await go('/home');
      expect(meta('robots'), url).toBeNull();
    }

    it('stops when the service was created by a route environment initializer', async () => {
      await leaves(
        [{ path: 'drafts', providers: [DraftSeo, provideEnvironmentInitializer(() => void inject(DraftSeo))], component: Page }],
        '/drafts',
      );
    });

    it('stops when the service was created by a lazy NgModule constructor', async () => {
      @NgModule({ imports: [RouterModule.forChild([{ path: '', component: Page }])], providers: [DraftSeo] })
      class EagerModule {
        constructor() {
          inject(DraftSeo);
        }
      }
      await leaves([{ path: 'lazy', loadChildren: () => Promise.resolve(EagerModule) }], '/lazy');
    });

    it('follows a layout that imports the service module across its child pages', async () => {
      @NgModule({ providers: [DraftSeo] })
      class ShopModule {}
      @Component({ selector: 'seo-shop-layout', imports: [ShopModule, RouterOutlet], template: '<router-outlet />' })
      class ShopLayout {
        readonly service = inject(DraftSeo);
      }
      const { go } = await setup([
        {
          path: 'shop',
          component: ShopLayout,
          children: [
            { path: 'a', component: Page },
            { path: 'b', component: Page },
          ],
        },
        { path: 'home', component: Page },
      ]);
      const seen: (string | null)[] = [];
      for (const url of ['/shop/a', '/shop/b', '/home', '/shop/b']) {
        await go(url);
        seen.push(meta('robots'));
      }
      expect(seen).toEqual(['noindex', 'noindex', null, 'noindex']);
    });

    it('applies app-wide for a module service of a shell component shown before the first navigation', async () => {
      @Injectable()
      class WidgetSeo {
        readonly seo = injectSeo({ author: 'widget' });
      }
      @NgModule({ providers: [WidgetSeo] })
      class WidgetModule {}
      @Component({ selector: 'seo-widget', imports: [WidgetModule], template: '' })
      class Widget {
        readonly service = inject(WidgetSeo);
      }
      @Component({ selector: 'seo-other', template: '' })
      class OtherPage {}
      const show = signal(false);
      @Component({ selector: 'seo-root', imports: [Widget, RouterOutlet], template: '@if (show()) { <seo-widget /> } <router-outlet />' })
      class Root {
        readonly show = show;
      }
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideRouter([
            { path: 'a', component: Page },
            { path: 'b', component: OtherPage },
          ]),
          provideSeo({ baseUrl: 'https://x.test', diagnostics: 'off' }),
        ],
      });
      show.set(true);
      const fixture = TestBed.createComponent(Root);
      await fixture.whenStable();
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/a');
      await fixture.whenStable();
      const seen = [meta('author')];
      await router.navigateByUrl('/b');
      await fixture.whenStable();
      seen.push(meta('author'));
      expect(seen).toEqual(['widget', 'widget']);
    });

    it('scopes a module service of a widget rendered dynamically in a page to that page', async () => {
      @NgModule({ providers: [DraftSeo] })
      class WidgetModule2 {}
      @Component({ selector: 'seo-dyn-widget', imports: [WidgetModule2], template: '' })
      class DynWidget {
        readonly service = inject(DraftSeo);
      }
      @Component({ selector: 'seo-dyn-page', imports: [NgComponentOutlet], template: '<ng-container *ngComponentOutlet="widget" />' })
      class DynPage {
        readonly widget = DynWidget;
      }
      @Component({ selector: 'seo-plain-page', template: '' })
      class PlainPage {}
      const { go } = await setup([
        { path: 'a', component: DynPage },
        { path: 'b', component: PlainPage },
      ]);
      const seen: (string | null)[] = [];
      for (const url of ['/a', '/b', '/a']) {
        await go(url);
        seen.push(meta('robots'));
      }
      expect(seen).toEqual(['noindex', null, 'noindex']);
    });

    it('never applies a module service of a component in a named outlet', async () => {
      @NgModule({ providers: [DraftSeo] })
      class ChatModule {}
      @Component({ selector: 'seo-chat', imports: [ChatModule], template: '' })
      class Chat {
        readonly service = inject(DraftSeo);
      }
      @Component({ selector: 'seo-shell4', imports: [RouterOutlet], template: '<router-outlet /><router-outlet name="side" />' })
      class Shell4 {}
      const { go } = await setup([{ path: 'a', component: Shell4, children: [{ path: 'chat', outlet: 'side', component: Chat }] }]);
      await go('/a/(side:chat)');
      expect(meta('robots')).toBeNull();
      await go('/a');
      expect(meta('robots')).toBeNull();
    });

    it('follows a standalone page that imports the service module, on every visit and route', async () => {
      @NgModule({ providers: [DraftSeo] })
      class SharedModule {}
      @Component({ selector: 'seo-shared-page', imports: [SharedModule], template: '' })
      class SharedPage {
        readonly service = inject(DraftSeo);
      }
      const { go } = await setup([
        { path: 'drafts', component: SharedPage },
        { path: 'archive', component: SharedPage },
        { path: 'home', component: Page },
      ]);
      const seen: (string | null)[] = [];
      for (const url of ['/drafts', '/home', '/drafts', '/archive']) {
        await go(url);
        seen.push(meta('robots'));
      }
      expect(seen).toEqual(['noindex', null, 'noindex', 'noindex']);
    });

    it('stops when the service comes from an NgModule imported by a standalone page', async () => {
      @NgModule({ providers: [DraftSeo] })
      class DraftModule {}
      @Component({ selector: 'seo-d-page', imports: [DraftModule], template: '' })
      class DraftPage {
        readonly service = inject(DraftSeo);
      }
      await leaves([{ path: 'drafts', component: DraftPage }], '/drafts');
    });
  });
});

