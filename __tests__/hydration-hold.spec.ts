import { describe, it, expect } from 'vitest';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideSeo } from '../src/lib/provide-seo';
import { SEO_ATTR } from '../src/lib/reconciler';
import { SEO_TAKEOVER_TIMEOUT, Seo } from '../src/lib/seo.service';

@Component({ selector: 'x-p', template: '' })
class P {}

describe('hydration takeover and later removals', () => {
for (const routed of [false, true]) {
  it(`removes a tag a client layer drops before any navigation (routed=${routed})`, async () => {
    document.head.innerHTML = `<title>S</title><meta ${SEO_ATTR}="meta:name:robots" name="robots" content="noindex">`;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SEO_TAKEOVER_TIMEOUT, useValue: 10 },
        ...(routed ? [provideRouter([{ path: '**', component: P }])] : []),
        provideSeo({ baseUrl: 'https://x.test' }),
      ],
    });
    const seo = TestBed.inject(Seo);
    const handle = seo.contribute({ robots: { index: false } });
    if (routed) {
      await TestBed.inject((await import('@angular/router')).Router).navigateByUrl('/');
    }
    await new Promise((r) => setTimeout(r, 40));
    TestBed.tick();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    handle.destroy();
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 10));
    TestBed.tick();
    expect(seo.resolved().robots).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });
}
});
