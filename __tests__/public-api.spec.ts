import { describe, it, expect } from 'vitest';
import * as api from '../src/public-api';

describe('public API', () => {
  it('exports exactly the documented runtime symbols', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'Seo',
        'aggregateOffer',
        'article',
        'blogPosting',
        'breadcrumbList',
        'faqPage',
        'howTo',
        'injectSeo',
        'offer',
        'organization',
        'person',
        'product',
        'provideSeo',
        'qaPage',
        'removeItem',
        'service',
        'speakable',
        'webPage',
        'webSite',
      ].sort(),
    );
  });
});
