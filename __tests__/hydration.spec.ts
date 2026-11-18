import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApplicationRef,
  Component,
  PendingTasks,
  inject,
  provideEnvironmentInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { provideSeo } from '../src/lib/provide-seo';
import { SEO_ATTR } from '../src/lib/reconciler';
import { Seo } from '../src/lib/seo.service';
import type { SeoConfig } from '../src/lib/types';

@Component({ selector: 'seo-page', template: '' })
class Page {}

describe('hydration', () => {
  beforeEach(() => {
    document.head.innerHTML =
      '<title>Server</title>' +
      `<meta ${SEO_ATTR}="meta:name:description" name="description" content="server">` +
      `<meta ${SEO_ATTR}="meta:name:author" name="author" content="server">`;
  });

  it('leaves server-rendered tags alone until the app is stable, then reconciles once', async () => {
    let done: () => void = () => {};
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideEnvironmentInitializer(() => {
          done = inject(PendingTasks).add();
        }),
        provideSeo({ baseUrl: 'https://x.test' }),
      ],
    });
    const seo = TestBed.inject(Seo);
    TestBed.tick();
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('server');

    seo.contribute({ description: 'client', author: 'client' });
    TestBed.tick();
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('server');

    done();
    await TestBed.inject(ApplicationRef).whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();

    const authors = document.head.querySelectorAll('meta[name="author"]');
    expect(authors).toHaveLength(1);
    expect(authors[0].getAttribute('content')).toBe('client');
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.title).not.toBe('');
  });

  it('reconciles immediately when nothing was server-rendered', () => {
    document.head.innerHTML = '<title>Plain</title>';
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideSeo({ baseUrl: 'https://x.test' })] });
    TestBed.inject(Seo).contribute({ author: 'now' });
    TestBed.tick();
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('now');
  });

  it('waits for the initial navigation before taking over', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '', component: Page, resolve: { seo: () => gate.then((): SeoConfig => ({ author: 'routed' })) } }]),
        provideSeo({ baseUrl: 'https://x.test' }),
      ],
    });
    TestBed.inject(Seo);
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('server');

    const navigation = TestBed.inject(Router).navigateByUrl('/');
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    expect(document.head.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('server');

    release();
    await navigation;
    await TestBed.inject(ApplicationRef).whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    const authors = document.head.querySelectorAll('meta[name="author"]');
    expect(authors).toHaveLength(1);
    expect(authors[0].getAttribute('content')).toBe('routed');
  });
});
