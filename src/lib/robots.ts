import type { RobotsDirectives } from './types';

type Report = (error: unknown) => void;

const IMAGE_PREVIEWS = new Set(['none', 'standard', 'large']);

function unset(value: unknown): boolean {
  return value === undefined || value === null;
}

function dateText(value: unknown, report: Report): string | null {
  if (unset(value)) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    return value.trim() !== '' ? value : null;
  }
  report(new Error('ngx-seo: ignored robots.unavailableAfter: expected a Date or text'));
  return null;
}

/**
 * Renders robots directives as meta content. Returns null when nothing is set.
 * A directive of the wrong type is reported and skipped.
 */
export function robotsContent(robots: RobotsDirectives | string, report: Report = () => {}): string | null {
  if (typeof robots === 'string') {
    const trimmed = robots.trim();
    return trimmed === '' ? null : trimmed;
  }

  const flag = (name: keyof RobotsDirectives): boolean | undefined => {
    const value: unknown = robots[name];
    if (typeof value === 'boolean') {
      return value;
    }
    if (!unset(value)) {
      report(new Error(`ngx-seo: ignored robots.${name}: expected true or false`));
    }
    return undefined;
  };
  const size = (name: keyof RobotsDirectives): number | undefined => {
    const value: unknown = robots[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (!unset(value)) {
      report(new Error(`ngx-seo: ignored robots.${name}: expected a number`));
    }
    return undefined;
  };

  const parts: string[] = [];
  const index = flag('index');
  if (index !== undefined) {
    parts.push(index ? 'index' : 'noindex');
  }
  const follow = flag('follow');
  if (follow !== undefined) {
    parts.push(follow ? 'follow' : 'nofollow');
  }
  for (const name of ['noarchive', 'nosnippet', 'noimageindex', 'notranslate'] as const) {
    if (flag(name) === true) {
      parts.push(name);
    }
  }
  const maxSnippet = size('maxSnippet');
  if (maxSnippet !== undefined) {
    parts.push(`max-snippet:${maxSnippet}`);
  }
  const preview: unknown = robots.maxImagePreview;
  if (typeof preview === 'string' && IMAGE_PREVIEWS.has(preview)) {
    parts.push(`max-image-preview:${preview}`);
  } else if (!unset(preview) && preview !== '') {
    report(new Error("ngx-seo: ignored robots.maxImagePreview: expected 'none', 'standard' or 'large'"));
  }
  const maxVideoPreview = size('maxVideoPreview');
  if (maxVideoPreview !== undefined) {
    parts.push(`max-video-preview:${maxVideoPreview}`);
  }
  const unavailableAfter = dateText(robots.unavailableAfter, report);
  if (unavailableAfter !== null) {
    parts.push(`unavailable_after:${unavailableAfter}`);
  }

  return parts.length === 0 ? null : parts.join(', ');
}
