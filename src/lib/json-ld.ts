import type { JsonLdNode } from './types';

const UNSAFE = /[<>&\u2028\u2029]/g;

function escapeForScript(json: string): string {
  return json.replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Serialises nodes into one schema.org `@graph` document, safe to place in a
 * `<script type="application/ld+json">`. A node that cannot be serialised is
 * dropped and reported through `onError`. Returns null when nothing remains.
 */
export function serializeJsonLd(nodes: readonly JsonLdNode[], onError: (error: unknown) => void): string | null {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') {
      continue;
    }
    const { '@context': _context, ...rest } = node as JsonLdNode & { '@context'?: unknown };
    try {
      parts.push(JSON.stringify(rest));
    } catch (error) {
      onError(error);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return escapeForScript(`{"@context":"https://schema.org","@graph":[${parts.join(',')}]}`);
}
