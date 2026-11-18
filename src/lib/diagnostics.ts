import type { ResolvedHead, SeoConfig } from './types';

function isNoindex(robots: string | null): boolean {
  return robots !== null && /(^|,)\s*(noindex|none)\s*(,|$)/i.test(robots);
}

/**
 * Finds likely mistakes in a page's SEO. Returns human-readable messages;
 * an empty list means nothing looked wrong.
 */
export function diagnose(head: ResolvedHead, layers: readonly SeoConfig[], currentUrl: string | null): string[] {
  const messages: string[] = [];

  if (head.title === null) {
    messages.push('No title is set for this page.');
  }
  if (!head.tags.some((tag) => tag.key === 'meta:name:description')) {
    messages.push('No description is set for this page.');
  }
  for (const field of head.droppedUrls) {
    messages.push(`Dropped ${field}: the URL could not be made absolute or is not http(s).`);
  }
  for (const layer of layers) {
    const seen = new Set<string>();
    for (const node of layer.jsonLd ?? []) {
      const id = '@id' in node ? node['@id'] : undefined;
      if (typeof id !== 'string') {
        continue;
      }
      if (seen.has(id)) {
        messages.push(`Two JSON-LD nodes in one layer share the @id "${id}"; only the last is kept.`);
      }
      seen.add(id);
    }
  }
  if (isNoindex(head.robots) && head.canonical !== null && currentUrl !== null && head.canonical !== currentUrl) {
    messages.push(`This page is noindex but its canonical points elsewhere (${head.canonical}).`);
  }

  return messages;
}
