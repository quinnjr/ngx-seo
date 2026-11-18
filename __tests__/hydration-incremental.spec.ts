import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Input, Component, destroyPlatform, input, provideZonelessChangeDetection } from '@angular/core';
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

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class App {}

@Component({ selector: 'faq-section', template: '<p>faq</p>' })
class FaqSection {
  // JIT cannot see signal inputs without metadata; AOT builds do not need this.
  @Input({ isSignal: true, alias: 'items', required: true } as never)
  readonly items = input.required<FaqItem[]>();
  readonly seo = injectSeo(() => ({ jsonLd: [faqPage(this.items())] }));
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
const site = { baseUrl: 'https://x.test' };
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
    expect(document.head.querySelector('script[type="application/ld+json"]')?.textContent).toContain('FAQPage');

    await appRef.injector.get(Router).navigateByUrl('/other');
    await appRef.whenStable();
    appRef.tick();
    expect(document.title).toBe('Other');
    expect(document.head.querySelector('script[type="application/ld+json"]')).toBeNull();
    errors.mockRestore();
    appRef.destroy();
    destroyPlatform();
  });
});
