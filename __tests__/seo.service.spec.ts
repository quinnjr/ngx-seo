import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Component,
  DestroyRef,
  EnvironmentInjector,
  ErrorHandler,
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideSeo } from '../src/lib/provide-seo';
import { Seo } from '../src/lib/seo.service';
import { injectSeo } from '../src/lib/inject-seo';
import type { SeoSiteConfig } from '../src/lib/types';

function meta(name: string): string | null {
  return document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
}

function setup(site: SeoSiteConfig = { siteName: 'Site', baseUrl: 'https://x.test', defaults: { description: 'Default' } }) {
  const errors = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideSeo(site),
      { provide: ErrorHandler, useValue: { handleError: errors } },
    ],
  });
  const seo = TestBed.inject(Seo);
  TestBed.tick();
  return { seo, errors };
}

describe('Seo', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
    history.replaceState(null, '', '/');
  });

  it('renders defaults into the document head', () => {
    setup();
    expect(meta('description')).toBe('Default');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://x.test/');
  });

  it('lets a contribution override defaults, and clear restores them', () => {
    const { seo } = setup();
    const handle = seo.contribute({ description: 'Mine' });
    TestBed.tick();
    expect(meta('description')).toBe('Mine');
    handle.clear();
    TestBed.tick();
    expect(meta('description')).toBe('Default');
  });

  it('patches into the handle config and set replaces it', () => {
    const { seo } = setup();
    const handle = seo.contribute({ title: 'T', description: 'D' });
    handle.patch({ description: 'P' });
    TestBed.tick();
    expect(document.title).toBe('T');
    expect(meta('description')).toBe('P');
    handle.set({ author: 'A' });
    TestBed.tick();
    expect(meta('description')).toBe('Default');
    expect(meta('author')).toBe('A');
  });

  it('removes a lower value when a contribution sets null', () => {
    const { seo } = setup();
    seo.contribute({ description: null });
    TestBed.tick();
    expect(meta('description')).toBeNull();
  });

  it('re-evaluates a function contribution when a signal it reads changes', () => {
    const { seo } = setup();
    const title = signal('One');
    seo.contribute(() => ({ title: title() }));
    TestBed.tick();
    expect(document.title).toBe('One');
    title.set('Two');
    TestBed.tick();
    expect(document.title).toBe('Two');
  });

  it('orders contributions by priority, then creation', () => {
    const { seo } = setup();
    seo.contribute({ author: 'high' }, { priority: 10 });
    seo.contribute({ author: 'low' });
    seo.contribute({ keywords: 'first' });
    seo.contribute({ keywords: 'second' });
    TestBed.tick();
    expect(meta('author')).toBe('high');
    expect(meta('keywords')).toBe('second');
  });

  it('ignores handle calls after destroy', () => {
    const { seo } = setup();
    const handle = seo.contribute({ author: 'A' });
    handle.destroy();
    handle.set({ author: 'B' });
    handle.patch({ author: 'C' });
    handle.clear();
    TestBed.tick();
    expect(meta('author')).toBeNull();
  });

  it('derives the canonical from the document location without a router', () => {
    history.replaceState(null, '', '/about?utm=1');
    setup();
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://x.test/about');
  });

  it('uses the window origin when there is no baseUrl', () => {
    setup({});
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`${location.origin}/`);
  });

  it('skips a contribution that throws and reports it', () => {
    const { seo, errors } = setup();
    seo.contribute({ author: 'A' });
    seo.contribute(() => {
      throw new Error('boom');
    });
    TestBed.tick();
    expect(meta('author')).toBe('A');
    expect(errors).toHaveBeenCalled();
  });

  it('passes the page title and canonical to function defaults', () => {
    const defaults = vi.fn((ctx: { title: string | null; canonical: string | null }) => ({
      description: `About ${ctx.title} at ${ctx.canonical}`,
    }));
    const { seo } = setup({ baseUrl: 'https://x.test', defaults });
    seo.contribute({ title: 'Pricing' });
    TestBed.tick();
    expect(meta('description')).toBe('About Pricing at https://x.test/');
  });

  it('reports and skips function defaults that throw', () => {
    const { seo, errors } = setup({
      baseUrl: 'https://x.test',
      defaults: () => {
        throw new Error('bad defaults');
      },
    });
    seo.contribute({ author: 'A' });
    TestBed.tick();
    expect(meta('author')).toBe('A');
    expect(errors).toHaveBeenCalled();
  });

  it('exposes the resolved head as a signal', () => {
    const { seo } = setup();
    seo.contribute({ title: 'T' });
    expect(seo.resolved().title).toBe('T');
  });

  it('keeps the previous head when the DOM throws', () => {
    const { seo, errors } = setup();
    const spy = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('dom');
    });
    seo.contribute({ author: 'A' });
    TestBed.tick();
    spy.mockRestore();
    expect(errors).toHaveBeenCalled();
    expect(meta('description')).toBe('Default');
  });
});

