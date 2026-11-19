import { describe, it, expect } from 'vitest';
import type { ActivatedRouteSnapshot } from '@angular/router';
import type { BlogPosting, Organization, Thing, WithContext } from 'schema-dts';
import type { RouteSeo, SeoConfig, SeoHandle, SeoMetaTag } from '../src/lib/types';
import { breadcrumbList, faqPage, howTo, type BreadcrumbItem, type FaqItem } from '../src/lib/builders';

describe('public types', () => {
  it('accepts a route function typed with ActivatedRouteSnapshot', () => {
    const seo: RouteSeo = (route: ActivatedRouteSnapshot) => ({ title: route.paramMap.get('id') ?? '' });
    expect(typeof seo).toBe('function');
  });

  it('requires a meta tag to name what it describes', () => {
    // @ts-expect-error a meta tag needs name, property or httpEquiv
    const bad: SeoMetaTag = { content: 'x' };
    // @ts-expect-error a meta tag cannot be both a name and a property
    const both: SeoMetaTag = { name: 'a', property: 'b', content: 'x' };
    const good: SeoMetaTag[] = [{ name: 'a', content: 'x' }, { property: 'og:x', content: 'y' }, { httpEquiv: 'refresh', content: '5' }];
    expect([bad, both, good].length).toBe(3);
  });

  it('accepts schema-dts nodes', () => {
    const org: Organization = { '@type': 'Organization', name: 'Acme' };
    const post: WithContext<BlogPosting> = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'H' };
    const thing: Thing = { '@type': 'Thing', name: 'x' };
    const config: SeoConfig = { jsonLd: [org, post, thing] };
    expect(config.jsonLd).toHaveLength(3);
  });

  it('lets a handle switch to a reactive config', () => {
    const handle: SeoHandle = { set: () => {}, patch: () => {}, clear: () => {}, destroy: () => {} };
    handle.set(() => ({ title: 'reactive' }));
    expect(typeof handle.set).toBe('function');
  });

  it('accepts readonly arrays everywhere a list is taken', () => {
    const keywords: readonly string[] = ['a'];
    const items: readonly FaqItem[] = [{ question: 'Q', answer: 'A' }];
    const crumbs: readonly BreadcrumbItem[] = [{ name: 'Home', url: '/' }];
    const config: SeoConfig = {
      keywords,
      alternates: [{ hreflang: 'fr', href: '/fr' }] as const,
      openGraph: { alternateLocales: ['fr_FR'] as const, article: { tags: ['x'] as const, authors: ['a'] as const } },
      jsonLd: [faqPage(items), breadcrumbList(crumbs), howTo({ name: 'H', steps: ['s'] as const, supply: ['p'] as const })],
    };
    expect(config.keywords).toBe(keywords);
  });
});

