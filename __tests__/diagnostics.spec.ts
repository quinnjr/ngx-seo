import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApplicationRef, Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { diagnose } from '../src/lib/diagnostics';
import { resolveHead } from '../src/lib/derive';
import { mergeLayers } from '../src/lib/merge';
import { injectSeo } from '../src/lib/inject-seo';
import { provideSeo } from '../src/lib/provide-seo';
import { Seo } from '../src/lib/seo.service';
import type { SeoConfig, SeoSiteConfig } from '../src/lib/types';

const site = { baseUrl: 'https://x.test' };

function run(layers: SeoConfig[], path = '/page'): string[] {
  const head = resolveHead(mergeLayers(layers), site, { path, origin: null });
  return diagnose(head, layers, `https://x.test${path}`);
}

describe('diagnose', () => {
  it('returns nothing for a clean head', () => {
    expect(run([{ title: 'T', description: 'D' }])).toEqual([]);
  });

  it('flags a missing title and a missing description', () => {
    const messages = run([{}]);
    expect(messages.some((m) => m.includes('title'))).toBe(true);
    expect(messages.some((m) => m.includes('description'))).toBe(true);
  });

  it('flags a URL that was dropped', () => {
    expect(run([{ title: 'T', description: 'D', image: 'javascript:x' }]).some((m) => m.includes('image'))).toBe(true);
  });

  it('flags two JSON-LD nodes with the same @id in one layer', () => {
    const messages = run([
      { title: 'T', description: 'D', jsonLd: [{ '@type': 'A', '@id': '#x' }, { '@type': 'B', '@id': '#x' }] },
    ]);
    expect(messages.some((m) => m.includes('#x'))).toBe(true);
  });

  it('does not flag the same @id across layers', () => {
    expect(
      run([{ title: 'T', description: 'D', jsonLd: [{ '@type': 'A', '@id': '#x' }] }, { jsonLd: [{ '@type': 'B', '@id': '#x' }] }]),
    ).toEqual([]);
  });

  it('flags noindex with a canonical pointing elsewhere', () => {
    const messages = run([{ title: 'T', description: 'D', robots: { index: false }, canonical: '/other' }]);
    expect(messages.some((m) => m.includes('noindex'))).toBe(true);
    expect(run([{ title: 'T', description: 'D', robots: { index: false } }])).toEqual([]);
  });
});

describe('diagnostics in the Seo service', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function boot(config: SeoSiteConfig): Seo {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideSeo(config)] });
    const seo = TestBed.inject(Seo);
    TestBed.tick();
    return seo;
  }

  it('warns once per path and message', () => {
    const seo = boot(site);
    seo.contribute({ author: 'A' });
    TestBed.tick();
    const titleWarnings = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('title'));
    expect(titleWarnings).toHaveLength(1);
    expect(String(titleWarnings[0][0])).toMatch(/^\[ngx-seo\]/);
  });

  it('is silenced with diagnostics off', () => {
    boot({ ...site, diagnostics: 'off' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn before the initial navigation has supplied page data', async () => {
    @Component({ selector: 'seo-page', template: '' })
    class Page {}
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '', component: Page, resolve: { seo: () => Promise.resolve({ title: 'T', description: 'D' }) } }]),
        provideSeo(site),
      ],
    });
    TestBed.inject(Seo);
    TestBed.tick();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    TestBed.tick();
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks the first hydrated page once the browser takes over', async () => {
    document.head.innerHTML = '<title>Server</title><meta data-seo="meta:name:author" name="author" content="x">';
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideSeo(site)] });
    TestBed.inject(Seo);
    TestBed.tick();
    await TestBed.inject(ApplicationRef).whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    expect(warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('title'))).toBe(true);
  });

  it('survives malformed jsonLd from an untyped layer', () => {
    const seo = boot(site);
    seo.contribute(JSON.parse('{"title":"T","description":"D","jsonLd":[null, "x", {"@id": 1}]}'));
    seo.contribute(JSON.parse('{"jsonLd":{"@type":"Thing"}}'));
    expect(() => TestBed.tick()).not.toThrow();
    expect(document.title).toBe('T');
  });

  it('does not warn about a missing title when an app TitleStrategy owns titles', () => {
    expect(diagnose(resolveHead({ description: 'D' }, site, { path: '/', origin: null }), [], null, { checkTitle: false })).toEqual([]);
  });

  it('waits for the render pass before checking, so nested contributors count', async () => {
    @Component({ selector: 'seo-child', template: '' })
    class Child {
      readonly seo = injectSeo({ title: 'T', description: 'from child' });
    }
    @Component({ selector: 'seo-nested', imports: [Child], template: '@if (show()) { <seo-child /> }' })
    class Nested {
      readonly show = signal(true);
    }
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([{ path: 'p', component: Nested }]), provideSeo(site)],
    });
    TestBed.inject(Seo);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/p');
    TestBed.tick();
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('from child');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once in a routed app about a page without a description', async () => {
    @Component({ selector: 'seo-nodesc', template: '' })
    class NoDescription {}
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: 'p', component: NoDescription, data: { seo: { title: 'T' } } }]),
        provideSeo(site),
      ],
    });
    TestBed.inject(Seo);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/p');
    TestBed.tick();
    TestBed.tick();
    const description = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('No description'));
    expect(description).toHaveLength(1);
    expect(String(description[0][0])).toContain('(/p)');
  });
});

