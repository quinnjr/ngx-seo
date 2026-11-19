import { describe, it, expect, vi } from 'vitest';
import { serializeJsonLd } from '../src/lib/json-ld';
import type { JsonLdNode } from '../src/lib/types';

describe('serializeJsonLd', () => {
  it('wraps nodes in a schema.org graph', () => {
    const out = serializeJsonLd([{ '@type': 'Thing', name: 'a' }], () => {});
    expect(JSON.parse(out as string)).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Thing', name: 'a' }],
    });
  });

  it('escapes characters that could close the script element', () => {
    const name = '</script><script>alert(1)</script>&\u2028\u2029';
    const out = serializeJsonLd([{ '@type': 'Thing', name }], () => {}) as string;
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)['@graph'][0].name).toBe(name);
  });

  it('drops a node that cannot be serialised and keeps the rest', () => {
    const cyclic: JsonLdNode = { '@type': 'Thing' };
    cyclic['self'] = cyclic;
    const onError = vi.fn();
    const out = serializeJsonLd([cyclic, { '@type': 'Kept' }, { '@type': 'Big', n: BigInt(1) }], onError);
    expect(JSON.parse(out as string)['@graph']).toEqual([{ '@type': 'Kept' }]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('returns null when there is nothing to render', () => {
    expect(serializeJsonLd([], () => {})).toBeNull();
  });

  it('serialises dates as ISO 8601 and drops undefined properties', () => {
    const out = serializeJsonLd([{ '@type': 'Event', startDate: new Date('2027-01-01T00:00:00Z'), gone: undefined }], () => {});
    expect(JSON.parse(out as string)['@graph'][0]).toEqual({ '@type': 'Event', startDate: '2027-01-01T00:00:00.000Z' });
  });

  it('strips a per-node @context', () => {
    const out = serializeJsonLd([{ '@context': 'https://schema.org', '@type': 'Thing' }], () => {});
    expect(JSON.parse(out as string)['@graph'][0]).toEqual({ '@type': 'Thing' });
  });
});
