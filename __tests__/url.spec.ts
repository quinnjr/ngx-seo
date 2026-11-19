import { describe, it, expect } from 'vitest';
import { absoluteUrl, canonicalFor } from '../src/lib/url';

describe('absoluteUrl', () => {
  it('resolves a root-relative path against the base', () => {
    expect(absoluteUrl('/a', 'https://x.test')).toBe('https://x.test/a');
  });

  it('passes an absolute http(s) URL through', () => {
    expect(absoluteUrl('https://y.test/b?c=1', 'https://x.test')).toBe('https://y.test/b?c=1');
    expect(absoluteUrl('http://y.test/b', null)).toBe('http://y.test/b');
  });

  it('rejects non-http schemes', () => {
    expect(absoluteUrl('javascript:alert(1)', 'https://x.test')).toBeNull();
    expect(absoluteUrl('data:text/plain,x', 'https://x.test')).toBeNull();
  });

  it('returns null for a relative URL with no base', () => {
    expect(absoluteUrl('/a', null)).toBeNull();
  });

  it('returns null for an unparsable base or value', () => {
    expect(absoluteUrl('/a', 'not a url')).toBeNull();
    expect(absoluteUrl('http://', null)).toBeNull();
  });
});

describe('canonicalFor', () => {
  const base = 'https://x.test';

  it('drops the fragment and every query parameter not kept', () => {
    expect(canonicalFor('/a/?utm=1&page=2#f', base, { trailingSlash: 'never', keepQueryParams: ['page'] })).toBe(
      'https://x.test/a?page=2',
    );
  });

  it('drops the whole query string by default', () => {
    expect(canonicalFor('/a?utm=1', base, { trailingSlash: 'preserve', keepQueryParams: [] })).toBe('https://x.test/a');
  });

  it('adds a trailing slash with always', () => {
    expect(canonicalFor('/a', base, { trailingSlash: 'always', keepQueryParams: [] })).toBe('https://x.test/a/');
  });

  it('preserves the path as given by default', () => {
    expect(canonicalFor('/a/', base, { trailingSlash: 'preserve', keepQueryParams: [] })).toBe('https://x.test/a/');
  });

  it('keeps the root path as a slash', () => {
    expect(canonicalFor('/', base, { trailingSlash: 'never', keepQueryParams: [] })).toBe('https://x.test/');
  });

  it('returns null without a base', () => {
    expect(canonicalFor('/a', null, { trailingSlash: 'preserve', keepQueryParams: [] })).toBeNull();
  });

  it('never lets a path starting with // change the host', () => {
    expect(canonicalFor('//evil.test/foo', base, { trailingSlash: 'preserve', keepQueryParams: [] })).toBe('https://x.test/evil.test/foo');
    expect(canonicalFor('///evil.test', base, { trailingSlash: 'preserve', keepQueryParams: [] })).toBe('https://x.test/evil.test');
  });

  it('keeps query parameters in keepQueryParams order', () => {
    const policy = { trailingSlash: 'preserve' as const, keepQueryParams: ['page', 'sort'] };
    expect(canonicalFor('/list?sort=x&page=2', base, policy)).toBe('https://x.test/list?page=2&sort=x');
    expect(canonicalFor('/list?page=2&sort=x', base, policy)).toBe('https://x.test/list?page=2&sort=x');
  });

  it('keeps kept query parameters exactly as the router wrote them', () => {
    expect(
      canonicalFor('/search?q=red%20shoes&sort=price,asc&at=a@b:c&utm=x', base, {
        trailingSlash: 'preserve',
        keepQueryParams: ['q', 'sort', 'at'],
      }),
    ).toBe('https://x.test/search?q=red%20shoes&sort=price,asc&at=a@b:c');
  });
});
