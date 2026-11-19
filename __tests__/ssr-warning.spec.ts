// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { Component, REQUEST, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication, type BootstrapContext } from '@angular/platform-browser';
import { provideServerRendering, renderApplication } from '@angular/platform-server';
import { provideSeo } from '../src/lib/provide-seo';
import type { SeoSiteConfig } from '../src/lib/types';

@Component({ selector: 'app-root', template: '<p>x</p>' })
class App {}

function render(site: SeoSiteConfig): Promise<string> {
  const bootstrap = (context: BootstrapContext) =>
    bootstrapApplication(App, { providers: [provideZonelessChangeDetection(), provideServerRendering(), provideSeo(site)] }, context);
  return renderApplication(bootstrap, {
    document: '<html><head><title>x</title></head><body><app-root></app-root></body></html>',
    url: '/',
    platformProviders: [{ provide: REQUEST, useValue: new Request('https://req.test/') }],
  });
}

describe('server baseUrl warning', () => {
  it('warns once per process when baseUrl is not configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render({ baseUrl: 'https://x.test' });
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('baseUrl'))).toHaveLength(0);
    await render({});
    await render({});
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('baseUrl'))).toHaveLength(1);
    warn.mockRestore();
  });
});