describe('injectSeo', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
  });

  @Component({ selector: 'seo-host', template: '' })
  class Host {
    readonly handle = injectSeo({ author: 'Host' });
  }

  it('adds a contribution for the life of the component', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideSeo({ baseUrl: 'https://x.test' })] });
    const fixture = TestBed.createComponent(Host);
    TestBed.tick();
    expect(meta('author')).toBe('Host');
    fixture.destroy();
    TestBed.tick();
    expect(meta('author')).toBeNull();
  });

  it('works without provideSeo', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    TestBed.createComponent(Host);
    TestBed.tick();
    expect(meta('author')).toBe('Host');
  });

  it('throws outside an injection context', () => {
    expect(() => injectSeo({})).toThrow();
  });
});

describe('Seo error containment', () => {
  beforeEach(() => {
    document.head.innerHTML = '<title>Initial</title>';
  });

  function boot(site: SeoSiteConfig = { baseUrl: 'https://x.test' }) {
    const errors = vi.fn();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideSeo(site), { provide: ErrorHandler, useValue: { handleError: errors } }],
    });
    const seo = TestBed.inject(Seo);
    TestBed.tick();
    return { seo, errors };
  }

  it('drops only a cyclic JSON-LD node and renders the rest of the head', () => {
    const { seo, errors } = boot();
    const cyclic: Record<string, unknown> = { '@type': 'Thing' };
    cyclic['self'] = cyclic;
    seo.contribute({ description: 'D', jsonLd: [cyclic as never, { '@type': 'Ok' }] });
    TestBed.tick();
    expect(meta('description')).toBe('D');
    const text = document.head.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    expect(JSON.parse(text)['@graph']).toEqual([{ '@type': 'Ok' }]);
    expect(errors).toHaveBeenCalled();
  });

  it('falls back to the untemplated title when the template throws', () => {
    const { seo, errors } = boot({
      baseUrl: 'https://x.test',
      titleTemplate: () => {
        throw new Error('bad template');
      },
    });
    seo.contribute({ title: 'T', description: 'D' });
    TestBed.tick();
    expect(document.title).toBe('T');
    expect(meta('description')).toBe('D');
    expect(errors).toHaveBeenCalled();
  });

  it('ignores a contribution whose destroyRef is already destroyed', () => {
    const { seo } = boot();
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    const destroyRef = injector.get(DestroyRef);
    injector.destroy();
    const handle = seo.contribute({ author: 'Leaked' }, { destroyRef });
    handle.set({ author: 'Still leaked' });
    TestBed.tick();
    expect(meta('author')).toBeNull();
  });

  it('ignores handle calls after the owning destroyRef fires', () => {
    const { seo } = boot();
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    const handle = seo.contribute({ author: 'A' }, { destroyRef: injector.get(DestroyRef) });
    TestBed.tick();
    expect(meta('author')).toBe('A');
    injector.destroy();
    handle.set({ author: 'B' });
    TestBed.tick();
    expect(meta('author')).toBeNull();
  });
});
