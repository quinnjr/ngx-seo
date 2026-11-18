import { describe, it, expect } from 'vitest';
import { robotsContent } from '../src/lib/robots';

describe('robotsContent', () => {
  it('renders directives in a stable order', () => {
    expect(robotsContent({ index: false, follow: true, maxSnippet: -1, maxImagePreview: 'large' })).toBe(
      'noindex, follow, max-snippet:-1, max-image-preview:large',
    );
  });

  it('renders the boolean-only directives when true', () => {
    expect(
      robotsContent({ noarchive: true, nosnippet: true, noimageindex: true, notranslate: true, maxVideoPreview: 0 }),
    ).toBe('noarchive, nosnippet, noimageindex, notranslate, max-video-preview:0');
  });

  it('omits boolean-only directives when false', () => {
    expect(robotsContent({ noarchive: false, index: true })).toBe('index');
  });

  it('returns null when nothing is set', () => {
    expect(robotsContent({})).toBeNull();
    expect(robotsContent('   ')).toBeNull();
  });

  it('passes a raw string through, trimmed', () => {
    expect(robotsContent(' noindex, nofollow ')).toBe('noindex, nofollow');
  });

  it('renders unavailableAfter as ISO 8601', () => {
    expect(robotsContent({ unavailableAfter: new Date('2027-01-01T00:00:00Z') })).toBe(
      'unavailable_after:2027-01-01T00:00:00.000Z',
    );
    expect(robotsContent({ unavailableAfter: '2027-01-01' })).toBe('unavailable_after:2027-01-01');
  });
});
