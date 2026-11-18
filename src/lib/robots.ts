import type { RobotsDirectives } from './types';

function dateText(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Renders robots directives as meta content. Returns null when nothing is set. */
export function robotsContent(robots: RobotsDirectives | string): string | null {
  if (typeof robots === 'string') {
    const trimmed = robots.trim();
    return trimmed === '' ? null : trimmed;
  }

  const parts: string[] = [];
  if (typeof robots.index === 'boolean') {
    parts.push(robots.index ? 'index' : 'noindex');
  }
  if (typeof robots.follow === 'boolean') {
    parts.push(robots.follow ? 'follow' : 'nofollow');
  }
  for (const flag of ['noarchive', 'nosnippet', 'noimageindex', 'notranslate'] as const) {
    if (robots[flag] === true) {
      parts.push(flag);
    }
  }
  if (typeof robots.maxSnippet === 'number') {
    parts.push(`max-snippet:${robots.maxSnippet}`);
  }
  if (robots.maxImagePreview) {
    parts.push(`max-image-preview:${robots.maxImagePreview}`);
  }
  if (typeof robots.maxVideoPreview === 'number') {
    parts.push(`max-video-preview:${robots.maxVideoPreview}`);
  }
  if (robots.unavailableAfter) {
    parts.push(`unavailable_after:${dateText(robots.unavailableAfter)}`);
  }

  return parts.length === 0 ? null : parts.join(', ');
}
